"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const pool_1 = require("../db/pool");
const router = (0, express_1.Router)();
// Helper: get or create today's route for the user
async function getOrCreateRoute(userId) {
    const today = new Date().toISOString().slice(0, 10);
    const { rows: existing } = await pool_1.db.query("SELECT * FROM routes WHERE user_id = $1 AND route_date = $2", [userId, today]);
    if (existing.length)
        return existing[0];
    const { rows: newRoute } = await pool_1.db.query(`INSERT INTO routes (user_id, route_date, status)
     VALUES ($1, $2, 'active') RETURNING *`, [userId, today]);
    return newRoute[0];
}
// GET /api/route/today – fetch today's route and its stops
router.get("/today", auth_1.verifyJWT, async (req, res) => {
    try {
        const route = await getOrCreateRoute(req.user.id);
        const { rows: stops } = await pool_1.db.query("SELECT * FROM route_stops WHERE route_id = $1 ORDER BY stop_number ASC", [route.id]);
        res.json({ route, stops });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
// POST /api/route/start-stop – start a new stop
router.post("/start-stop", auth_1.verifyJWT, async (req, res) => {
    try {
        const route = await getOrCreateRoute(req.user.id);
        // Get the next stop number
        const { rows: lastStop } = await pool_1.db.query("SELECT stop_number FROM route_stops WHERE route_id = $1 ORDER BY stop_number DESC LIMIT 1", [route.id]);
        const nextNumber = (lastStop[0]?.stop_number || 0) + 1;
        const { rows: newStop } = await pool_1.db.query(`INSERT INTO route_stops (route_id, stop_number, start_time)
       VALUES ($1, $2, NOW()) RETURNING *`, [route.id, nextNumber]);
        res.json(newStop[0]);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
// PUT /api/route/stop/:id – end a stop (calculate travel, distance, etc.)
router.put("/stop/:id", auth_1.verifyJWT, async (req, res) => {
    try {
        const { id } = req.params;
        const { distanceMiles, timeAtStoreMinutes, routeRemarks } = req.body;
        const { rows: stopRows } = await pool_1.db.query("SELECT * FROM route_stops WHERE id = $1", [id]);
        if (!stopRows.length) {
            res.status(404).json({ error: "Stop not found" });
            return;
        }
        const stop = stopRows[0];
        // Calculate travel time (now - start_time)
        const start = new Date(stop.start_time);
        const end = new Date();
        const travelMinutes = Math.round((end.getTime() - start.getTime()) / 60000);
        const avgMph = distanceMiles ? (distanceMiles / (travelMinutes / 60)) : null;
        await pool_1.db.query(`UPDATE route_stops
       SET end_time = NOW(),
           travel_time_minutes = $1,
           distance_miles = $2,
           avg_mph = $3,
           time_at_store_minutes = $4,
           route_remarks = $5
       WHERE id = $6`, [travelMinutes, distanceMiles, avgMph, timeAtStoreMinutes, routeRemarks, id]);
        res.json({ message: "Stop updated" });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
// POST /api/route/stop/:id/details – save store details
router.post("/stop/:id/details", auth_1.verifyJWT, async (req, res) => {
    try {
        const { id } = req.params;
        const { storeName, orderAmount, deliveryAmount, productPriceRemark, storeRemark, nextSchedule } = req.body;
        // Check uniqueness of store name for this user's route
        if (storeName) {
            const { rows: existing } = await pool_1.db.query(`SELECT s.id FROM route_stops s
         JOIN routes r ON r.id = s.route_id
         WHERE r.user_id = $1 AND r.route_date = CURRENT_DATE
           AND s.store_name = $2 AND s.id != $3`, [req.user.id, storeName, id]);
            if (existing.length) {
                res.status(400).json({ error: "Store name already used today" });
                return;
            }
        }
        await pool_1.db.query(`UPDATE route_stops
       SET store_name = $1,
           order_amount = $2,
           delivery_amount = $3,
           product_price_remark = $4,
           store_remark = $5,
           next_schedule = $6
       WHERE id = $7`, [storeName, orderAmount, deliveryAmount, productPriceRemark, storeRemark, nextSchedule, id]);
        res.json({ message: "Details saved" });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
// Break endpoints
router.post("/break/start", auth_1.verifyJWT, async (req, res) => {
    try {
        const { breakType, remarks, stopId } = req.body;
        const route = await getOrCreateRoute(req.user.id);
        const { rows: newBreak } = await pool_1.db.query(`INSERT INTO route_breaks (route_id, stop_id, break_start, break_type, remarks)
       VALUES ($1, $2, NOW(), $3, $4) RETURNING *`, [route.id, stopId || null, breakType, remarks]);
        res.json(newBreak[0]);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
router.post("/break/end", auth_1.verifyJWT, async (req, res) => {
    try {
        const { breakId } = req.body;
        const { rows: updated } = await pool_1.db.query(`UPDATE route_breaks SET break_end = NOW() WHERE id = $1 RETURNING *`, [breakId]);
        if (!updated.length) {
            res.status(404).json({ error: "Break not found" });
            return;
        }
        // Optionally mark the related stop's breaks_taken = true
        if (updated[0].stop_id) {
            await pool_1.db.query(`UPDATE route_stops SET breaks_taken = true WHERE id = $1`, [updated[0].stop_id]);
        }
        res.json({ message: "Break ended" });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
// Manager/admin view: fetch route history
router.get("/history", auth_1.verifyJWT, (0, auth_1.requireRole)("admin", "manager"), async (req, res) => {
    try {
        const { user_id, date_from, date_to } = req.query;
        let query = `
      SELECT r.id, r.user_id, r.route_date, r.status,
             u.name as user_name,
             COUNT(DISTINCT rs.id) as total_stops,
             COALESCE(SUM(rs.travel_time_minutes), 0) as total_travel,
             COALESCE(SUM(rs.time_at_store_minutes), 0) as total_store_time,
             COALESCE(SUM(rs.distance_miles), 0) as total_distance,
             COALESCE(COUNT(DISTINCT rb.id), 0) as total_breaks
      FROM routes r
      JOIN users u ON u.id = r.user_id
      LEFT JOIN route_stops rs ON rs.route_id = r.id
      LEFT JOIN route_breaks rb ON rb.route_id = r.id
      WHERE 1=1
    `;
        const params = [];
        if (user_id) {
            params.push(user_id);
            query += ` AND r.user_id = $${params.length}`;
        }
        if (date_from) {
            params.push(date_from);
            query += ` AND r.route_date >= $${params.length}`;
        }
        if (date_to) {
            params.push(date_to);
            query += ` AND r.route_date <= $${params.length}`;
        }
        query += ` GROUP BY r.id, u.name ORDER BY r.route_date DESC`;
        const { rows } = await pool_1.db.query(query, params);
        res.json(rows);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
router.get("/active-break", auth_1.verifyJWT, async (req, res) => {
    try {
        const route = await getOrCreateRoute(req.user.id);
        const { rows } = await pool_1.db.query(`SELECT * FROM route_breaks
       WHERE route_id = $1 AND break_end IS NULL
       ORDER BY break_start DESC LIMIT 1`, [route.id]);
        res.json({ break: rows[0] || null });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
exports.default = router;
