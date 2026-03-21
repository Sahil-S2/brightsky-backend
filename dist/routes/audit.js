"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const pool_1 = require("../db/pool");
const router = (0, express_1.Router)();
router.get("/", auth_1.verifyJWT, (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        const { rows } = await pool_1.db.query(`SELECT al.*, u.name as actor_name FROM audit_logs al
       LEFT JOIN users u ON u.id = al.actor_user_id
       ORDER BY al.created_at DESC LIMIT 100`);
        res.json(rows);
    }
    catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});
exports.default = router;
