import { Router, Response } from "express";
import { db } from "../db/pool";
import { verifyJWT, requireRole, AuthRequest } from "../middleware/auth";

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Accept both camelCase (from frontend form) and snake_case field names. */
function coalesce<T>(...values: (T | undefined | null)[]): T | null {
  for (const v of values) {
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

// ─── Employee endpoints (JWT only) ────────────────────────────────────────────

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
       WHERE ew.employee_id = $1 AND ew.is_default = true
       LIMIT 1`,
      [userId]
    );
    if (rows.length > 0) return res.json(rows[0]);

    // Fall back to any assigned worksite
    const { rows: fallback } = await db.query(
      `SELECT w.*, ew.is_default
       FROM worksites w
       JOIN employee_worksites ew ON ew.worksite_id = w.id
       WHERE ew.employee_id = $1
       LIMIT 1`,
      [userId]
    );
    if (fallback.length > 0) return res.json(fallback[0]);

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
       WHERE ew.employee_id = $1
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
 * Employees use /my-assignments instead.
 */
router.get(
  "/",
  verifyJWT,
  requireRole("admin", "manager", "owner"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { rows } = await db.query(
        `SELECT w.*,
                COALESCE(w.radius_feet, 1000) AS geofence_radius_ft,
                COUNT(ew.employee_id)::int AS assigned_count
         FROM worksites w
         LEFT JOIN employee_worksites ew ON ew.worksite_id = w.id
         GROUP BY w.id
         ORDER BY w.name ASC`
      );

      res.json(rows);
    } catch (err) {
      console.error("GET /worksites error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/**
 * GET /api/worksites/assignments
 * Returns all employee–worksite assignments with details.
 */
router.get(
  "/assignments",
  verifyJWT,
  requireRole("admin", "manager", "owner"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { rows } = await db.query(
        `SELECT ew.id,
                ew.employee_id,
                ew.worksite_id,
                ew.is_default,
                ew.assigned_by,
                u.name AS employee_name,
                u.user_id AS employee_user_id,
                u.role AS employee_role,
                w.name AS worksite_name,
                w.address AS worksite_address
         FROM employee_worksites ew
         JOIN users u ON u.id = ew.employee_id
         JOIN worksites w ON w.id = ew.worksite_id
         ORDER BY u.name ASC, ew.is_default DESC`
      );

      res.json(rows);
    } catch (err) {
      console.error("GET /assignments error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/**
 * GET /api/worksites/:id
 * Returns a single worksite with its assigned employees.
 */
router.get(
  "/:id",
  verifyJWT,
  requireRole("admin", "manager", "owner"),
  async (req: AuthRequest, res: Response) => {
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
  }
);

/**
 * POST /api/worksites
 * Create a new worksite.
 * Accepts both camelCase (radiusFeet, projectName) and snake_case (radius_feet, project_name)
 * field names from the frontend form.
 */
router.post(
  "/",
  verifyJWT,
  requireRole("admin", "manager", "owner"),
  async (req: AuthRequest, res: Response) => {
    try {
      const body = req.body;

      const name        = coalesce<string>(body.name);
      const address     = coalesce<string>(body.address);
      const latitude    = coalesce<number>(body.latitude);
      const longitude   = coalesce<number>(body.longitude);
      // Accept both radiusFeet (frontend camelCase) and radius_feet (snake_case)
      const radiusFeet  = coalesce<number>(body.radiusFeet, body.radius_feet);
      // Accept both projectName and project_name
      const projectName = coalesce<string>(body.projectName, body.project_name);
      const notes       = coalesce<string>(body.notes);

      if (!name) return res.status(400).json({ error: "Job site name is required" });

      // Build INSERT dynamically so it works even if the migration hasn't run yet.
      // Core columns that are guaranteed to exist:
      let cols = ["name"];
      let vals: any[] = [name];
      let idx = 2;

      if (address     !== null) { cols.push("address");      vals.push(address);      idx++; }
      if (latitude    !== null) { cols.push("latitude");     vals.push(latitude);     idx++; }
      if (longitude   !== null) { cols.push("longitude");    vals.push(longitude);    idx++; }
      if (radiusFeet  !== null) { cols.push("radius_feet");  vals.push(radiusFeet);   idx++; }

      // These columns are added by the migration — attempt to include them,
      // caught below if the column doesn't exist yet.
      const extCols: string[] = [];
      const extVals: any[] = [];
      if (projectName !== null) { extCols.push("project_name"); extVals.push(projectName); }
      if (notes       !== null) { extCols.push("notes");        extVals.push(notes); }

      const tryInsert = async (includeMigrationCols: boolean) => {
        const allCols = includeMigrationCols ? [...cols, ...extCols] : cols;
        const allVals = includeMigrationCols ? [...vals, ...extVals] : vals;
        const placeholders = allVals.map((_, i) => `$${i + 1}`).join(", ");
        return db.query(
          `INSERT INTO worksites (${allCols.join(", ")})
           VALUES (${placeholders})
           RETURNING *`,
          allVals
        );
      };

      let result;
      try {
        result = await tryInsert(true);
      } catch (err: any) {
        // If migration columns don't exist yet, retry without them
        if (err.code === "42703") {
          result = await tryInsert(false);
        } else {
          throw err;
        }
      }

      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error("POST /worksites error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/**
 * PUT /api/worksites/:id
 * Update worksite details.
 * Accepts both camelCase and snake_case field names.
 */
router.put(
  "/:id",
  verifyJWT,
  requireRole("admin", "manager", "owner"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;
      const body = req.body;

      const name        = coalesce<string>(body.name);
      const address     = coalesce<string>(body.address);
      const latitude    = coalesce<number>(body.latitude);
      const longitude   = coalesce<number>(body.longitude);
      const radiusFeet  = coalesce<number>(body.radiusFeet, body.radius_feet);
      const projectName = coalesce<string>(body.projectName, body.project_name);
      const notes       = coalesce<string>(body.notes);
      const active      = body.active !== undefined ? body.active : null;

      // Build SET clause dynamically
      const setClauses: string[] = [];
      const values: any[] = [];
      let idx = 1;

      const set = (col: string, val: any) => {
        if (val !== null) {
          setClauses.push(`${col} = $${idx++}`);
          values.push(val);
        }
      };

      set("name",         name);
      set("address",      address);
      set("latitude",     latitude);
      set("longitude",    longitude);
      set("radius_feet",  radiusFeet);
      set("active",       active);

      // Migration columns — added to SET only if provided
      if (projectName !== null) { setClauses.push(`project_name = $${idx++}`); values.push(projectName); }
      if (notes !== null)       { setClauses.push(`notes = $${idx++}`);        values.push(notes); }

      if (setClauses.length === 0) {
        return res.status(400).json({ error: "No fields to update" });
      }

      values.push(id); // last placeholder for WHERE

      const tryUpdate = async (includeUpdatedAt: boolean) => {
        const ts = includeUpdatedAt ? `, updated_at = NOW()` : "";
        return db.query(
          `UPDATE worksites
           SET ${setClauses.join(", ")}${ts}
           WHERE id = $${values.length}
           RETURNING *`,
          values
        );
      };

      let result;
      try {
        result = await tryUpdate(true);
      } catch (err: any) {
        if (err.code === "42703") {
          result = await tryUpdate(false);
        } else {
          throw err;
        }
      }

      if (result.rows.length === 0) return res.status(404).json({ error: "Worksite not found" });
      res.json(result.rows[0]);
    } catch (err) {
      console.error("PUT /worksites/:id error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/**
 * DELETE /api/worksites/:id
 * Soft-delete a worksite (sets active = false) if column exists, otherwise hard-delete.
 */
router.delete(
  "/:id",
  verifyJWT,
  requireRole("admin", "manager", "owner"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { id } = req.params;

      let result;
      try {
        const r = await db.query(
          `UPDATE worksites SET active = false WHERE id = $1 RETURNING id, name`,
          [id]
        );
        result = r;
      } catch (err: any) {
        if (err.code === "42703") {
          // active column doesn't exist — fall back to hard delete
          const r = await db.query(
            `DELETE FROM worksites WHERE id = $1 RETURNING id, name`,
            [id]
          );
          result = r;
        } else {
          throw err;
        }
      }

      if (result.rowCount === 0) return res.status(404).json({ error: "Worksite not found" });
      res.json({ success: true, worksite: result.rows[0] });
    } catch (err) {
      console.error("DELETE /worksites/:id error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/**
 * POST /api/worksites/:id/assign
 * Assign an employee to a worksite.
 * Body: { employeeId: string, isDefault?: boolean }
 */
router.post(
  "/:id/assign",
  verifyJWT,
  requireRole("admin", "manager", "owner"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { id: worksiteId } = req.params;
      const { employeeId, isDefault = false } = req.body;

      if (!employeeId) return res.status(400).json({ error: "employeeId is required" });

      // If setting as default, clear existing default for this employee first
      if (isDefault) {
        await db.query(
          `UPDATE employee_worksites SET is_default = false WHERE employee_id = $1`,
          [employeeId]
        );
      }

      // Upsert — try with assigned_at, fall back without if column missing
      const tryAssign = async (includeAssignedAt: boolean) => {
        const assignedAtClause = includeAssignedAt ? ", assigned_at" : "";
        const assignedAtVal    = includeAssignedAt ? ", NOW()" : "";
        const onConflictSet    = includeAssignedAt
          ? "is_default = EXCLUDED.is_default, assigned_by = EXCLUDED.assigned_by, assigned_at = NOW()"
          : "is_default = EXCLUDED.is_default, assigned_by = EXCLUDED.assigned_by";

        return db.query(
          `INSERT INTO employee_worksites
             (employee_id, worksite_id, is_default, assigned_by${assignedAtClause})
           VALUES ($1, $2, $3, $4${assignedAtVal})
           ON CONFLICT (employee_id, worksite_id)
           DO UPDATE SET ${onConflictSet}
           RETURNING *`,
          [employeeId, worksiteId, isDefault, req.user!.id]
        );
      };

      let result;
      try {
        result = await tryAssign(true);
      } catch (err: any) {
        // assigned_at column or UNIQUE constraint doesn't exist — fallback
        if (err.code === "42703" || err.code === "42P10") {
          // No unique constraint: try plain INSERT ignore conflict
          const r = await db.query(
            `INSERT INTO employee_worksites (employee_id, worksite_id, is_default, assigned_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING
             RETURNING *`,
            [employeeId, worksiteId, isDefault, req.user!.id]
          );
          result = r;
        } else {
          throw err;
        }
      }

      res.status(201).json(result.rows[0] || { employee_id: employeeId, worksite_id: worksiteId });
    } catch (err) {
      console.error("POST /worksites/:id/assign error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/**
 * DELETE /api/worksites/:id/remove/:empId
 * Remove an employee's assignment from a worksite.
 */
router.delete(
  "/:id/remove/:empId",
  verifyJWT,
  requireRole("admin", "manager", "owner"),
  async (req: AuthRequest, res: Response) => {
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
  }
);

/**
 * PUT /api/worksites/:id/set-default/:empId
 * Set a specific worksite as the default for an employee.
 */
router.put(
  "/:id/set-default/:empId",
  verifyJWT,
  requireRole("admin", "manager", "owner"),
  async (req: AuthRequest, res: Response) => {
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

      if (rows.length === 0) {
        return res.status(404).json({ error: "Assignment not found — assign employee first" });
      }
      res.json(rows[0]);
    } catch (err) {
      console.error("PUT /worksites/:id/set-default/:empId error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

export default router;