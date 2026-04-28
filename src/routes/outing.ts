import { Router, Response } from "express";
import { verifyJWT, requireRole, AuthRequest } from "../middleware/auth";
import { db } from "../db/pool";
import { auditLog } from "../middleware/audit";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────────────────────────────────────

/** Returns the one row for the user that has no clock_out_time, or null. */
async function getActiveOuting(userId: string) {
  const { rows } = await db.query(
    `SELECT * FROM project_outings
     WHERE user_id = $1 AND clock_out_time IS NULL
     ORDER BY clock_in_time DESC LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /outing/active  ← NEW: dedicated endpoint so the frontend doesn't need
//                         to infer active state from paginated history
// ─────────────────────────────────────────────────────────────────────────────
router.get("/outing/active", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    console.log(`[outing/active] Fetching active outing for user ${userId}`);
    const outing = await getActiveOuting(userId);
    console.log(`[outing/active] Result:`, outing ? `id=${outing.id}` : "none");
    res.json({ outing: outing || null });
  } catch (err: any) {
    console.error("[outing/active] Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /outing/start
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/outing/start",
  verifyJWT,
  auditLog("project_outing_start", "project_outings"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { latitude, longitude, remarks } = req.body;
      const userId = req.user!.id;

      console.log(`[outing/start] User ${userId} attempting to start outing`, {
        latitude,
        longitude,
        remarks,
      });

      const active = await getActiveOuting(userId);
      if (active) {
        console.warn(`[outing/start] Conflict – user ${userId} already has active outing id=${active.id}`);
        res.status(409).json({
          error: "You already have an active project outing. Please end it first.",
        });
        return;
      }

      // Store location only when both coordinates are present and valid
      const location =
        latitude != null && longitude != null && !isNaN(latitude) && !isNaN(longitude)
          ? `${latitude},${longitude}`
          : null;

      const { rows } = await db.query(
        `INSERT INTO project_outings
           (user_id, clock_in_time, clock_in_location, clock_in_remarks)
         VALUES ($1, NOW(), $2, $3)
         RETURNING *`,
        [userId, location, remarks || null]
      );

      console.log(`[outing/start] Created outing id=${rows[0].id} for user ${userId}`);
      res.status(201).json({ outing: rows[0], message: "Project task started" });
    } catch (err: any) {
      console.error("[outing/start] Error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /outing/end
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/outing/end",
  verifyJWT,
  auditLog("project_outing_end", "project_outings"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { latitude, longitude, remarks } = req.body;
      const userId = req.user!.id;

      console.log(`[outing/end] User ${userId} attempting to end outing`, {
        latitude,
        longitude,
        remarks,
      });

      const active = await getActiveOuting(userId);
      if (!active) {
        console.warn(`[outing/end] No active outing found for user ${userId}`);
        res.status(404).json({ error: "No active project outing found" });
        return;
      }

      const location =
        latitude != null && longitude != null && !isNaN(latitude) && !isNaN(longitude)
          ? `${latitude},${longitude}`
          : null;

      const clockOutTime = new Date();
      const duration = Math.round(
        (clockOutTime.getTime() - new Date(active.clock_in_time).getTime()) / 60000
      );

      const { rows } = await db.query(
        `UPDATE project_outings
         SET clock_out_time     = NOW(),
             clock_out_location = $1,
             clock_out_remarks  = $2,
             duration_minutes   = $3
         WHERE id = $4
         RETURNING *`,
        [location, remarks || null, duration, active.id]
      );

      console.log(
        `[outing/end] Ended outing id=${rows[0].id} for user ${userId}, duration=${duration}m`
      );
      res.json({ outing: rows[0], message: "Project task ended" });
    } catch (err: any) {
      console.error("[outing/end] Error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /outing/history  (employee – their own outings, paginated)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/outing/history", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { page = 1, limit = 10 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    console.log(`[outing/history] user=${userId} page=${page} limit=${limit}`);

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
    console.error("[outing/history] Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /outing/admin/history  (admin / manager – all employees, filterable)
// ─────────────────────────────────────────────────────────────────────────────
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

      const countQuery = `SELECT COUNT(*) FROM project_outings o ${whereSql}`;
      const countRes = await db.query(countQuery, params);
      const total = parseInt(countRes.rows[0].count);

      const dataQuery = `
        SELECT o.*, u.name AS user_name, u.user_id AS employee_code
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
      console.error("[outing/admin/history] Error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

export default router;