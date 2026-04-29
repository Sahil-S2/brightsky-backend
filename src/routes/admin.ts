// =============================================================================
// src/routes/admin.ts
//
// Changes from original:
//
//  Step 5 — Pagination
//    GET /employees     → paginated, optional ?search= filter
//    GET /reports/summary → paginated
//    GET /attendance    → paginated (bonus — was unbounded and is addressed
//                         by Step 6 anyway, so pagination comes for free)
//
//  Step 6 — Stop recomputing overtime on every request
//    GET /attendance — removed the Promise.all loop that called
//    getEffectiveSchedule() + computeRegularOvertime() per row.
//    The SELECT now reads regular_minutes and overtime_minutes directly from
//    attendance_sessions, trusting the values written by updateSessionSummary.
//    The two imports that were only used by that loop are also removed.
//
//  Everything else (POST /employees, PUT /employees/:id, DELETE, passwords,
//  PUT /users/:id/timezone, POST /recompute-sessions) is unchanged.
// =============================================================================

import { Router, Response } from "express";
import { verifyJWT, requireRole, AuthRequest } from "../middleware/auth";
import { db } from "../db/pool";
import bcrypt from "bcryptjs";
import { updateSessionSummary } from "../services/attendance";
// computeRegularOvertime, getEffectiveSchedule, getUserTimezone are no longer
// needed here now that we trust the stored columns. Removed to keep imports clean.

const router = Router();

router.use(verifyJWT, requireRole("admin", "manager"));

