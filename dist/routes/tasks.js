"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const pool_1 = require("../db/pool");
const router = (0, express_1.Router)();
// Get tasks for a specific employee (employee or admin/manager can view)
router.get("/employee/:employeeId", auth_1.verifyJWT, async (req, res) => {
    try {
        const { employeeId } = req.params;
        // Only allow if user is admin/manager or the employee themselves
        if (req.user.role !== "admin" && req.user.role !== "manager" && req.user.id !== employeeId) {
            res.status(403).json({ error: "Unauthorized" });
            return;
        }
        const { rows } = await pool_1.db.query(`SELECT id, title, description, status, due_date, created_at
       FROM tasks
       WHERE assigned_to = $1
       ORDER BY created_at DESC`, [employeeId]);
        res.json(rows);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
// Mark a task as completed (employee does this)
router.put("/:taskId/complete", auth_1.verifyJWT, async (req, res) => {
    try {
        const { taskId } = req.params;
        // Fetch task to check permissions
        const { rows: taskRows } = await pool_1.db.query(`SELECT assigned_to FROM tasks WHERE id = $1`, [taskId]);
        if (taskRows.length === 0) {
            res.status(404).json({ error: "Task not found" });
            return;
        }
        const task = taskRows[0];
        // Allow employee who owns the task, admin, or manager
        if (req.user.role !== "admin" && req.user.role !== "manager" && task.assigned_to !== req.user.id) {
            res.status(403).json({ error: "Unauthorized" });
            return;
        }
        await pool_1.db.query(`UPDATE tasks SET status = 'completed', updated_at = NOW() WHERE id = $1`, [taskId]);
        res.json({ message: "Task marked completed" });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
exports.default = router;
