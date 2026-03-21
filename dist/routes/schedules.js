"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const pool_1 = require("../db/pool");
const router = (0, express_1.Router)();
// Get employee schedule
router.get("/:id/schedule", auth_1.verifyJWT, async (req, res) => {
    try {
        const { rows } = await pool_1.db.query("SELECT * FROM employee_schedules WHERE employee_id = $1", [req.params.id]);
        res.json(rows[0] || null);
    }
    catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});
// Create or update employee schedule
router.put("/:id/schedule", auth_1.verifyJWT, (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        const { scheduledStartTime, scheduledEndTime, workingDays, graceMinutes, breakRules, lunchBreakEnabled, lunchBreakStart, lunchBreakEnd } = req.body;
        const { rows } = await pool_1.db.query(`INSERT INTO employee_schedules 
        (employee_id, scheduled_start_time, scheduled_end_time, working_days,
         grace_minutes, break_rules, lunch_break_enabled, lunch_break_start, lunch_break_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (employee_id) DO UPDATE SET
        scheduled_start_time = $2, scheduled_end_time = $3, working_days = $4,
        grace_minutes = $5, break_rules = $6, lunch_break_enabled = $7,
        lunch_break_start = $8, lunch_break_end = $9, updated_at = NOW()
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
// Get all employees with their schedules (admin)
router.get("/", auth_1.verifyJWT, (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        const { rows } = await pool_1.db.query(`SELECT u.id, u.name, u.full_name, u.user_id, u.role,
              es.scheduled_start_time, es.scheduled_end_time,
              es.working_days, es.grace_minutes
       FROM users u
       LEFT JOIN employee_schedules es ON es.employee_id = u.id
       WHERE u.role = 'employee' AND u.status = 'active'
       ORDER BY u.name`);
        res.json(rows);
    }
    catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});
exports.default = router;
