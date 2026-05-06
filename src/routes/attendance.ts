import { DateTime } from "luxon";
import { Router, Response } from "express";
import { verifyJWT, AuthRequest } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { assertOnSite, getSiteSettings, getEmployeeWorksite, distanceFeet } from "../services/geofence";
import {
  getEmployeeStatus,
  getOrCreateSession,
  recordPunch,
  getEffectiveSchedule,
  getLastPunch,
  getSessionData,
  computeRegularOvertime,
  updateSessionSummary,
} from "../services/attendance";
import { db } from "../db/pool";

const router = Router();

// ─── CLOCK IN ─────────────────────────────────────────────────────────────────
router.post(
  "/clock-in",
  verifyJWT,
  auditLog("clock_in", "attendance_sessions"),
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.user!.id;

      // Prevent re-clock-in if already completed today
      const { rows: completed } = await db.query(
        `SELECT id FROM attendance_sessions
         WHERE user_id = $1 AND work_date = CURRENT_DATE AND status = 'completed'`,
        [userId]
      );
      if (completed.length > 0) {
        res.status(409).json({ error: "You have already clocked out today. Cannot clock in again." });
        return;
      }

      // ── Missed session guard ──────────────────────────────────────────────
      // Block on-site employees from clocking in when auto-clock-out is OFF
      // and they still have an unresolved active session from a previous day.
      const settings = await getSiteSettings();
      if (!settings.auto_clock_out_enabled) {
        const { rows: missed } = await db.query(
          `SELECT id FROM attendance_sessions
           WHERE user_id = $1 AND status = 'active' AND work_date < CURRENT_DATE`,
          [userId]
        );
        if (missed.length > 0) {
          const { rows: emp } = await db.query(
            `SELECT work_mode FROM users WHERE id = $1`,
            [userId]
          );
          if ((emp[0]?.work_mode || "onsite") !== "offsite") {
            res.status(409).json({
              error: "You have an unresolved clock-out from a previous day. Please enter your missing clock-out time first.",
              code: "MISSED_CLOCK_OUT",
            });
            return;
          }
        }
      }

      // siteId: the specific job site the employee selected in the dropdown.
      // Passing it to assertOnSite fixes the multi-site mismatch bug where the
      // backend always validated against the employee's *default* site.
      const { latitude, longitude, photo, forceOutside, estimatedMinutes, remarks, siteId } = req.body;

      // Enforce geofence for on-site clock-in unless employee confirmed off-site
      if (!forceOutside) {
        await assertOnSite(userId, latitude, longitude, siteId ?? null);
      }

      const session = await getOrCreateSession(userId);

      // Persist off-site flag + estimate on the session row
      if (forceOutside) {
        await db.query(
          `UPDATE attendance_sessions
           SET is_outside_geofence = true, estimated_minutes = $1
           WHERE id = $2`,
          [estimatedMinutes ?? null, session.id]
        );
      }

      await recordPunch(userId, session.id, "clock_in", {
        lat: latitude,
        lon: longitude,
        source: "manual",
        remarks: remarks || "",
        photoData: photo,
      });

      const data = await getSessionData(userId);
      res.json({ message: "Clocked in successfully", data });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message || "Server error" });
    }
  }
);

// ─── CLOCK OUT ────────────────────────────────────────────────────────────────
// No geofence check — employees may clock out from anywhere (on-site or off-site).
router.post(
  "/clock-out",
  verifyJWT,
  auditLog("clock_out", "attendance_sessions"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { latitude, longitude } = req.body;
      const session = await getOrCreateSession(req.user!.id);
      await recordPunch(req.user!.id, session.id, "clock_out", {
        lat: latitude,
        lon: longitude,
        source: "manual",
      });
      const data = await getSessionData(req.user!.id);
      res.json({ message: "Clocked out successfully", data });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message || "Server error" });
    }
  }
);

