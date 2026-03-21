"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const pool_1 = require("../db/pool");
const router = (0, express_1.Router)();
// Get all worksites (admin/manager)
router.get("/", auth_1.verifyJWT, async (req, res) => {
    try {
        const { rows } = await pool_1.db.query(`SELECT w.*, 
        COUNT(ew.employee_id) as assigned_count
       FROM worksites w
       LEFT JOIN employee_worksites ew ON ew.worksite_id = w.id
       GROUP BY w.id ORDER BY w.name`);
        res.json(rows);
    }
    catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});
// Create worksite
router.post("/", auth_1.verifyJWT, (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        const { name, latitude, longitude, radiusFeet, notes } = req.body;
        if (!name || !latitude || !longitude) {
            res.status(400).json({ error: "Name, latitude and longitude required." });
            return;
        }
        const { rows } = await pool_1.db.query(`INSERT INTO worksites (name, latitude, longitude, radius_feet, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, [name, latitude, longitude, radiusFeet || 200, notes || null, req.user.id]);
        res.status(201).json(rows[0]);
    }
    catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});
// Update worksite
router.put("/:id", auth_1.verifyJWT, (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        const { name, latitude, longitude, radiusFeet, notes } = req.body;
        const { rows } = await pool_1.db.query(`UPDATE worksites SET name=$1, latitude=$2, longitude=$3, 
       radius_feet=$4, notes=$5, updated_at=NOW()
       WHERE id=$6 RETURNING *`, [name, latitude, longitude, radiusFeet || 200, notes || null, req.params.id]);
        res.json(rows[0]);
    }
    catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});
// Delete worksite
router.delete("/:id", auth_1.verifyJWT, (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        await pool_1.db.query("DELETE FROM worksites WHERE id = $1", [req.params.id]);
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
            await pool_1.db.query("UPDATE employee_worksites SET is_default = false WHERE employee_id = $1", [employeeId]);
        }
        await pool_1.db.query(`INSERT INTO employee_worksites (employee_id, worksite_id, is_default, assigned_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (employee_id, worksite_id) 
       DO UPDATE SET is_default = $3, assigned_by = $4, assigned_at = NOW()`, [employeeId, req.params.id, isDefault || false, req.user.id]);
        res.json({ message: "Employee assigned to worksite" });
    }
    catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});
// Remove employee from worksite
router.delete("/:id/remove/:employeeId", auth_1.verifyJWT, (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        await pool_1.db.query("DELETE FROM employee_worksites WHERE worksite_id = $1 AND employee_id = $2", [req.params.id, req.params.employeeId]);
        res.json({ message: "Employee removed from worksite" });
    }
    catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});
// Get employees assigned to worksite
router.get("/:id/employees", auth_1.verifyJWT, (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        const { rows } = await pool_1.db.query(`SELECT u.id, u.name, u.full_name, u.user_id, u.role,
              ew.is_default, ew.assigned_at
       FROM employee_worksites ew
       JOIN users u ON u.id = ew.employee_id
       WHERE ew.worksite_id = $1`, [req.params.id]);
        res.json(rows);
    }
    catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});
exports.default = router;
