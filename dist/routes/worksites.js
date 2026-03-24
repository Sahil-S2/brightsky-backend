"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const pool_1 = require("../db/pool");
const router = (0, express_1.Router)();
// Get all worksites with assignment counts
router.get("/", auth_1.verifyJWT, async (req, res) => {
    try {
        const { rows } = await pool_1.db.query(`
      SELECT w.*,
        COUNT(DISTINCT ew.employee_id) as assigned_count,
        json_agg(
          json_build_object(
            'employee_id', u.id,
            'employee_name', COALESCE(u.full_name, u.name),
            'user_id', u.user_id,
            'department', ep.department,
            'designation', ep.designation,
            'is_default', ew.is_default
          )
        ) FILTER (WHERE u.id IS NOT NULL) as employees
      FROM worksites w
      LEFT JOIN employee_worksites ew ON ew.worksite_id = w.id
      LEFT JOIN users u ON u.id = ew.employee_id AND u.status = 'active'
      LEFT JOIN employee_profiles ep ON ep.user_id = u.id
      GROUP BY w.id
      ORDER BY w.name
    `);
        res.json(rows);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
// Get all assignments with full details
router.get("/assignments", auth_1.verifyJWT, (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        const { rows } = await pool_1.db.query(`
      SELECT
        w.id as worksite_id,
        COALESCE(w.project_name, w.name) as worksite_name,
        w.name as worksite_display_name,
        w.address as worksite_address,
        w.latitude, w.longitude, w.radius_feet,
        u.id as employee_id,
        COALESCE(u.full_name, u.name) as employee_name,
        u.user_id,
        ep.department, ep.designation, ep.employee_code,
        ew.is_default, ew.assigned_at
      FROM employee_worksites ew
      JOIN worksites w ON w.id = ew.worksite_id
      JOIN users u ON u.id = ew.employee_id
      LEFT JOIN employee_profiles ep ON ep.user_id = u.id
      WHERE u.status = 'active'
      ORDER BY w.name, u.name
    `);
        res.json(rows);
    }
    catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});
// Get employee's own assigned worksite
router.get("/my-assignment", auth_1.verifyJWT, async (req, res) => {
    try {
        const queries = [
            pool_1.db.query(`SELECT w.* FROM worksites w
         JOIN employee_worksites ew ON ew.worksite_id = w.id
         WHERE ew.employee_id = $1 AND ew.is_default = true LIMIT 1`, [req.user.id]),
            pool_1.db.query(`SELECT w.* FROM worksites w
         JOIN employee_worksites ew ON ew.worksite_id = w.id
         WHERE ew.employee_id = $1 LIMIT 1`, [req.user.id]),
            pool_1.db.query("SELECT * FROM worksites LIMIT 1"),
        ];
        for (const q of queries) {
            const { rows } = await q;
            if (rows.length > 0) {
                res.json(rows[0]);
                return;
            }
        }
        res.json(null);
    }
    catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});
// Create worksite
router.post("/", auth_1.verifyJWT, (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        const { name, projectName, address, latitude, longitude, radiusFeet, notes } = req.body;
        if (!name || !latitude || !longitude) {
            res.status(400).json({ error: "Name, latitude and longitude required." });
            return;
        }
        const { rows } = await pool_1.db.query(`INSERT INTO worksites (name, project_name, address, latitude, longitude, radius_feet, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [name, projectName || name, address || null, latitude, longitude, radiusFeet || 200, notes || null, req.user.id]);
        res.status(201).json(rows[0]);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
// Update worksite
router.put("/:id", auth_1.verifyJWT, (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        const { name, projectName, address, latitude, longitude, radiusFeet, notes } = req.body;
        const { rows } = await pool_1.db.query(`UPDATE worksites SET
        name=$1, project_name=$2, address=$3,
        latitude=$4, longitude=$5, radius_feet=$6,
        notes=$7, updated_at=NOW()
       WHERE id=$8 RETURNING *`, [name, projectName || name, address || null, latitude, longitude, radiusFeet || 200, notes || null, req.params.id]);
        res.json(rows[0]);
    }
    catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});
// Delete worksite
router.delete("/:id", auth_1.verifyJWT, (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        await pool_1.db.query("DELETE FROM employee_worksites WHERE worksite_id=$1", [req.params.id]);
        await pool_1.db.query("DELETE FROM worksites WHERE id=$1", [req.params.id]);
        res.json({ message: "Worksite deleted" });
    }
    catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});
// Assign employee to worksite
router.post("/:id/assign", auth_1.verifyJWT, (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        const { employeeId, isDefault } = req.body;
        if (isDefault) {
            await pool_1.db.query("UPDATE employee_worksites SET is_default=false WHERE employee_id=$1", [employeeId]);
        }
        await pool_1.db.query(`INSERT INTO employee_worksites (employee_id, worksite_id, is_default, assigned_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (employee_id, worksite_id)
       DO UPDATE SET is_default=$3, assigned_by=$4, assigned_at=NOW()`, [employeeId, req.params.id, isDefault !== false, req.user.id]);
        // Return updated worksite with assignments
        const { rows } = await pool_1.db.query(`SELECT w.*,
        COUNT(DISTINCT ew2.employee_id) as assigned_count
       FROM worksites w
       LEFT JOIN employee_worksites ew2 ON ew2.worksite_id = w.id
       WHERE w.id = $1
       GROUP BY w.id`, [req.params.id]);
        res.json({ message: "Assigned", worksite: rows[0] });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
// Remove employee from worksite
router.delete("/:id/remove/:employeeId", auth_1.verifyJWT, (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        await pool_1.db.query("DELETE FROM employee_worksites WHERE worksite_id=$1 AND employee_id=$2", [req.params.id, req.params.employeeId]);
        res.json({ message: "Removed" });
    }
    catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});
// Get unassigned employees for a worksite
router.get("/:id/unassigned", auth_1.verifyJWT, (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        const { rows } = await pool_1.db.query(`SELECT u.id, COALESCE(u.full_name,u.name) as name, u.user_id,
              ep.department, ep.designation
       FROM users u
       LEFT JOIN employee_profiles ep ON ep.user_id = u.id
       WHERE u.role = 'employee' AND u.status = 'active'
       AND u.id NOT IN (
         SELECT employee_id FROM employee_worksites WHERE worksite_id = $1
       )
       ORDER BY u.name`, [req.params.id]);
        res.json(rows);
    }
    catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});
exports.default = router;
