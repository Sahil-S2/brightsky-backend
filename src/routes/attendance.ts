import { Router, Response } from "express";
import { verifyJWT, AuthRequest } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { assertOnSite, getSiteSettings } from "../services/geofence";
import {
  getEmployeeStatus,
  getOrCreateSession,
  recordPunch,
  getEffectiveSchedule,
  getLastPunch,
  getSessionData,
  computeRegularOvertime, // 👈 new import
} from "../services/attendance";
import { db } from "../db/pool";

const router = Router();

router.post(
  "/clock-in",
  verifyJWT,
  auditLog("clock_in", "attendance_sessions"),
  async (req: AuthRequest, res: Response) => {
    try {
      // Check if already clocked out today
      const { rows: completed } = await db.query(
        `SELECT id FROM attendance_sessions 
         WHERE user_id = $1 AND work_date = CURRENT_DATE AND status = 'completed'`,
        [req.user!.id]
      );
      if (completed.length > 0) {
        res.status(409).json({ error: "You have already clocked out today. Cannot clock in again." });
        return;
      }

      const { latitude, longitude, photo } = req.body;
      await assertOnSite(req.user!.id, latitude, longitude);
      const session = await getOrCreateSession(req.user!.id);
      await recordPunch(req.user!.id, session.id, "clock_in", {
        lat: latitude,
        lon: longitude,
        source: "manual",
        remarks: "",
        photoData: photo,
      });
      const data = await getSessionData(req.user!.id);
      res.json({ message: "Clocked in successfully", data });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message || "Server error" });
    }
  }
);

router.post(
  "/clock-out",
  verifyJWT,
  auditLog("clock_out", "attendance_sessions"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { latitude, longitude } = req.body;
      await assertOnSite(req.user!.id, latitude, longitude);
      const session = await getOrCreateSession(req.user!.id);
      await recordPunch(req.user!.id, session.id, "clock_out", {
        lat: latitude, lon: longitude, source: "manual",
      });
      const data = await getSessionData(req.user!.id);
      res.json({ message: "Clocked out successfully", data });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message || "Server error" });
    }
  }
);

router.post(
  "/break-start",
  verifyJWT,
  auditLog("break_start", "attendance_sessions"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { latitude, longitude, reason } = req.body;
      // No on‑site check – personal break allowed anywhere
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

router.post(
  "/break-end",
  verifyJWT,
  auditLog("break_end", "attendance_sessions"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { latitude, longitude } = req.body;
      await assertOnSite(req.user!.id, latitude, longitude);
      const session = await getOrCreateSession(req.user!.id);
      await recordPunch(req.user!.id, session.id, "break_end", {
        lat: latitude, lon: longitude, source: "manual",
      });
      const data = await getSessionData(req.user!.id);
      res.json({ message: "Break ended", data });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message || "Server error" });
    }
  }
);

