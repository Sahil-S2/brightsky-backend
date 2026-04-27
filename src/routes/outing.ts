import { Router, Response } from "express";
import { verifyJWT, requireRole, AuthRequest } from "../middleware/auth";
import { db } from "../db/pool";
import { auditLog } from "../middleware/audit";

const router = Router();

// Get active outing
async function getActiveOuting(userId: string) {
    const { rows } = await db.query(
        `SELECT * FROM project_outings
         WHERE user_id = $1 AND clock_out_time IS NULL
         ORDER BY clock_in_time DESC LIMIT 1`,
        [userId]
    );
    return rows[0] || null;
}

// Start project outing
router.post(
    "/outing/start",
    verifyJWT,
    auditLog("project_outing_start", "project_outings"),
    async (req: AuthRequest, res: Response) => {
        try {
            const { latitude, longitude, remarks } = req.body;
            const userId = req.user!.id;

            const active = await getActiveOuting(userId);
            if (active) {
                res.status(409).json({ error: "You already have an active project outing. Please end it first." });
                return;
            }

            const location = (latitude && longitude) ? `${latitude},${longitude}` : null;

            const { rows } = await db.query(
                `INSERT INTO project_outings
                 (user_id, clock_in_time, clock_in_location, clock_in_remarks)
                 VALUES ($1, NOW(), $2, $3)
                 RETURNING *`,
                [userId, location, remarks || null]
            );

            res.status(201).json({ outing: rows[0], message: "Project task started" });
        } catch (err: any) {
            console.error(err);
            res.status(500).json({ error: "Server error" });
        }
    }
);

// End project outing
router.post(
    "/outing/end",
    verifyJWT,
    auditLog("project_outing_end", "project_outings"),
    async (req: AuthRequest, res: Response) => {
        try {
            const { latitude, longitude, remarks } = req.body;
            const userId = req.user!.id;

            const active = await getActiveOuting(userId);
            if (!active) {
                res.status(404).json({ error: "No active project outing found" });
                return;
            }

            const location = (latitude && longitude) ? `${latitude},${longitude}` : null;
            const clockOutTime = new Date();
            const duration = Math.round((clockOutTime.getTime() - new Date(active.clock_in_time).getTime()) / 60000);

            const { rows } = await db.query(
                `UPDATE project_outings
                 SET clock_out_time = NOW(),
                     clock_out_location = $1,
                     clock_out_remarks = $2,
                     duration_minutes = $3
                 WHERE id = $4
                 RETURNING *`,
                [location, remarks || null, duration, active.id]
            );

            res.json({ outing: rows[0], message: "Project task ended" });
        } catch (err: any) {
            console.error(err);
            res.status(500).json({ error: "Server error" });
        }
    }
);

// Employee history
router.get("/outing/history", verifyJWT, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const { page = 1, limit = 10 } = req.query;
        const offset = (Number(page) - 1) * Number(limit);

        const countRes = await db.query(
            "SELECT COUNT(*) FROM project_outings WHERE user_id = $1",
            [userId]
        );
        const total = parseInt(countRes.rows[0].count);

        const { rows } = await db.query(
            `SELECT * FROM project_outings
             WHERE user_id = $1
             ORDER BY clock_in_time DESC
             LIMIT $2 OFFSET $3`,
            [userId, limit, offset]
        );

        res.json({ outings: rows, total, page: Number(page), limit: Number(limit) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});

// Admin/manager view
router.get(
    "/outing/admin/history",
    verifyJWT,
    requireRole("admin", "manager"),
    async (req: AuthRequest, res: Response) => {
        try {
            const { user_id, date_from, date_to, page = 1, limit = 20 } = req.query;
            const offset = (Number(page) - 1) * Number(limit);
            let params: any[] = [];
            let whereClauses: string[] = [];

            if (user_id) {
                params.push(user_id);
                whereClauses.push(`o.user_id = $${params.length}`);
            }
            if (date_from) {
                params.push(date_from);
                whereClauses.push(`o.clock_in_time >= $${params.length}`);
            }
            if (date_to) {
                params.push(date_to);
                whereClauses.push(`o.clock_in_time <= $${params.length}::date + interval '1 day'`);
            }

            const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";

            const countQuery = `
                SELECT COUNT(*) FROM project_outings o
                ${whereSql}
            `;
            const countRes = await db.query(countQuery, params);
            const total = parseInt(countRes.rows[0].count);

            const dataQuery = `
                SELECT o.*, u.name as user_name, u.user_id as employee_code
                FROM project_outings o
                JOIN users u ON u.id = o.user_id
                ${whereSql}
                ORDER BY o.clock_in_time DESC
                LIMIT $${params.length + 1} OFFSET $${params.length + 2}
            `;
            params.push(limit, offset);
            const { rows } = await db.query(dataQuery, params);

            res.json({ outings: rows, total, page: Number(page), limit: Number(limit) });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: "Server error" });
        }
    }
);

export default router;