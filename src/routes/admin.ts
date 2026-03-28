import { Router, Response } from "express";
import { verifyJWT, requireRole, AuthRequest } from "../middleware/auth";
import { db } from "../db/pool";
import bcrypt from "bcryptjs";

const router = Router();

router.use(verifyJWT, requireRole("admin", "manager"));

router.get("/employees", async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.status, u.created_at,
              ep.employee_code, ep.department, ep.designation, ep.phone, ep.joined_at
       FROM users u
       LEFT JOIN employee_profiles ep ON ep.user_id = u.id
       ORDER BY u.name`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/employees", async (req: AuthRequest, res: Response) => {
  try {
    const { name, email, password, role, department, designation, phone, employeeCode, joinedAt, userId } = req.body;
    if (!name || !password) {
      res.status(400).json({ error: "Name and password are required" });
      return;
    }
    const hash = bcrypt.hashSync(password, 10);

    // Auto-generate user_id if not provided
    let finalUserId = userId;
    if (!finalUserId) {
      const { rows: lastUser } = await db.query(
        "SELECT user_id FROM users WHERE user_id ~ '^[0-9]+$' ORDER BY user_id::int DESC LIMIT 1"
      );
      const lastId = lastUser[0] ? parseInt(lastUser[0].user_id) : 1000;
      finalUserId = String(lastId + 1).padStart(4, '0');
    }

    const { rows } = await db.query(
      `INSERT INTO users (name, full_name, email, password_hash, role, user_id)
       VALUES ($1, $1, $2, $3, $4, $5) RETURNING *`,
      [name, email || null, hash, role || "employee", finalUserId]
    );
    const user = rows[0];
    await db.query(
      `INSERT INTO employee_profiles (user_id, employee_code, department, designation, phone, joined_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user.id, employeeCode || null, department || null, designation || null, phone || null, joinedAt || null]
    );

    // Create default schedule
    await db.query(
      "INSERT INTO employee_schedules (employee_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [user.id]
    );

    // Assign default worksite
    const { rows: worksites } = await db.query("SELECT id FROM worksites LIMIT 1");
    if (worksites.length > 0) {
      await db.query(
        `INSERT INTO employee_worksites (employee_id, worksite_id, is_default, assigned_by)
         VALUES ($1, $2, true, $3) ON CONFLICT DO NOTHING`,
        [user.id, worksites[0].id, req.user!.id]
      );
    }

    res.status(201).json({ message: "Employee created", id: user.id, userId: finalUserId });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

router.delete("/employees/:id", async (req: AuthRequest, res: Response) => {
  try {
    await db.query("UPDATE users SET status = 'inactive' WHERE id = $1", [req.params.id]);
    res.json({ message: "Employee deactivated" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/attendance", async (req: AuthRequest, res: Response) => {
  try {
    const { user_id, date_from, date_to } = req.query;
    const { rows } = await db.query(
      `SELECT 
         s.id, s.user_id, s.work_date, s.clock_in_time, s.clock_out_time,
         s.break_minutes, s.personal_break_minutes, s.work_break_minutes,
         s.worked_minutes, s.status, s.is_overtime, s.overtime_minutes,
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
    res.status(500).json({ error: "Server error" });
  }
});

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

export default router;