// ─── CLOCK OUT — PREVIOUS DAY (retroactive missed clock-out entry) ─────────────
router.post(
  "/clock-out-previous",
  verifyJWT,
  async (req: AuthRequest, res: Response) => {
    try {
      const { sessionId, clockOutTime } = req.body;

      if (!sessionId || !clockOutTime) {
        res.status(400).json({ error: "sessionId and clockOutTime are required." });
        return;
      }

      // Validate session belongs to this employee and is still active
      const { rows } = await db.query(
        `SELECT * FROM attendance_sessions WHERE id = $1 AND user_id = $2`,
        [sessionId, req.user!.id]
      );
      if (rows.length === 0) {
        res.status(404).json({ error: "Session not found." });
        return;
      }
      const session = rows[0];
      if (session.status === "completed") {
        res.status(409).json({ error: "Session is already completed." });
        return;
      }

      const clockOut = new Date(clockOutTime);
      const clockIn  = new Date(session.clock_in_time);
      if (isNaN(clockOut.getTime()) || clockOut <= clockIn) {
        res.status(400).json({ error: "Clock-out time must be after the clock-in time." });
        return;
      }

      // Insert a retroactive punch record with the employee-supplied timestamp
      await db.query(
        `INSERT INTO punch_records
           (user_id, session_id, punch_type, latitude, longitude, source, remarks, punch_time)
         VALUES ($1, $2, 'clock_out', NULL, NULL, 'manual',
                 'Retroactive clock-out entered by employee', $3)`,
        [req.user!.id, sessionId, clockOut.toISOString()]
      );

      // Recalculate session summary (worked_minutes, overtime, etc.)
      await updateSessionSummary(sessionId);

      res.json({ message: "Clock-out recorded. Session closed." });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message || "Server error" });
    }
  }
);

// ─── BREAK START (personal) ───────────────────────────────────────────────────
// No geofence check — breaks allowed anywhere.
router.post(
  "/break-start",
  verifyJWT,
  auditLog("break_start", "attendance_sessions"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { latitude, longitude, reason } = req.body;
      const session = await getOrCreateSession(req.user!.id);
      await recordPunch(req.user!.id, session.id, "break_start", {
        lat: latitude,
        lon: longitude,
        source: "manual",
        remarks: reason || "Personal break",
        breakType: "personal",
      });
      const data = await getSessionData(req.user!.id);
      res.json({ message: "Personal break started.", data });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message || "Server error" });
    }
  }
);

// ─── CUSTOM BREAK START (work-related) ────────────────────────────────────────
router.post(
  "/custom-break-start",
  verifyJWT,
  auditLog("break_start", "attendance_sessions"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { latitude, longitude, reason } = req.body;
      if (!reason?.trim()) {
        res.status(400).json({ error: "Break reason is required." });
        return;
      }
      const session = await getOrCreateSession(req.user!.id);
      await recordPunch(req.user!.id, session.id, "break_start", {
        lat: latitude,
        lon: longitude,
        source: "manual",
        remarks: reason,
        breakType: "work",
      });
      const data = await getSessionData(req.user!.id);
      res.json({ message: "Work-related break started", data });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message || "Server error" });
    }
  }
);

// ─── BREAK END ────────────────────────────────────────────────────────────────
// No geofence check — employees may end breaks from anywhere.
router.post(
  "/break-end",
  verifyJWT,
  auditLog("break_end", "attendance_sessions"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { latitude, longitude } = req.body;
      const session = await getOrCreateSession(req.user!.id);
      await recordPunch(req.user!.id, session.id, "break_end", {
        lat: latitude,
        lon: longitude,
        source: "manual",
      });
      const data = await getSessionData(req.user!.id);
      res.json({ message: "Break ended", data });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message || "Server error" });
    }
  }
);

