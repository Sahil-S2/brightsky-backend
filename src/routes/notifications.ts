// =============================================================================
// src/routes/notifications.ts
//
// Mounted in src/index.ts as:
//     app.use("/api/notifications", notificationRoutes);
//
// Endpoints:
//     GET  /api/notifications               – last 50 for the current user
//     GET  /api/notifications/unread-count  – badge count for the nav bar
//     PUT  /api/notifications/:id/read      – mark one as read
//     PUT  /api/notifications/read-all      – mark all as read
// =============================================================================

import { Router, Response } from "express";
import { verifyJWT, AuthRequest } from "../middleware/auth";
import { db } from "../db/pool";

const router = Router();

// ── GET /api/notifications ───────────────────────────────────────────────────
// Returns the 50 most recent notifications for the logged-in user,
// newest first. Includes both read and unread so the user can review history.
router.get("/", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await db.query(
      `SELECT id, title, body, type, is_read, created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user!.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[notifications] GET /:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ── GET /api/notifications/unread-count ──────────────────────────────────────
// Lightweight endpoint polled by the frontend (e.g. every 60 s) to drive
// the notification badge in the nav bar without fetching all content.
router.get("/unread-count", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS count
       FROM notifications
       WHERE user_id = $1 AND is_read = false`,
      [req.user!.id]
    );
    res.json({ count: rows[0].count });
  } catch (err) {
    console.error("[notifications] GET /unread-count:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ── PUT /api/notifications/read-all ──────────────────────────────────────────
// MUST be declared before /:id/read — Express matches routes top-to-bottom,
// so a literal path segment must come before a dynamic one.
router.put("/read-all", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    await db.query(
      `UPDATE notifications SET is_read = true
       WHERE user_id = $1 AND is_read = false`,
      [req.user!.id]
    );
    res.json({ message: "All notifications marked as read" });
  } catch (err) {
    console.error("[notifications] PUT /read-all:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ── PUT /api/notifications/:id/read ─────────────────────────────────────────
// Mark a single notification as read. The WHERE clause includes user_id so
// one user cannot mark another's notifications.
router.put("/:id/read", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const result = await db.query(
      `UPDATE notifications SET is_read = true
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user!.id]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }
    res.json({ message: "Marked as read" });
  } catch (err) {
    console.error("[notifications] PUT /:id/read:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;