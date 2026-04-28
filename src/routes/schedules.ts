// =============================================================================
// src/routes/schedules.ts
//
// Changes from original:
//   - PUT /:id/schedule now validates:
//       1. Both times are in valid HH:MM 24-hour format.
//       2. scheduledEndTime !== scheduledStartTime (zero-length shifts are
//          rejected instead of silently falling back to global settings).
// =============================================================================

import { Router, Response } from "express";
import { verifyJWT, requireRole, AuthRequest } from "../middleware/auth";
import { db } from "../db/pool";
import { DateTime } from "luxon";
import { getUserTimezone } from "../services/attendance";

const router = Router();

// ── Validation helper ─────────────────────────────────────────────────────────

/** Returns true when the string is a valid HH:MM 24-hour time. */
function isValidTime(t: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(t);
}

// ── GET /:id/schedule ─────────────────────────────────────────────────────────
router.get("/:id/schedule", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await db.query(
      "SELECT * FROM employee_schedules WHERE employee_id = $1",
      [req.params.id]
    );
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ── PUT /:id/schedule ─────────────────────────────────────────────────────────
router.put(
  "/:id/schedule",
  verifyJWT,
  requireRole("admin", "manager"),
  async (req: AuthRequest, res: Response) => {
    try {
      const {
        scheduledStartTime,
        scheduledEndTime,
        workingDays,
        graceMinutes,
        breakRules,
        lunchBreakEnabled,
        lunchBreakStart,
        lunchBreakEnd,
      } = req.body;

      // Resolve the values that will actually be written (mirrors the INSERT
      // defaults so validation sees the same strings the DB would receive).
      const safeStart = (scheduledStartTime || "07:00").trim();
      const safeEnd   = (scheduledEndTime   || "17:00").trim();

      // ── Validation ────────────────────────────────────────────────────────

      // 1. Format check — must be HH:MM in 24-hour notation
      if (!isValidTime(safeStart)) {
        res.status(400).json({
          error: `Invalid start time "${safeStart}". Use HH:MM 24-hour format (e.g. 07:00).`,
        });
        return;
      }
      if (!isValidTime(safeEnd)) {
        res.status(400).json({
          error: `Invalid end time "${safeEnd}". Use HH:MM 24-hour format (e.g. 17:00).`,
        });
        return;
      }

      // 2. Start ≠ End — a zero-length shift makes overtime computation
      //    undefined and forces getEffectiveSchedule() to fall back to global
      //    settings, which is confusing. Reject it explicitly here.
      if (safeStart === safeEnd) {
        res.status(400).json({
          error:
            "Schedule end time cannot equal start time. " +
            "If you want a night shift that crosses midnight (e.g. 22:00 → 06:00) " +
            "that is allowed — just make sure start and end are different.",
        });
        return;
      }

      // Optional lunch-break times — validate format only when provided
      if (lunchBreakStart && !isValidTime(lunchBreakStart)) {
        res.status(400).json({
          error: `Invalid lunch start time "${lunchBreakStart}". Use HH:MM 24-hour format.`,
        });
        return;
      }
      if (lunchBreakEnd && !isValidTime(lunchBreakEnd)) {
        res.status(400).json({
          error: `Invalid lunch end time "${lunchBreakEnd}". Use HH:MM 24-hour format.`,
        });
        return;
      }

      // ── Persist ───────────────────────────────────────────────────────────

      const { rows } = await db.query(
        `INSERT INTO employee_schedules
           (employee_id, scheduled_start_time, scheduled_end_time, working_days,
            grace_minutes, break_rules, lunch_break_enabled,
            lunch_break_start, lunch_break_end)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (employee_id) DO UPDATE SET
           scheduled_start_time = $2,
           scheduled_end_time   = $3,
           working_days         = $4,
           grace_minutes        = $5,
           break_rules          = $6,
           lunch_break_enabled  = $7,
           lunch_break_start    = $8,
           lunch_break_end      = $9,
           updated_at           = NOW()
         RETURNING *`,
        [
          req.params.id,
          safeStart,
          safeEnd,
          workingDays  || ["Mon", "Tue", "Wed", "Thu", "Fri"],
          graceMinutes || 15,
          JSON.stringify(breakRules || { max_breaks: 3, min_break_minutes: 5 }),
          lunchBreakEnabled || false,
          lunchBreakStart   || null,
          lunchBreakEnd     || null,
        ]
      );

      res.json(rows[0]);
    } catch (err) {
      console.error("[schedules] PUT /:id/schedule:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

// ── GET /:id/overtime ─────────────────────────────────────────────────────────
router.get("/:id/overtime", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.params.id as string;
    const today  = new Date().toISOString().slice(0, 10);

    // Prefer the value already stored on the active session
    const { rows: activeRows } = await db.query(
      `SELECT overtime_minutes FROM attendance_sessions
       WHERE user_id = $1 AND work_date = $2 AND status = 'active'`,
      [userId, today]
    );
    if (activeRows.length > 0) {
      const overtimeMins = activeRows[0].overtime_minutes || 0;
      res.json({ isOvertime: overtimeMins > 0, overtimeMins });
      return;
    }

    // Fallback: compare current wall-clock time to schedule end in the
    // employee's own timezone (not the server's UTC).
    const userTz = await getUserTimezone(userId);
    const now = DateTime.now().setZone(userTz);

    const { rows: schedRows } = await db.query(
      "SELECT * FROM employee_schedules WHERE employee_id = $1",
      [userId]
    );
    let schedule = schedRows[0];
    if (!schedule) {
      const { rows: settingsRows } = await db.query(
        "SELECT working_hours_start, working_hours_end FROM site_settings WHERE id = 1"
      );
      if (settingsRows.length) {
        schedule = {
          scheduled_start_time: settingsRows[0].working_hours_start,
          scheduled_end_time:   settingsRows[0].working_hours_end,
        };
      } else {
        res.json({ isOvertime: false, overtimeMins: 0 });
        return;
      }
    }

    const [endHour, endMin] = schedule.scheduled_end_time.split(":").map(Number);
    const [startHour]       = schedule.scheduled_start_time.split(":").map(Number);

    let scheduledEnd = now.set({ hour: endHour, minute: endMin, second: 0, millisecond: 0 });
    if (endHour < startHour) {
      // Night shift — shift end is on the following calendar day
      scheduledEnd = scheduledEnd.plus({ days: 1 });
    }

    const isOvertime  = now > scheduledEnd;
    const overtimeMins = isOvertime
      ? Math.round(now.diff(scheduledEnd, "minutes").minutes)
      : 0;

    res.json({ isOvertime, overtimeMins });
  } catch (err) {
    console.error("[schedules] GET /:id/overtime:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;