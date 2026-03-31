"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const pool_1 = require("../db/pool");
const router = (0, express_1.Router)();
// All routes require authentication
router.use(auth_1.verifyJWT);
// Admin/Manager: get all tasks (with optional filters)
router.get("/", (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        const { employee_id, status } = req.query;
        let query = `
      SELECT t.*, 
             u1.name as assigned_to_name, u1.user_id as assigned_to_user_id,
             u2.name as assigned_by_name
      FROM tasks t
      JOIN users u1 ON u1.id = t.assigned_to
      JOIN users u2 ON u2.id = t.assigned_by
      WHERE 1=1
    `;
        const params = [];
        if (employee_id) {
            params.push(employee_id);
            query += ` AND t.assigned_to = $${params.length}`;
        }
        if (status) {
            params.push(status);
            query += ` AND t.status = $${params.length}`;
        }
        query += ` ORDER BY t.assigned_date DESC`;
        const { rows } = await pool_1.db.query(query, params);
        res.json(rows);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
// Admin/Manager: create a new task
router.post("/", (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        const { title, description, taskType, url, assignedTo, dueDate } = req.body;
        if (!title || !assignedTo) {
            res.status(400).json({ error: "Title and assigned employee are required" });
            return;
        }
        const due = dueDate ? new Date(dueDate) : null;
        const { rows } = await pool_1.db.query(`INSERT INTO tasks (title, description, task_type, url, assigned_to, assigned_by, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [title, description, taskType, url, assignedTo, req.user.id, due]);
        res.status(201).json(rows[0]);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
// Update task (admin/manager) – e.g., edit task details
router.put("/:id", (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, taskType, url, assignedTo, dueDate } = req.body;
        const due = dueDate ? new Date(dueDate) : null;
        const { rows } = await pool_1.db.query(`UPDATE tasks 
       SET title = $1, description = $2, task_type = $3, url = $4, assigned_to = $5, due_date = $6, updated_at = NOW()
       WHERE id = $7 RETURNING *`, [title, description, taskType, url, assignedTo, due, id]);
        if (rows.length === 0) {
            res.status(404).json({ error: "Task not found" });
            return;
        }
        res.json(rows[0]);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
// Delete task (admin/manager)
router.delete("/:id", (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        const { id } = req.params;
        await pool_1.db.query("DELETE FROM tasks WHERE id = $1", [id]);
        res.json({ message: "Task deleted" });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
// Employee: get their own tasks (with pagination)
router.get("/employee/:employeeId", async (req, res) => {
    try {
        const { employeeId } = req.params;
        const { page = 1, limit = 5, status } = req.query;
        const offset = (Number(page) - 1) * Number(limit);
        const params = [employeeId];
        let whereClause = "assigned_to = $1";
        if (status) {
            params.push(status);
            whereClause += ` AND status = $${params.length}`;
        }
        const countQuery = `SELECT COUNT(*) FROM tasks WHERE ${whereClause}`;
        const { rows: countRows } = await pool_1.db.query(countQuery, params);
        const total = parseInt(countRows[0].count);
        const query = `
      SELECT * FROM tasks
      WHERE ${whereClause}
      ORDER BY assigned_date DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
        const dataParams = [...params, Number(limit), offset];
        const { rows } = await pool_1.db.query(query, dataParams);
        res.json({ tasks: rows, total, page: Number(page), limit: Number(limit) });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
// Employee: mark task as complete or incomplete
router.put("/:id/status", async (req, res) => {
    try {
        const { id } = req.params;
        const { status, incompleteReason } = req.body;
        if (!status || !["completed", "incomplete"].includes(status)) {
            res.status(400).json({ error: "Invalid status. Must be 'completed' or 'incomplete'" });
            return;
        }
        let query = `UPDATE tasks SET status = $1, updated_at = NOW()`;
        const params = [status];
        if (status === "completed") {
            query += `, completion_date = NOW()`;
        }
        else if (status === "incomplete" && incompleteReason) {
            params.push(incompleteReason);
            query += `, incomplete_reason = $${params.length}`;
        }
        query += ` WHERE id = $${params.length + 1} AND assigned_to = $2`;
        params.push(req.user.id);
        await pool_1.db.query(query, params);
        res.json({ message: "Task status updated" });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
exports.default = router;
