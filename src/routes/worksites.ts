import { Router, Response } from "express";
import { db } from "../db/pool";
import { verifyJWT, requireRole, AuthRequest } from "../middleware/auth";

const router = Router();

// ─── Public/Employee endpoints (JWT only) ────────────────────────────────────

/**
 * GET /api/worksites/my-assignment
 * Legacy single-site endpoint — returns the employee's default assigned worksite.
 * Falls back to any assigned worksite if no default is set.
 */
router.get("/my-assignment", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    // Try default first
    const { rows } = await db.query(
      `SELECT w.*, ew.is_default
       FROM worksites w
       JOIN employee_worksites ew ON ew.worksite_id = w.id
       WHERE ew.employee_id = $1 AND ew.is_default = true AND w.active = true
       LIMIT 1`,
      [userId]
    );
    if (rows.length > 0) return res.json(rows[0]);

    // Fall back to any assigned worksite
    const { rows: any } = await db.query(
      `SELECT w.*, ew.is_default
       FROM worksites w
       JOIN employee_worksites ew ON ew.worksite_id = w.id
       WHERE ew.employee_id = $1 AND w.active = true
       LIMIT 1`,
      [userId]
    );
    if (any.length > 0) return res.json(any[0]);

    res.status(404).json({ error: "No worksite assigned" });
  } catch (err) {
    console.error("GET /my-assignment error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /api/worksites/my-assignments
 * Returns ALL worksites assigned to the current employee as an array.
 * Default site is listed first, then alphabetically.
 */
router.get("/my-assignments", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const { rows } = await db.query(
      `SELECT w.*, ew.is_default,
              COALESCE(w.radius_feet, 1000) AS geofence_radius_ft
       FROM worksites w
       JOIN employee_worksites ew ON ew.worksite_id = w.id
       WHERE ew.employee_id = $1 AND w.active = true
       ORDER BY ew.is_default DESC, w.name ASC`,
      [userId]
    );

    res.json(rows); // always returns an array (may be empty)
  } catch (err) {
    console.error("GET /my-assignments error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── Admin/Manager endpoints ──────────────────────────────────────────────────

/**
 * GET /api/worksites
 * Returns all worksites with assignment count. Admins/managers only.
 * Query params: ?active=true|false|all (default: active only)
 */
router.get("/", verifyJWT, requireRole("admin", "manager", "owner"), async (req: AuthRequest, res: Response) => {
  try {
    const activeFilter = req.query.active;
    let whereClause = "WHERE w.active = true";
    if (activeFilter === "false") whereClause = "WHERE w.active = false";
    else if (activeFilter === "all") whereClause = "";

    const { rows } = await db.query(
      `SELECT w.*,
              COUNT(ew.employee_id)::int AS assigned_count
       FROM worksites w
       LEFT JOIN employee_worksites ew ON ew.worksite_id = w.id
       ${whereClause}
       GROUP BY w.id
       ORDER BY w.name ASC`
    );

    res.json(rows);
  } catch (err) {
    console.error("GET /worksites error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /api/worksites/assignments
 * Returns all employee–worksite assignments with employee and worksite details.
 */
router.get("/assignments", verifyJWT, requireRole("admin", "manager", "owner"), async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await db.query(
      `SELECT ew.id,
              ew.employee_id,
              ew.worksite_id,
              ew.is_default,
              ew.assigned_by,
              ew.assigned_at,
              u.name AS employee_name,
              u.user_id AS employee_user_id,
              u.role AS employee_role,
              w.name AS worksite_name,
              w.address AS worksite_address
       FROM employee_worksites ew
       JOIN users u ON u.id = ew.employee_id
       JOIN worksites w ON w.id = ew.worksite_id
       WHERE w.active = true
       ORDER BY u.name ASC, ew.is_default DESC`
    );

    res.json(rows);
  } catch (err) {
    console.error("GET /assignments error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /api/worksites/:id
 * Returns a single worksite with its assigned employees.
 */
router.get("/:id", verifyJWT, requireRole("admin", "manager", "owner"), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { rows } = await db.query(
      `SELECT w.*,
              COALESCE(
                json_agg(
                  json_build_object(
                    'id', u.id,
                    'name', u.name,
                    'user_id', u.user_id,
                    'role', u.role,
                    'is_default', ew.is_default
                  ) ORDER BY u.name ASC
                ) FILTER (WHERE u.id IS NOT NULL),
                '[]'
              ) AS assigned_employees
       FROM worksites w
       LEFT JOIN employee_worksites ew ON ew.worksite_id = w.id
       LEFT JOIN users u ON u.id = ew.employee_id AND u.status = 'active'
       WHERE w.id = $1
       GROUP BY w.id`,
      [id]
    );

    if (rows.length === 0) return res.status(404).json({ error: "Worksite not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("GET /worksites/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/worksites
 * Create a new worksite.
 */
router.post("/", verifyJWT, requireRole("admin", "manager", "owner"), async (req: AuthRequest, res: Response) => {
  try {
    const {
      name,
      address,
      latitude,
      longitude,
      radius_feet,
      notes,
    } = req.body;

    if (!name) return res.status(400).json({ error: "Name is required" });

    const { rows } = await db.query(
      `INSERT INTO worksites (name, address, latitude, longitude, radius_feet, notes, active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, NOW())
       RETURNING *`,
      [name, address || null, latitude || null, longitude || null, radius_feet || 1000, notes || null]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("POST /worksites error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /api/worksites/:id
 * Update worksite details.
 */
router.put("/:id", verifyJWT, requireRole("admin", "manager", "owner"), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const {
      name,
      address,
      latitude,
      longitude,
      radius_feet,
      notes,
      active,
    } = req.body;

    const { rows } = await db.query(
      `UPDATE worksites
       SET name = COALESCE($1, name),
           address = COALESCE($2, address),
           latitude = COALESCE($3, latitude),
           longitude = COALESCE($4, longitude),
           radius_feet = COALESCE($5, radius_feet),
           notes = COALESCE($6, notes),
           active = COALESCE($7, active),
           updated_at = NOW()
       WHERE id = $8
       RETURNING *`,
      [name, address, latitude, longitude, radius_feet, notes, active, id]
    );

    if (rows.length === 0) return res.status(404).json({ error: "Worksite not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("PUT /worksites/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /api/worksites/:id
 * Soft-delete a worksite (sets active = false).
 */
router.delete("/:id", verifyJWT, requireRole("admin", "manager", "owner"), async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const { rows } = await db.query(
      `UPDATE worksites SET active = false, updated_at = NOW()
       WHERE id = $1 RETURNING id, name`,
      [id]
    );

    if (rows.length === 0) return res.status(404).json({ error: "Worksite not found" });
    res.json({ success: true, worksite: rows[0] });
  } catch (err) {
    console.error("DELETE /worksites/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /api/worksites/:id/assign
 * Assign an employee to a worksite.
 * Body: { employeeId: string, isDefault?: boolean }
 */
router.post("/:id/assign", verifyJWT, requireRole("admin", "manager", "owner"), async (req: AuthRequest, res: Response) => {
  try {
    const { id: worksiteId } = req.params;
    const { employeeId, isDefault = false } = req.body;

    if (!employeeId) return res.status(400).json({ error: "employeeId is required" });

    // If setting as default, clear existing default for this employee
    if (isDefault) {
      await db.query(
        `UPDATE employee_worksites SET is_default = false
         WHERE employee_id = $1`,
        [employeeId]
      );
    }

    // Upsert the assignment
    const { rows } = await db.query(
      `INSERT INTO employee_worksites (employee_id, worksite_id, is_default, assigned_by, assigned_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (employee_id, worksite_id)
       DO UPDATE SET is_default = EXCLUDED.is_default,
                     assigned_by = EXCLUDED.assigned_by,
                     assigned_at = NOW()
       RETURNING *`,
      [employeeId, worksiteId, isDefault, req.user!.id]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("POST /worksites/:id/assign error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /api/worksites/:id/remove/:empId
 * Remove an employee's assignment from a worksite.
 */
router.delete("/:id/remove/:empId", verifyJWT, requireRole("admin", "manager", "owner"), async (req: AuthRequest, res: Response) => {
  try {
    const { id: worksiteId, empId: employeeId } = req.params;

    const { rowCount } = await db.query(
      `DELETE FROM employee_worksites
       WHERE worksite_id = $1 AND employee_id = $2`,
      [worksiteId, employeeId]
    );

    if (rowCount === 0) return res.status(404).json({ error: "Assignment not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /worksites/:id/remove/:empId error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /api/worksites/:id/set-default/:empId
 * Set a specific worksite as the default for an employee.
 */
router.put("/:id/set-default/:empId", verifyJWT, requireRole("admin", "manager", "owner"), async (req: AuthRequest, res: Response) => {
  try {
    const { id: worksiteId, empId: employeeId } = req.params;

    // Clear all defaults for this employee
    await db.query(
      `UPDATE employee_worksites SET is_default = false WHERE employee_id = $1`,
      [employeeId]
    );

    // Set new default
    const { rows } = await db.query(
      `UPDATE employee_worksites SET is_default = true
       WHERE employee_id = $1 AND worksite_id = $2
       RETURNING *`,
      [employeeId, worksiteId]
    );

    if (rows.length === 0) return res.status(404).json({ error: "Assignment not found — assign employee first" });
    res.json(rows[0]);
  } catch (err) {
    console.error("PUT /worksites/:id/set-default/:empId error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;