// ─── HEARTBEAT ────────────────────────────────────────────────────────────────
router.post(
  "/heartbeat",
  verifyJWT,
  async (req: AuthRequest, res: Response) => {
    try {
      const { latitude, longitude } = req.body;
      const settings = await getSiteSettings();
      // Bug fix: use the employee's assigned worksite for geofence checks, not the
      // global site_settings coordinates (which always pointed at the company's
      // primary/default location regardless of which site the employee selected).
      const empSite = await getEmployeeWorksite(req.user!.id);
      const site = empSite || settings;
      const dist = distanceFeet(latitude, longitude, site.latitude, site.longitude);
      const onSite = dist <= (site.radius_feet ?? settings.radius_feet);
      let status = await getEmployeeStatus(req.user!.id);
      const session = await getOrCreateSession(req.user!.id);

      // Auto start personal break when leaving geofence (setting-gated)
      if (!onSite && status === "clocked_in" && settings.auto_break_on_exit_enabled) {
        await recordPunch(req.user!.id, session.id, "break_start", {
          lat: latitude, lon: longitude, source: "auto",
          remarks: "Auto break — left geofence",
          breakType: "personal",
        });
        status = await getEmployeeStatus(req.user!.id);
      }

      // Auto end personal break when re-entering geofence
      if (onSite && status === "on_break") {
        const lastPunch = await getLastPunch(req.user!.id, session.id);
        if (lastPunch?.break_type === "personal") {
          await recordPunch(req.user!.id, session.id, "break_end", {
            lat: latitude, lon: longitude, source: "auto",
            remarks: "Auto break end — re-entered geofence",
          });
          status = await getEmployeeStatus(req.user!.id);
        }
      }

      // ── Auto clock-out ─────────────────────────────────────────────────────
      // Conditions (ALL must be true):
      //   1. auto_clock_out_enabled = true
      //   2. Employee is clocked_in (not on_break)
      //   3. Session has no clock_out_time
      //   4. Current local time is past scheduled shift end
      //   5. Employee is currently outside the geofence
      // Does NOT apply to off-site (warning) clock-in sessions.
      const autoClockOutEnabled = settings.auto_clock_out_enabled ?? true;

      if (
        autoClockOutEnabled &&
        status === "clocked_in" &&
        session &&
        !session.clock_out_time &&
        !session.is_outside_geofence   // skip for off-site sessions
      ) {
        const schedule = await getEffectiveSchedule(req.user!.id);

        // Use employee timezone from JWT — server runs UTC on Railway
        const userTz = req.user!.timezone || "America/New_York";
        const nowLocal = DateTime.now().setZone(userTz);

        const [endH, endM] = schedule.end.split(":").map(Number);
        let scheduledEnd = nowLocal.set({ hour: endH, minute: endM, second: 0, millisecond: 0 });

        // Night shift: push end to following calendar day
        if (schedule.crossesMidnight) {
          scheduledEnd = scheduledEnd.plus({ days: 1 });
        }

        if (nowLocal > scheduledEnd && !onSite) {
          await recordPunch(req.user!.id, session.id, "clock_out", {
            lat: latitude, lon: longitude, source: "auto",
            remarks: "Auto clock-out — shift ended and off-site",
          });
          status = await getEmployeeStatus(req.user!.id);
        }
      }

      res.json({ onSite, distanceFt: Math.round(dist), status });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message || "Server error" });
    }
  }
);