// ── Pagination helper ─────────────────────────────────────────────────────────
function parsePage(query: any): { page: number; limit: number; offset: number } {
  const page   = Math.max(1, parseInt(query.page  as string) || 1);
  const limit  = Math.min(100, Math.max(1, parseInt(query.limit as string) || 20));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

// =============================================================================
// GET /employees  (Step 5 — paginated + optional search)
// =============================================================================
// Before: returned every employee in a single unbounded array.
// After:  returns { employees, total, page, limit, totalPages }.
//         Optional ?search= filters by name, email, user_id, or employee_code
//         (case-insensitive ILIKE).
// =============================================================================
router.get("/employees", async (req: AuthRequest, res: Response) => {
  try {
    const { page, limit, offset } = parsePage(req.query);
    const search = ((req.query.search as string) || "").trim();

    const filterParams: any[] = [];
    let whereClause = "";

    if (search) {
      filterParams.push(`%${search}%`);
      whereClause = `
        WHERE (
          u.name            ILIKE $1
          OR u.email        ILIKE $1
          OR u.user_id      ILIKE $1
          OR ep.employee_code ILIKE $1
        )`;
    }

    // Total count (for page controls)
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*)::int AS total
       FROM users u
       LEFT JOIN employee_profiles ep ON ep.user_id = u.id
       ${whereClause}`,
      filterParams
    );
    const total = countRows[0].total;

    // Paginated data
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.status, u.created_at,
              u.timezone, u.user_id, u.work_mode,
              ep.employee_code, ep.department, ep.designation,
              ep.phone, ep.joined_at
       FROM users u
       LEFT JOIN employee_profiles ep ON ep.user_id = u.id
       ${whereClause}
       ORDER BY u.name
       LIMIT  $${filterParams.length + 1}
       OFFSET $${filterParams.length + 2}`,
      [...filterParams, limit, offset]
    );

    res.json({
      employees:  rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST create employee — unchanged
router.post("/employees", async (req: AuthRequest, res: Response) => {
  try {
    const {
      name, email, password, role, department, designation,
      phone, employeeCode, joinedAt, userId, timezone, workMode
    } = req.body;

    if (!name || !password) {
      res.status(400).json({ error: "Name and password are required" });
      return;
    }

    const hash = bcrypt.hashSync(password, 10);
    const safeEmail = (email && email.trim().length > 0) ? email.trim() : null;

    let finalUserId = userId?.trim() || null;
    if (!finalUserId) {
      const { rows: lastUser } = await db.query(
        `SELECT user_id FROM users WHERE user_id IS NOT NULL ORDER BY created_at DESC LIMIT 20`
      );
      let maxNum = 0;
      for (const row of lastUser) {
        const match = (row.user_id || "").match(/(\d+)$/);
        if (match) { const n = parseInt(match[1]); if (n > maxNum) maxNum = n; }
      }
      finalUserId = `EM${String(maxNum + 1).padStart(2, "0")}`;
      let attempts = 0;
      while (attempts < 20) {
        const { rows: exists } = await db.query(
          "SELECT id FROM users WHERE user_id = $1", [finalUserId]
        );
        if (exists.length === 0) break;
        maxNum++;
        finalUserId = `EM${String(maxNum + 1).padStart(2, "0")}`;
        attempts++;
      }
    }

    const allowedTimezones = ["America/New_York", "Asia/Kolkata", "UTC"];
    const finalTimezone = timezone && allowedTimezones.includes(timezone)
      ? timezone : "America/New_York";

    const finalWorkMode = workMode === "offsite" ? "offsite" : "onsite";

    const { rows } = await db.query(
      `INSERT INTO users (name, full_name, email, password_hash, role, user_id, timezone, work_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, name, safeEmail, hash, role || "employee", finalUserId, finalTimezone, finalWorkMode]
    );
    const user = rows[0];

    const { rows: profileExists } = await db.query(
      "SELECT 1 FROM employee_profiles WHERE user_id = $1", [user.id]
    );
    if (profileExists.length === 0) {
      await db.query(
        `INSERT INTO employee_profiles
           (user_id, employee_code, department, designation, phone, joined_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [user.id, employeeCode||null, department||null, designation||null, phone||null, joinedAt||null]
      );
    } else {
      await db.query(
        `UPDATE employee_profiles
         SET employee_code=$2, department=$3, designation=$4, phone=$5, joined_at=$6
         WHERE user_id=$1`,
        [user.id, employeeCode||null, department||null, designation||null, phone||null, joinedAt||null]
      );
    }

    const { rows: scheduleExists } = await db.query(
      "SELECT 1 FROM employee_schedules WHERE employee_id = $1", [user.id]
    );
    if (scheduleExists.length === 0) {
      await db.query("INSERT INTO employee_schedules (employee_id) VALUES ($1)", [user.id]);
    }

    const { rows: worksites } = await db.query("SELECT id FROM worksites LIMIT 1");
    if (worksites.length > 0) {
      const { rows: assignmentExists } = await db.query(
        "SELECT 1 FROM employee_worksites WHERE employee_id=$1 AND worksite_id=$2",
        [user.id, worksites[0].id]
      );
      if (assignmentExists.length === 0) {
        await db.query(
          `INSERT INTO employee_worksites (employee_id, worksite_id, is_default, assigned_by)
           VALUES ($1, $2, true, $3)`,
          [user.id, worksites[0].id, req.user!.id]
        );
      }
    }

    res.status(201).json({
      message: "Employee created",
      id: user.id,
      userId: finalUserId,
      name: user.name,
    });
  } catch (err: any) {
    console.error("Create employee error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// PUT update employee — unchanged
router.put("/employees/:id", async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { name, email, role, department, designation, employeeCode, phone, joinedAt, userId, workMode } = req.body;

    if (userId) {
      const { rows: existing } = await db.query(
        "SELECT id FROM users WHERE user_id = $1 AND id != $2", [userId, id]
      );
      if (existing.length > 0) {
        res.status(400).json({ error: "User ID already taken" });
        return;
      }
    }

    const finalWorkMode = workMode === "offsite" ? "offsite" : "onsite";

    await db.query(
      `UPDATE users SET name=$1, full_name=$1, email=$2, role=$3, user_id=$4, work_mode=$5 WHERE id=$6`,
      [name, email||null, role||"employee", userId||null, finalWorkMode, id]
    );
    await db.query(
      `UPDATE employee_profiles
       SET employee_code=$1, department=$2, designation=$3, phone=$4, joined_at=$5
       WHERE user_id=$6`,
      [employeeCode||null, department||null, designation||null, phone||null, joinedAt||null, id]
    );
    res.json({ message: "Employee updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT change password — unchanged
router.put("/employees/:id/password", async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
      res.status(400).json({ error: "Password must be at least 4 characters" });
      return;
    }
    const hash = bcrypt.hashSync(newPassword, 10);
    await db.query("UPDATE users SET password_hash=$1 WHERE id=$2", [hash, id]);
    res.json({ message: "Password updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE deactivate — unchanged
router.delete("/employees/:id", async (req: AuthRequest, res: Response) => {
  try {
    await db.query("UPDATE users SET status='inactive' WHERE id=$1", [req.params.id]);
    res.json({ message: "Employee deactivated" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// =============================================================================
// GET /attendance  (Step 5 — paginated | Step 6 — no recompute loop)
// =============================================================================
// Before: fetched every session matching the filters, then ran a Promise.all
//         that called getEffectiveSchedule() + computeRegularOvertime() for
//         every single row. With 50 employees × 90 days that is ~4 500 async
//         DB calls per page load.
// After:  reads regular_minutes and overtime_minutes directly from the
//         attendance_sessions row (written by updateSessionSummary at clock-out
//         and on recompute). Zero extra calls. Also paginated.
// =============================================================================
router.get("/attendance", async (req: AuthRequest, res: Response) => {
  try {
    const { user_id, date_from, date_to } = req.query;
    const { page, limit, offset } = parsePage(req.query);

    const filterParams: any[] = [user_id || null, date_from || null, date_to || null];

    // Count total matching sessions
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*)::int AS total
       FROM attendance_sessions s
       WHERE ($1::uuid IS NULL OR s.user_id    = $1)
         AND ($2::date IS NULL OR s.work_date >= $2)
         AND ($3::date IS NULL OR s.work_date <= $3)`,
      filterParams
    );
    const total = countRows[0].total;

    // Paginated sessions — regular_minutes and overtime_minutes come straight
    // from the DB columns; no post-processing loop needed.
    const { rows: sessions } = await db.query(
      `SELECT
         s.id, s.user_id, s.work_date,
         s.clock_in_time, s.clock_out_time,
         s.break_minutes, s.personal_break_minutes, s.work_break_minutes,
         s.worked_minutes, s.regular_minutes, s.overtime_minutes,
         s.status, s.is_overtime, s.is_auto_corrected,
         s.is_outside_geofence, s.estimated_minutes,
         u.name, u.timezone AS user_timezone, u.work_mode,
         ep.employee_code
       FROM attendance_sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN employee_profiles ep ON ep.user_id = s.user_id
       WHERE ($1::uuid IS NULL OR s.user_id    = $1)
         AND ($2::date IS NULL OR s.work_date >= $2)
         AND ($3::date IS NULL OR s.work_date <= $3)
       ORDER BY s.work_date DESC, u.name
       LIMIT  $4
       OFFSET $5`,
      [...filterParams, limit, offset]
    );

    res.json({
      sessions,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("Error in GET /api/admin/attendance:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// =============================================================================
// GET /reports/summary  (Step 5 — paginated)
// =============================================================================
// Before: returned one summary row per active employee in one unbounded query.
// After:  same CTE, but with LIMIT/OFFSET applied to the outer SELECT.
//         Returns { summary, total, page, limit, totalPages }.
//         The debug console.log is also removed (it was logging PII to Railway).
// =============================================================================
router.get("/reports/summary", async (req: AuthRequest, res: Response) => {
  try {
    const { page, limit, offset } = parsePage(req.query);

    // Cheap count — avoids running the full CTE just to count rows
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*)::int AS total
       FROM users
       WHERE status = 'active' AND role = 'employee'`
    );
    const total = countRows[0].total;

    const { rows } = await db.query(
      `WITH session_aggregates AS (
        SELECT
          user_id,
          COUNT(*) AS total_sessions,
          COALESCE(SUM(
            CASE
              WHEN status = 'active' AND clock_in_time IS NOT NULL
              THEN GREATEST(0,
                     EXTRACT(EPOCH FROM (NOW() - clock_in_time))::int / 60
                     - COALESCE(break_minutes, 0))
              ELSE COALESCE(worked_minutes, 0)
            END
          ), 0) AS total_minutes,
          COALESCE(SUM(COALESCE(regular_minutes,  0)), 0) AS total_regular_minutes,
          COALESCE(SUM(COALESCE(overtime_minutes, 0)), 0) AS total_overtime_minutes,
          COALESCE(AVG(
            CASE
              WHEN status = 'active' AND clock_in_time IS NOT NULL
              THEN GREATEST(0,
                     EXTRACT(EPOCH FROM (NOW() - clock_in_time))::int / 60
                     - COALESCE(break_minutes, 0))
              ELSE COALESCE(worked_minutes, 0)
            END
          ), 0) AS avg_daily_minutes,
          COALESCE(SUM(
            CASE WHEN work_date >= CURRENT_DATE - 6 THEN
              CASE
                WHEN status = 'active' AND clock_in_time IS NOT NULL
                THEN GREATEST(0,
                       EXTRACT(EPOCH FROM (NOW() - clock_in_time))::int / 60
                       - COALESCE(break_minutes, 0))
                ELSE COALESCE(worked_minutes, 0)
              END
            ELSE 0 END
          ), 0) AS week_minutes,
          COALESCE(SUM(personal_break_minutes), 0) AS personal_break_minutes,
          COALESCE(SUM(work_break_minutes),     0) AS work_break_minutes
        FROM attendance_sessions
        GROUP BY user_id
      ),
      break_counts AS (
        SELECT
          s.user_id,
          COUNT(p.id) AS total_breaks
        FROM attendance_sessions s
        LEFT JOIN punch_records p
          ON p.session_id = s.id AND p.punch_type = 'break_start'
        GROUP BY s.user_id
      )
      SELECT
        u.id,
        u.name,
        u.work_mode,
        ep.department,
        ep.designation,
        COALESCE(sa.total_sessions,        0) AS total_sessions,
        COALESCE(sa.total_minutes,         0) AS total_minutes,
        COALESCE(sa.total_regular_minutes, 0) AS total_regular_minutes,
        COALESCE(sa.total_overtime_minutes,0) AS total_overtime_minutes,
        COALESCE(sa.avg_daily_minutes,     0) AS avg_daily_minutes,
        COALESCE(sa.week_minutes,          0) AS week_minutes,
        COALESCE(bc.total_breaks,          0) AS total_breaks,
        COALESCE(sa.personal_break_minutes,0) AS personal_break_minutes,
        COALESCE(sa.work_break_minutes,    0) AS work_break_minutes
      FROM users u
      LEFT JOIN employee_profiles ep  ON ep.user_id  = u.id
      LEFT JOIN session_aggregates sa ON sa.user_id  = u.id
      LEFT JOIN break_counts       bc ON bc.user_id  = u.id
      WHERE u.status = 'active' AND u.role = 'employee'
      ORDER BY u.name
      LIMIT  $1
      OFFSET $2`,
      [limit, offset]
    );

    res.json({
      summary:    rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET punch records for any session (admin/manager access — no ownership check)
// Used by the frontend "Show Details" panel in AttendancePage
router.get("/attendance/session/:sessionId/punches", async (req: AuthRequest, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { rows: sessionRows } = await db.query(
      "SELECT id FROM attendance_sessions WHERE id = $1",
      [sessionId]
    );
    if (sessionRows.length === 0) {
      res.status(404).json({ error: "Session not found" });
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
});

// PUT update user timezone — unchanged
router.put("/users/:id/timezone", async (req: AuthRequest, res: Response) => {
  try {
    const { timezone } = req.body;
    const allowed = ["America/New_York", "Asia/Kolkata"];
    if (!allowed.includes(timezone)) {
      res.status(400).json({ error: "Invalid timezone. Allowed: America/New_York, Asia/Kolkata" });
      return;
    }
    await db.query("UPDATE users SET timezone=$1 WHERE id=$2", [timezone, req.params.id]);
    res.json({ message: "Timezone updated" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// POST recompute-sessions — unchanged (admin-only)
router.post("/recompute-sessions", verifyJWT, requireRole("admin"), async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await db.query(
      "SELECT id FROM attendance_sessions WHERE status = 'completed'"
    );
    for (const row of rows) {
      await updateSessionSummary(row.id);
    }
    res.json({ message: `Recomputed ${rows.length} sessions.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;