router.post(
  "/heartbeat",
  verifyJWT,
  async (req: AuthRequest, res: Response) => {
    try {
      const { latitude, longitude } = req.body;
      const settings = await getSiteSettings();
      const { distanceFeet } = await import("../services/geofence");
      const dist = distanceFeet(latitude, longitude, settings.latitude, settings.longitude);
      const onSite = dist <= settings.radius_feet;
      let status = await getEmployeeStatus(req.user!.id);
      const session = await getOrCreateSession(req.user!.id);

      // Auto start personal break when leaving geofence
      if (!onSite && status === "clocked_in" && settings.auto_break_on_exit_enabled) {
        await recordPunch(req.user!.id, session.id, "break_start", {
          lat: latitude, lon: longitude, source: "auto",
          remarks: "Auto break — left geofence",
          breakType: "personal",
        });
        status = await getEmployeeStatus(req.user!.id);
      }

      // Auto end personal break when re‑entering geofence
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

      // Auto clock‑out after shift end if outside geofence
      if (status === "clocked_in" && session && !session.clock_out_time) {
        const schedule = await getEffectiveSchedule(req.user!.id);
        const now = new Date();
        const [endH, endM] = schedule.end.split(':').map(Number);
        const scheduledEnd = new Date(now);
        scheduledEnd.setHours(endH, endM, 0, 0);
        // If schedule crosses midnight, adjust scheduledEnd to next day
        if (schedule.crossesMidnight && (endH < parseInt(schedule.start.split(':')[0]))) {
          scheduledEnd.setDate(scheduledEnd.getDate() + 1);
        }
        const afterShiftEnd = now > scheduledEnd;
        if (afterShiftEnd && !onSite) {
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

router.get("/me/today", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const data = await getSessionData(req.user!.id);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

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

// Updated GET /me – now includes regular_minutes and overtime_minutes
router.get("/me", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    // Fetch user's sessions (last 30)
    const { rows: sessions } = await db.query(
      `SELECT * FROM attendance_sessions
       WHERE user_id = $1
       ORDER BY work_date DESC LIMIT 30`,
      [req.user!.id]
    );

    // Get the user's effective schedule (same for all sessions unless date‑specific)
    const schedule = await getEffectiveSchedule(req.user!.id);
    const userTz = req.user!.timezone || 'America/New_York'; // fallback if missing

    // Enhance each session with regular & overtime minutes
    const enhancedSessions = sessions.map((session) => {
      let regular = 0, overtime = 0;
      if (session.clock_in_time) {
        const { regular: reg, overtime: ov } = computeRegularOvertime(
          new Date(session.clock_in_time),
          session.clock_out_time ? new Date(session.clock_out_time) : null,
          session.break_minutes || 0,
          schedule,
          userTz   // 👈 pass the timezone
        );
        regular = reg;
        overtime = ov;
      }
      return {
        ...session,
        regular_minutes: regular,
        overtime_minutes: overtime,
      };
    });

    res.json(enhancedSessions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

router.put(
  "/break/:punchId/complete",
  verifyJWT,
  async (req: AuthRequest, res: Response) => {
    try {
      const { punchId } = req.params;
      const { rows } = await db.query(
        "SELECT user_id FROM punch_records WHERE id = $1",
        [punchId]
      );
      if (rows.length === 0) {
        res.status(404).json({ error: "Break not found" });
        return;
      }
      if (rows[0].user_id !== req.user!.id) {
        res.status(403).json({ error: "Unauthorized" });
        return;
      }
      await db.query(
        "UPDATE punch_records SET break_completed = true WHERE id = $1",
        [punchId]
      );
      const data = await getSessionData(req.user!.id);
      res.json({ message: "Break marked as completed", data });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

router.put(
  "/break/:punchId/not-complete",
  verifyJWT,
  async (req: AuthRequest, res: Response) => {
    try {
      const { punchId } = req.params;
      const { reason } = req.body;
      if (!reason?.trim()) {
        res.status(400).json({ error: "Reason for not completing is required." });
        return;
      }

      const { rows } = await db.query(
        "SELECT user_id FROM punch_records WHERE id = $1",
        [punchId]
      );
      if (rows.length === 0) {
        res.status(404).json({ error: "Break not found" });
        return;
      }
      if (rows[0].user_id !== req.user!.id) {
        res.status(403).json({ error: "Unauthorized" });
        return;
      }

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
  }
);

router.get(
  "/session/:sessionId/punches",
  verifyJWT,
  async (req: AuthRequest, res: Response) => {
    try {
      const { sessionId } = req.params;
      const { rows: sessionRows } = await db.query(
        "SELECT user_id FROM attendance_sessions WHERE id = $1",
        [sessionId]
      );
      if (sessionRows.length === 0) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      if (sessionRows[0].user_id !== req.user!.id) {
        res.status(403).json({ error: "Unauthorized" });
        return;
      }
      const { rows: punches } = await db.query(
        "SELECT * FROM punch_records WHERE session_id = $1 ORDER BY punch_time ASC",
        [sessionId]
      );
      res.json(punches);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

// In routes/employees.ts (or wherever the route is)
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

export default router;