// ─── TODAY'S DATA (includes missed session from previous days) ─────────────────
router.get("/me/today", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const data = await getSessionData(req.user!.id);

    // Return any active session from a prior day (forgotten clock-out)
    const { rows: missedRows } = await db.query(
      `SELECT * FROM attendance_sessions
       WHERE user_id = $1
         AND status   = 'active'
         AND work_date < CURRENT_DATE
       ORDER BY work_date DESC
       LIMIT 1`,
      [req.user!.id]
    );

    res.json({ ...data, missedSession: missedRows[0] || null });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── ATTENDANCE SUMMARY ───────────────────────────────────────────────────────
router.get("/me/summary", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await db.query(
      `SELECT
         COUNT(*) as total_sessions,
         COALESCE(SUM(worked_minutes), 0) as total_minutes,
         COALESCE(AVG(worked_minutes), 0) as avg_daily_minutes,
         COALESCE(SUM(CASE WHEN work_date >= CURRENT_DATE - 6 THEN worked_minutes ELSE 0 END), 0) as week_minutes
       FROM attendance_sessions
       WHERE user_id = $1`,
      [req.user!.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── HISTORY (last 30 sessions with overtime split) ───────────────────────────
router.get("/me", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const { rows: sessions } = await db.query(
      `SELECT * FROM attendance_sessions
       WHERE user_id = $1
       ORDER BY work_date DESC LIMIT 30`,
      [req.user!.id]
    );

    const schedule = await getEffectiveSchedule(req.user!.id);
    const userTz = req.user!.timezone || "America/New_York";

    const enhancedSessions = sessions.map((session) => {
      let regular = 0, overtime = 0;
      if (session.clock_in_time) {
        const { regular: reg, overtime: ov } = computeRegularOvertime(
          new Date(session.clock_in_time),
          session.clock_out_time ? new Date(session.clock_out_time) : null,
          session.break_minutes || 0,
          schedule,
          userTz
        );
        regular = reg;
        overtime = ov;
      }
      return { ...session, regular_minutes: regular, overtime_minutes: overtime };
    });

    res.json(enhancedSessions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── OVERTIME CHECK ───────────────────────────────────────────────────────────
router.get("/:id/overtime", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const today = new Date().toISOString().slice(0, 10);
    const { rows } = await db.query(
      `SELECT overtime_minutes FROM attendance_sessions
       WHERE user_id = $1 AND work_date = $2 AND status = 'active'`,
      [id, today]
    );
    const overtimeMins = rows[0]?.overtime_minutes || 0;
    res.json({ isOvertime: overtimeMins > 0, overtimeMins });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ─── BREAK — MARK COMPLETE ────────────────────────────────────────────────────
router.put("/break/:punchId/complete", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const { punchId } = req.params;
    const { rows } = await db.query("SELECT user_id FROM punch_records WHERE id = $1", [punchId]);
    if (rows.length === 0) { res.status(404).json({ error: "Break not found" }); return; }
    if (rows[0].user_id !== req.user!.id) { res.status(403).json({ error: "Unauthorized" }); return; }
    await db.query("UPDATE punch_records SET break_completed = true WHERE id = $1", [punchId]);
    const data = await getSessionData(req.user!.id);
    res.json({ message: "Break marked as completed", data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── BREAK — MARK INCOMPLETE ──────────────────────────────────────────────────
router.put("/break/:punchId/not-complete", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const { punchId } = req.params;
    const { reason } = req.body;
    if (!reason?.trim()) { res.status(400).json({ error: "Reason is required." }); return; }
    const { rows } = await db.query("SELECT user_id FROM punch_records WHERE id = $1", [punchId]);
    if (rows.length === 0) { res.status(404).json({ error: "Break not found" }); return; }
    if (rows[0].user_id !== req.user!.id) { res.status(403).json({ error: "Unauthorized" }); return; }
    await db.query(
      "UPDATE punch_records SET break_completed = false, break_incomplete_reason = $1 WHERE id = $2",
      [reason, punchId]
    );
    const data = await getSessionData(req.user!.id);
    res.json({ message: "Break marked as not completed", data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── SESSION PUNCHES ──────────────────────────────────────────────────────────
router.get("/session/:sessionId/punches", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { rows: sessionRows } = await db.query(
      "SELECT user_id FROM attendance_sessions WHERE id = $1", [sessionId]
    );
    if (sessionRows.length === 0) { res.status(404).json({ error: "Session not found" }); return; }
    if (sessionRows[0].user_id !== req.user!.id) { res.status(403).json({ error: "Unauthorized" }); return; }
    const { rows: punches } = await db.query(
      "SELECT * FROM punch_records WHERE session_id = $1 ORDER BY punch_time ASC", [sessionId]
    );
    res.json(punches);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;