// =============================================================================
// src/routes/audit.ts
//
// Changes from original:
//   - Hard-coded LIMIT 100 replaced with proper page/limit pagination.
//   - Optional filters added: ?action_type=, ?date_from=, ?date_to=
//     so admins can narrow down the log without loading everything.
//   - Response shape changed from a plain array to a paginated envelope:
//     { logs, total, page, limit, totalPages }
// =============================================================================

import { Router, Response } from "express";
import { verifyJWT, requireRole, AuthRequest } from "../middleware/auth";
import { db } from "../db/pool";

const router = Router();

// ── GET /api/audit-logs ───────────────────────────────────────────────────────
// Query params (all optional):
//   page        – 1-based page number (default 1)
//   limit       – rows per page, max 100 (default 20)
//   action_type – exact match, e.g. "clock_in", "clock_out", "break_start"
//   date_from   – ISO date string, inclusive lower bound on created_at
//   date_to     – ISO date string, inclusive upper bound on created_at
// =============================================================================
router.get(
  "/",
  verifyJWT,
  requireRole("admin", "manager"),
  async (req: AuthRequest, res: Response) => {
    try {
      const page   = Math.max(1, parseInt(req.query.page  as string) || 1);
      const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
      const offset = (page - 1) * limit;

      const { action_type, date_from, date_to } = req.query;

      // Build dynamic WHERE clause
      const filterParams: any[] = [];
      const where: string[] = [];

      if (action_type) {
        filterParams.push(action_type);
        where.push(`al.action_type = $${filterParams.length}`);
      }
      if (date_from) {
        filterParams.push(date_from);
        where.push(`al.created_at >= $${filterParams.length}::date`);
      }
      if (date_to) {
        filterParams.push(date_to);
        // Include the full end day by shifting to the start of the next day
        where.push(`al.created_at < $${filterParams.length}::date + interval '1 day'`);
      }

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      // Total count (drives page controls in the frontend)
      const { rows: countRows } = await db.query(
        `SELECT COUNT(*)::int AS total FROM audit_logs al ${whereSql}`,
        filterParams
      );
      const total = countRows[0].total;

      // Paginated data
      const { rows } = await db.query(
        `SELECT
           al.id,
           al.actor_user_id,
           al.action_type,
           al.entity_type,
           al.ip_address,
           al.created_at,
           u.name AS actor_name
         FROM audit_logs al
         LEFT JOIN users u ON u.id = al.actor_user_id
         ${whereSql}
         ORDER BY al.created_at DESC
         LIMIT  $${filterParams.length + 1}
         OFFSET $${filterParams.length + 2}`,
        [...filterParams, limit, offset]
      );

      res.json({
        logs:       rows,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) {
      console.error("[audit] GET /:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

export default router;