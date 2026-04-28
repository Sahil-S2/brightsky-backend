// =============================================================================
// routes/outing.ts — "Start Project Task" feature (production-hardened)
// =============================================================================
// Mounted in src/index.ts as:
//     app.use("/api/attendance", outingRoutes);
//
// Effective endpoints:
//     GET   /api/attendance/outing/active
//     POST  /api/attendance/outing/start
//     POST  /api/attendance/outing/end
//     GET   /api/attendance/outing/history
//     GET   /api/attendance/outing/admin/history   (admin/manager only)
//
// Requires the project_outings table — see migrations/2026-04-28-create-project-outings.sql
// =============================================================================

import { Router, Response } from "express";
import { verifyJWT, requireRole, AuthRequest } from "../middleware/auth";
import { db } from "../db/pool";
import { auditLog } from "../middleware/audit";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Returns the one row for the user that has no clock_out_time, or null. */
async function getActiveOuting(userId: string) {
  const { rows } = await db.query(
    `SELECT * FROM project_outings
      WHERE user_id = $1 AND clock_out_time IS NULL
      ORDER BY clock_in_time DESC
      LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

/** Sanitise lat/lon coming in from the browser. Returns "lat,lon" or null. */
function buildLocation(latitude: unknown, longitude: unknown): string | null {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (
    latitude == null || longitude == null ||
    Number.isNaN(lat) || Number.isNaN(lon) ||
    lat < -90 || lat > 90 ||
    lon < -180 || lon > 180
  ) {
    return null;
  }
  // 6 decimals ≈ 11 cm of precision — plenty, and avoids logging huge floats.
  return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

/** Trim/cap free-text remarks so a malicious client can't store novels. */
function cleanRemarks(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 500);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /outing/active
// ─────────────────────────────────────────────────────────────────────────────
router.get("/outing/active", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const outing = await getActiveOuting(userId);
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
      const userId = req.user!.id;
      const location = buildLocation(req.body?.latitude, req.body?.longitude);
      const remarks  = cleanRemarks(req.body?.remarks);

      console.log(`[outing/start] user=${userId} loc=${location ?? "n/a"}`);

      // Defensive check — the unique partial index will also enforce this,
      // but returning a friendly 409 is nicer than a Postgres constraint error.
      const active = await getActiveOuting(userId);
      if (active) {
        return res.status(409).json({
          error: "You already have an active project task. Please end it first.",
          outing: active,
        });
      }

      const { rows } = await db.query(
        `INSERT INTO project_outings
            (user_id, clock_in_time, clock_in_location, clock_in_remarks)
         VALUES ($1, NOW(), $2, $3)
         RETURNING *`,
        [userId, location, remarks]
      );

      console.log(`[outing/start] created id=${rows[0].id}`);
      res.status(201).json({ outing: rows[0], message: "Project task started" });
    } catch (err: any) {
      // 23505 = unique_violation — race condition on the partial unique index.
      if (err?.code === "23505") {
        const active = await getActiveOuting(req.user!.id);
        return res.status(409).json({
          error: "You already have an active project task.",
          outing: active,
        });
      }
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
      const userId = req.user!.id;
      const location = buildLocation(req.body?.latitude, req.body?.longitude);
      const remarks  = cleanRemarks(req.body?.remarks);

      const active = await getActiveOuting(userId);
      if (!active) {
        return res.status(404).json({ error: "No active project task found" });
      }

      // Compute duration from clock_in stored on the row, using the SAME NOW()
      // expression in the UPDATE so the saved duration is always consistent
      // with the saved clock_out_time (no drift from JS Date arithmetic).
      const { rows } = await db.query(
        `UPDATE project_outings
            SET clock_out_time     = NOW(),
                clock_out_location = $1,
                clock_out_remarks  = $2,
                duration_minutes   = GREATEST(
                    1,
                    CEIL(EXTRACT(EPOCH FROM (NOW() - clock_in_time)) / 60)::int
                )
          WHERE id = $3
          RETURNING *`,
        [location, remarks, active.id]
      );

      console.log(
        `[outing/end] ended id=${rows[0].id} duration=${rows[0].duration_minutes}m`
      );
      res.json({ outing: rows[0], message: "Project task ended" });
    } catch (err: any) {
      console.error("[outing/end] Error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /outing/history (employee — own outings, paginated)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/outing/history", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const page  = Math.max(1, Number(req.query.page)  || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const offset = (page - 1) * limit;

    const countRes = await db.query(
      "SELECT COUNT(*)::int AS total FROM project_outings WHERE user_id = $1",
      [userId]
    );
    const total = countRes.rows[0].total;

    const { rows } = await db.query(
      `SELECT * FROM project_outings
        WHERE user_id = $1
        ORDER BY clock_in_time DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    res.json({ outings: rows, total, page, limit });
  } catch (err) {
    console.error("[outing/history] Error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /outing/admin/history (admin / manager — all employees, filterable)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/outing/admin/history",
  verifyJWT,
  requireRole("admin", "manager"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { user_id, date_from, date_to } = req.query;
      const page  = Math.max(1, Number(req.query.page)  || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const offset = (page - 1) * limit;

      const params: any[] = [];
      const where: string[] = [];

      if (user_id)  { params.push(user_id);  where.push(`o.user_id = $${params.length}`); }
      if (date_from){ params.push(date_from);where.push(`o.clock_in_time >= $${params.length}`); }
      if (date_to)  { params.push(date_to);  where.push(`o.clock_in_time <= $${params.length}::date + interval '1 day'`); }

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const countRes = await db.query(
        `SELECT COUNT(*)::int AS total FROM project_outings o ${whereSql}`,
        params
      );
      const total = countRes.rows[0].total;

      const { rows } = await db.query(
        `SELECT o.*, u.name AS user_name, u.user_id AS employee_code
           FROM project_outings o
           JOIN users u ON u.id = o.user_id
           ${whereSql}
          ORDER BY o.clock_in_time DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );

      res.json({ outings: rows, total, page, limit });
    } catch (err) {
      console.error("[outing/admin/history] Error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

export default router;