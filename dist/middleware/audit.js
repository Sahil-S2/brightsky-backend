"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditLog = void 0;
const pool_1 = require("../db/pool");
const auditLog = (actionType, entityType) => (req, res, next) => {
    res.on("finish", async () => {
        if (res.statusCode < 400 && req.user) {
            try {
                await pool_1.db.query(`INSERT INTO audit_logs (actor_user_id, action_type, entity_type, ip_address)
             VALUES ($1, $2, $3, $4)`, [req.user.id, actionType, entityType, req.ip]);
            }
            catch (err) {
                console.error("Audit log error:", err);
            }
        }
    });
    next();
};
exports.auditLog = auditLog;
