import { Router, Response } from "express";
import { verifyJWT, requireRole, AuthRequest } from "../middleware/auth";
import { db } from "../db/pool";

const router = Router();

router.get("/:id/schedule", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await db.query(
      "SELECT * FROM employee_schedules WHERE employee_id=$1",
      [req.params.id]
    );
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.put("/:id/schedule", verifyJWT, requireRole("admin","manager"), async (req: AuthRequest, res: Response) => {
  try {
    const {
      scheduledStartTime, scheduledEndTime, workingDays,
      graceMinutes, breakRules, lunchBreakEnabled,
      lunchBreakStart, lunchBreakEnd
    } = req.body;
    const { rows } = await db.query(
      `INSERT INTO employee_schedules
        (employee_id, scheduled_start_time, scheduled_end_time, working_days,
         grace_minutes, break_rules, lunch_break_enabled, lunch_break_start, lunch_break_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (employee_id) DO UPDATE SET
         scheduled_start_time=$2, scheduled_end_time=$3, working_days=$4,
         grace_minutes=$5, break_rules=$6, lunch_break_enabled=$7,
         lunch_break_start=$8, lunch_break_end=$9, updated_at=NOW()
       RETURNING *`,
      [
        req.params.id,
        scheduledStartTime||"07:00",
        scheduledEndTime||"17:00",
        workingDays||["Mon","Tue","Wed","Thu","Fri"],
        graceMinutes||15,
        JSON.stringify(breakRules||{max_breaks:3,min_break_minutes:5}),
        lunchBreakEnabled||false,
        lunchBreakStart||null,
        lunchBreakEnd||null
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Check overtime for a session
router.get("/:id/overtime", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const { rows: schedRows } = await db.query(
      "SELECT * FROM employee_schedules WHERE employee_id=$1",
      [req.params.id]
    );
    const schedule = schedRows[0];
    if (!schedule) { res.json({ isOvertime: false }); return; }

    const now = new Date();
    const [endH, endM] = (schedule.scheduled_end_time||"17:00").toString().split(":").map(Number);
    const scheduledEnd = new Date();
    scheduledEnd.setHours(endH, endM, 0, 0);

    const { rows: sessRows } = await db.query(
      `SELECT * FROM attendance_sessions
       WHERE user_id=$1 AND work_date=CURRENT_DATE AND status='active'`,
      [req.params.id]
    );
    const session = sessRows[0];
    if (!session) { res.json({ isOvertime: false }); return; }

    const isOvertime = now > scheduledEnd;
    const overtimeMins = isOvertime
      ? Math.round((now.getTime() - scheduledEnd.getTime()) / 60000)
      : 0;

    res.json({ isOvertime, overtimeMins, scheduledEnd: scheduledEnd.toISOString() });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

export default router;