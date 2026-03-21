"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const pool_1 = require("../db/pool");
const router = (0, express_1.Router)();
router.use(auth_1.verifyJWT, (0, auth_1.requireRole)("admin", "manager"));
router.get("/csv", async (req, res) => {
    try {
        const { user_id, date_from, date_to } = req.query;
        const { rows } = await pool_1.db.query(`SELECT
         u.name,
         ep.employee_code,
         ep.department,
         ep.designation,
         s.work_date,
         s.clock_in_time,
         s.clock_out_time,
         s.break_minutes,
         s.worked_minutes,
         s.status,
         COUNT(CASE WHEN p.punch_type = 'break_start' THEN 1 END) as break_count,
         ROUND(
           EXTRACT(EPOCH FROM (COALESCE(s.clock_out_time, NOW()) - s.clock_in_time)) / 3600, 2
         ) as total_hours_decimal
       FROM attendance_sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN employee_profiles ep ON ep.user_id = s.user_id
       LEFT JOIN punch_records p ON p.session_id = s.id
       WHERE ($1::uuid IS NULL OR s.user_id = $1)
         AND ($2::date IS NULL OR s.work_date >= $2)
         AND ($3::date IS NULL OR s.work_date <= $3)
         AND s.clock_in_time IS NOT NULL
       GROUP BY u.name, ep.employee_code, ep.department, ep.designation,
                s.work_date, s.clock_in_time, s.clock_out_time,
                s.break_minutes, s.worked_minutes, s.status
       ORDER BY s.work_date DESC, u.name`, [user_id || null, date_from || null, date_to || null]);
        const fmt = (v) => (v ? String(v).replace(/"/g, '""') : "");
        const fmtTime = (v) => v ? new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
        const fmtDate = (v) => v ? new Date(v).toLocaleDateString([], { year: "numeric", month: "2-digit", day: "2-digit" }) : "";
        const fmtHours = (mins) => {
            const m = parseInt(mins) || 0;
            return `${Math.floor(m / 60)}h ${m % 60}m`;
        };
        const header = [
            "Employee Name",
            "Employee Code",
            "Department",
            "Designation",
            "Date",
            "Clock In",
            "Clock Out",
            "Break Count",
            "Break Duration (min)",
            "Worked Time",
            "Total Hours (decimal)",
            "Status"
        ].map(h => `"${h}"`).join(",") + "\n";
        const body = rows.map(r => [
            fmt(r.name),
            fmt(r.employee_code),
            fmt(r.department),
            fmt(r.designation),
            fmtDate(r.work_date),
            fmtTime(r.clock_in_time),
            fmtTime(r.clock_out_time),
            r.break_count || 0,
            r.break_minutes || 0,
            fmtHours(r.worked_minutes),
            r.total_hours_decimal || "0.00",
            fmt(r.status),
        ].map(v => `"${v}"`).join(",")).join("\n");
        const fileName = `bsc_attendance_${new Date().toISOString().slice(0, 10)}.csv`;
        await pool_1.db.query(`INSERT INTO export_logs (requested_by, export_type, date_from, date_to, file_name)
       VALUES ($1, 'csv', $2, $3, $4)`, [req.user.id, date_from || null, date_to || null, fileName]);
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        res.send(header + body);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Export failed" });
    }
});
exports.default = router;
