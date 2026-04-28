// =============================================================================
// src/routes/export.ts
//
// Changes from original:
//   1. Added columns: regular_minutes, overtime_minutes,
//      personal_break_minutes, work_break_minutes, is_auto_corrected.
//   2. Clock-in and clock-out times are now formatted in the employee's own
//      timezone (stored in users.timezone) instead of the server's UTC locale.
//   3. CSV header updated to match the new columns.
// =============================================================================

import { Router, Response } from "express";
import { verifyJWT, requireRole, AuthRequest } from "../middleware/auth";
import { db } from "../db/pool";
import { DateTime } from "luxon";

const router = Router();

router.use(verifyJWT, requireRole("admin", "manager"));

router.get("/csv", async (req: AuthRequest, res: Response) => {
  try {
    const { user_id, date_from, date_to } = req.query;

    const { rows } = await db.query(
      `SELECT
         u.name,
         u.timezone                    AS user_timezone,
         ep.employee_code,
         ep.department,
         ep.designation,
         s.work_date,
         s.clock_in_time,
         s.clock_out_time,
         s.personal_break_minutes,
         s.work_break_minutes,
         s.break_minutes,
         s.regular_minutes,
         s.overtime_minutes,
         s.worked_minutes,
         s.status,
         s.is_overtime,
         s.is_auto_corrected,
         COUNT(CASE WHEN p.punch_type = 'break_start' THEN 1 END) AS break_count,
         ROUND(
           EXTRACT(EPOCH FROM (
             COALESCE(s.clock_out_time, NOW()) - s.clock_in_time
           )) / 3600, 2
         ) AS total_hours_decimal
       FROM attendance_sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN employee_profiles ep ON ep.user_id = s.user_id
       LEFT JOIN punch_records     p  ON p.session_id = s.id
       WHERE ($1::uuid IS NULL OR s.user_id    = $1)
         AND ($2::date IS NULL OR s.work_date >= $2)
         AND ($3::date IS NULL OR s.work_date <= $3)
         AND s.clock_in_time IS NOT NULL
       GROUP BY
         u.name, u.timezone,
         ep.employee_code, ep.department, ep.designation,
         s.work_date, s.clock_in_time, s.clock_out_time,
         s.personal_break_minutes, s.work_break_minutes, s.break_minutes,
         s.regular_minutes, s.overtime_minutes, s.worked_minutes,
         s.status, s.is_overtime, s.is_auto_corrected
       ORDER BY s.work_date DESC, u.name`,
      [user_id || null, date_from || null, date_to || null]
    );

    // ── Formatters ───────────────────────────────────────────────────────────

    /** Escape double-quotes inside a CSV cell value. */
    const fmt = (v: any) => (v != null ? String(v).replace(/"/g, '""') : "");

    /**
     * Format a timestamp in the employee's own timezone.
     * Previously used new Date().toLocaleTimeString() which produced server-UTC
     * times — wrong by 4–9.5 h depending on the employee's location.
     */
    const fmtTime = (v: any, timezone: string): string => {
      if (!v) return "";
      return DateTime.fromJSDate(new Date(v))
        .setZone(timezone || "America/New_York")
        .toFormat("HH:mm");
    };

    const fmtDate = (v: any): string =>
      v
        ? new Date(v).toLocaleDateString([], {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          })
        : "";

    /** Convert a minute count to a human-readable "Xh Ym" string. */
    const fmtHours = (mins: any): string => {
      const m = parseInt(mins) || 0;
      return `${Math.floor(m / 60)}h ${m % 60}m`;
    };

    // ── Header ───────────────────────────────────────────────────────────────

    const header =
      [
        "Employee Name",
        "Employee Code",
        "Department",
        "Designation",
        "Date",
        "Clock In (local time)",
        "Clock Out (local time)",
        "Break Count",
        "Personal Break (min)",
        "Work Break (min)",
        "Total Break (min)",
        "Regular Time",
        "Overtime",
        "Worked Time",
        "Total Hours (decimal)",
        "Status",
        "Auto Corrected",
      ]
        .map((h) => `"${h}"`)
        .join(",") + "\n";

    // ── Rows ─────────────────────────────────────────────────────────────────

    const body = rows
      .map((r) => {
        const tz = r.user_timezone || "America/New_York";
        return [
          fmt(r.name),
          fmt(r.employee_code),
          fmt(r.department),
          fmt(r.designation),
          fmtDate(r.work_date),
          fmtTime(r.clock_in_time,  tz),
          fmtTime(r.clock_out_time, tz),
          r.break_count              || 0,
          r.personal_break_minutes   || 0,
          r.work_break_minutes       || 0,
          r.break_minutes            || 0,
          fmtHours(r.regular_minutes),
          fmtHours(r.overtime_minutes),
          fmtHours(r.worked_minutes),
          r.total_hours_decimal      || "0.00",
          fmt(r.status),
          r.is_auto_corrected ? "Yes" : "No",
        ]
          .map((v) => `"${v}"`)
          .join(",");
      })
      .join("\n");

    // ── Log & send ───────────────────────────────────────────────────────────

    const fileName = `bsc_attendance_${new Date().toISOString().slice(0, 10)}.csv`;

    await db.query(
      `INSERT INTO export_logs (requested_by, export_type, date_from, date_to, file_name)
       VALUES ($1, 'csv', $2, $3, $4)`,
      [req.user!.id, date_from || null, date_to || null, fileName]
    );

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(header + body);
  } catch (err) {
    console.error("[export] CSV error:", err);
    res.status(500).json({ error: "Export failed" });
  }
});

export default router;