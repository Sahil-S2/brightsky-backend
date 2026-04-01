"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const pool_1 = require("../db/pool");
const luxon_1 = require("luxon");
const attendance_1 = require("../services/attendance");
const router = (0, express_1.Router)();
router.get("/:id/schedule", auth_1.verifyJWT, async (req, res) => {
    try {
        const { rows } = await pool_1.db.query("SELECT * FROM employee_schedules WHERE employee_id=$1", [req.params.id]);
        res.json(rows[0] || null);
    }
    catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});
router.put("/:id/schedule", auth_1.verifyJWT, (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        const { scheduledStartTime, scheduledEndTime, workingDays, graceMinutes, breakRules, lunchBreakEnabled, lunchBreakStart, lunchBreakEnd } = req.body;
        const { rows } = await pool_1.db.query(`INSERT INTO employee_schedules
        (employee_id, scheduled_start_time, scheduled_end_time, working_days,
         grace_minutes, break_rules, lunch_break_enabled, lunch_break_start, lunch_break_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (employee_id) DO UPDATE SET
         scheduled_start_time=$2, scheduled_end_time=$3, working_days=$4,
         grace_minutes=$5, break_rules=$6, lunch_break_enabled=$7,
         lunch_break_start=$8, lunch_break_end=$9, updated_at=NOW()
       RETURNING *`, [
            req.params.id,
            scheduledStartTime || "07:00",
            scheduledEndTime || "17:00",
            workingDays || ["Mon", "Tue", "Wed", "Thu", "Fri"],
            graceMinutes || 15,
            JSON.stringify(breakRules || { max_breaks: 3, min_break_minutes: 5 }),
            lunchBreakEnabled || false,
            lunchBreakStart || null,
            lunchBreakEnd || null
        ]);
        res.json(rows[0]);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
// Check overtime for a session
router.get("/:id/overtime", auth_1.verifyJWT, async (req, res) => {
    try {
        const userId = req.params.id; // ensure it's a string
        // First check if there's an active session today
        const today = new Date().toISOString().slice(0, 10);
        const { rows: activeRows } = await pool_1.db.query(`SELECT overtime_minutes FROM attendance_sessions
       WHERE user_id = $1 AND work_date = $2 AND status = 'active'`, [userId, today]);
        if (activeRows.length > 0) {
            const overtimeMins = activeRows[0].overtime_minutes || 0;
            res.json({ isOvertime: overtimeMins > 0, overtimeMins });
            return;
        }
        // Fallback to schedule‑based calculation
        const userTz = await (0, attendance_1.getUserTimezone)(userId);
        const now = luxon_1.DateTime.now().setZone(userTz);
        // Fetch employee schedule (or global fallback)
        const { rows: schedRows } = await pool_1.db.query("SELECT * FROM employee_schedules WHERE employee_id = $1", [userId]);
        let schedule = schedRows[0];
        if (!schedule) {
            const { rows: settingsRows } = await pool_1.db.query("SELECT working_hours_start, working_hours_end FROM site_settings WHERE id = 1");
            if (settingsRows.length) {
                schedule = {
                    scheduled_start_time: settingsRows[0].working_hours_start,
                    scheduled_end_time: settingsRows[0].working_hours_end,
                };
            }
            else {
                res.json({ isOvertime: false, overtimeMins: 0 });
                return;
            }
        }
        const [startHour, startMin] = schedule.scheduled_start_time.split(':').map(Number);
        const [endHour, endMin] = schedule.scheduled_end_time.split(':').map(Number);
        let scheduledEnd = now.set({ hour: endHour, minute: endMin, second: 0, millisecond: 0 });
        if (endHour < startHour) {
            scheduledEnd = scheduledEnd.plus({ days: 1 });
        }
        const isOvertime = now > scheduledEnd;
        const overtimeMins = isOvertime
            ? Math.round(now.diff(scheduledEnd, 'minutes').minutes)
            : 0;
        res.json({ isOvertime, overtimeMins });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
exports.default = router;
