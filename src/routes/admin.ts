import { Router, Response } from "express";
import { verifyJWT, requireRole, AuthRequest } from "../middleware/auth";
import { db } from "../db/pool";
import bcrypt from "bcryptjs";
import { computeRegularOvertime, getEffectiveSchedule } from "../services/attendance";

const router = Router();

router.use(verifyJWT, requireRole("admin", "manager"));

// GET all employees
router.get("/employees", async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.status, u.created_at, u.timezone, u.user_id,
              ep.employee_code, ep.department, ep.designation, ep.phone, ep.joined_at
       FROM users u
       LEFT JOIN employee_profiles ep ON ep.user_id = u.id
       ORDER BY u.name`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST create employee
router.post("/employees", async (req: AuthRequest, res: Response) => {
  try {
    const {
      name, email, password, role, department, designation,
      phone, employeeCode, joinedAt, userId, timezone
    } = req.body;

    if (!name || !password) {
      res.status(400).json({ error: "Name and password are required" });
      return;
    }

    const hash = bcrypt.hashSync(password, 10);
    const safeEmail = (email && email.trim().length > 0) ? email.trim() : null;

    // Auto-generate user_id if not provided
    let finalUserId = userId?.trim() || null;
    if (!finalUserId) {
      // Find highest existing auto-numeric ID or any ID pattern
      const { rows: lastUser } = await db.query(
        `SELECT user_id FROM users
         WHERE user_id IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 20`
      );
      // Find highest numeric suffix across all IDs
      let maxNum = 0;
      for (const row of lastUser) {
        const match = (row.user_id || "").match(/(\d+)$/);
        if (match) {
          const n = parseInt(match[1]);
          if (n > maxNum) maxNum = n;
        }
      }
      if (maxNum === 0) maxNum = 0;
      // Generate next ID like "EM01", "EM02", etc.
      finalUserId = `EM${String(maxNum + 1).padStart(2, "0")}`;
      // Make sure it is unique
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

    // Validate timezone
    const allowedTimezones = ["America/New_York", "Asia/Kolkata", "UTC"];
    const finalTimezone = timezone && allowedTimezones.includes(timezone)
      ? timezone
      : "America/New_York";

    // Insert user
    const { rows } = await db.query(
      `INSERT INTO users (name, full_name, email, password_hash, role, user_id, timezone)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, name, safeEmail, hash, role || "employee", finalUserId, finalTimezone]
    );
    const user = rows[0];

    // ---- Insert/Update employee profile (avoid ON CONFLICT) ----
    const { rows: profileExists } = await db.query(
      "SELECT 1 FROM employee_profiles WHERE user_id = $1",
      [user.id]
    );
    if (profileExists.length === 0) {
      await db.query(
        `INSERT INTO employee_profiles (user_id, employee_code, department, designation, phone, joined_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [user.id, employeeCode || null, department || null, designation || null, phone || null, joinedAt || null]
      );
    } else {
      await db.query(
        `UPDATE employee_profiles
         SET employee_code = $2, department = $3, designation = $4, phone = $5, joined_at = $6
         WHERE user_id = $1`,
        [user.id, employeeCode || null, department || null, designation || null, phone || null, joinedAt || null]
      );
    }

    // ---- Create default schedule (avoid ON CONFLICT) ----
    const { rows: scheduleExists } = await db.query(
      "SELECT 1 FROM employee_schedules WHERE employee_id = $1",
      [user.id]
    );
    if (scheduleExists.length === 0) {
      await db.query(
        "INSERT INTO employee_schedules (employee_id) VALUES ($1)",
        [user.id]
      );
    }

    // ---- Assign to first available worksite (avoid ON CONFLICT) ----
    const { rows: worksites } = await db.query("SELECT id FROM worksites LIMIT 1");
    if (worksites.length > 0) {
      const { rows: assignmentExists } = await db.query(
        "SELECT 1 FROM employee_worksites WHERE employee_id = $1 AND worksite_id = $2",
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

// PUT update employee details (including user_id)
router.put("/employees/:id", async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { name, email, role, department, designation, employeeCode, phone, joinedAt, userId } = req.body;

    // Check if userId is unique if changed
    if (userId) {
      const { rows: existing } = await db.query(
        "SELECT id FROM users WHERE user_id = $1 AND id != $2",
        [userId, id]
      );
      if (existing.length > 0) {
        res.status(400).json({ error: "User ID already taken" });
        return;
      }
    }

    await db.query(
      `UPDATE users SET name = $1, full_name = $1, email = $2, role = $3, user_id = $4 WHERE id = $5`,
      [name, email || null, role || "employee", userId || null, id]
    );
    await db.query(
      `UPDATE employee_profiles
       SET employee_code = $1, department = $2, designation = $3, phone = $4, joined_at = $5
       WHERE user_id = $6`,
      [employeeCode || null, department || null, designation || null, phone || null, joinedAt || null, id]
    );
    res.json({ message: "Employee updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT change employee password
router.put("/employees/:id/password", async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
      res.status(400).json({ error: "Password must be at least 4 characters" });
      return;
    }
    const hash = bcrypt.hashSync(newPassword, 10);
    await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, id]);
    res.json({ message: "Password updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE deactivate employee
router.delete("/employees/:id", async (req: AuthRequest, res: Response) => {
  try {
    await db.query("UPDATE users SET status = 'inactive' WHERE id = $1", [req.params.id]);
    res.json({ message: "Employee deactivated" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// GET attendance records (admin view)
router.get("/attendance", verifyJWT, requireRole("admin", "manager"), async (req: AuthRequest, res: Response) => {
  try {
    const { user_id, date_from, date_to } = req.query;

    // Select sessions and include the new columns
    const { rows } = await db.query(
      `SELECT 
         s.id, s.user_id, s.work_date, s.clock_in_time, s.clock_out_time,
         s.break_minutes, s.personal_break_minutes, s.work_break_minutes,
         s.worked_minutes, s.status, s.is_overtime, s.overtime_minutes,
         s.regular_minutes,   -- 👈 new
         u.name, ep.employee_code
       FROM attendance_sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN employee_profiles ep ON ep.user_id = s.user_id
       WHERE ($1::uuid IS NULL OR s.user_id = $1)
         AND ($2::date IS NULL OR s.work_date >= $2)
         AND ($3::date IS NULL OR s.work_date <= $3)
       ORDER BY s.work_date DESC, u.name`,
      [user_id || null, date_from || null, date_to || null]
    );

    res.json(rows);
  } catch (err) {
    console.error("Error in /api/admin/attendance:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET reports summary
router.get("/reports/summary", async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await db.query(
      `SELECT
         u.id,
         u.name,
         ep.department,
         ep.designation,
         COUNT(DISTINCT s.id) as total_sessions,
         COALESCE(SUM(
           CASE
             WHEN s.status = 'completed' THEN s.worked_minutes
             WHEN s.status = 'active' AND s.clock_in_time IS NOT NULL THEN
               GREATEST(0,
                 ROUND(EXTRACT(EPOCH FROM (NOW() - s.clock_in_time)) / 60)::int
                 - COALESCE(s.break_minutes, 0)
               )
             ELSE 0
           END
         ), 0) as total_minutes,
         COALESCE(AVG(
           CASE
             WHEN s.status = 'completed' THEN s.worked_minutes
             WHEN s.status = 'active' AND s.clock_in_time IS NOT NULL THEN
               GREATEST(0,
                 ROUND(EXTRACT(EPOCH FROM (NOW() - s.clock_in_time)) / 60)::int
                 - COALESCE(s.break_minutes, 0)
               )
             ELSE 0
           END
         ), 0) as avg_daily_minutes,
         COALESCE(SUM(
           CASE
             WHEN s.work_date >= CURRENT_DATE - 6 THEN
               CASE
                 WHEN s.status = 'completed' THEN s.worked_minutes
                 WHEN s.status = 'active' AND s.clock_in_time IS NOT NULL THEN
                   GREATEST(0,
                     ROUND(EXTRACT(EPOCH FROM (NOW() - s.clock_in_time)) / 60)::int
                     - COALESCE(s.break_minutes, 0)
                   )
                 ELSE 0
               END
             ELSE 0
           END
         ), 0) as week_minutes,
         COUNT(CASE WHEN p.punch_type = 'break_start' THEN 1 END) as total_breaks,
         ROUND(
           COUNT(CASE WHEN p.punch_type = 'break_start' THEN 1 END)::numeric /
           NULLIF(COUNT(DISTINCT s.id), 0), 1
         ) as avg_breaks_per_day,
         COALESCE(SUM(s.personal_break_minutes), 0) as personal_break_minutes,
         COALESCE(SUM(s.work_break_minutes), 0) as work_break_minutes
       FROM users u
       LEFT JOIN employee_profiles ep ON ep.user_id = u.id
       LEFT JOIN attendance_sessions s ON s.user_id = u.id
       LEFT JOIN punch_records p ON p.session_id = s.id
       WHERE u.status = 'active' AND u.role = 'employee'
       GROUP BY u.id, u.name, ep.department, ep.designation
       ORDER BY u.name`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT update user timezone
router.put("/users/:id/timezone", async (req: AuthRequest, res: Response) => {
  try {
    const { timezone } = req.body;
    const allowed = ['America/New_York', 'Asia/Kolkata'];
    if (!allowed.includes(timezone)) {
      res.status(400).json({ error: "Invalid timezone. Allowed: America/New_York, Asia/Kolkata" });
      return;
    }
    await db.query("UPDATE users SET timezone = $1 WHERE id = $2", [timezone, req.params.id]);
    res.json({ message: "Timezone updated" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

export default router;