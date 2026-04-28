// =============================================================================
// src/services/notifications.ts
//
// Lightweight helper used by any route or service that needs to deliver an
// in-app notification to one or more users.
//
// Notifications are stored in the `notifications` table (see migration).
// The admin/manager frontend polls GET /api/notifications/unread-count every
// 60 s and fetches the full list on demand — no WebSocket required.
// =============================================================================

import { db } from "../db/pool";

export type NotificationType = "info" | "warning" | "alert";

/**
 * Insert a single notification for one user.
 * Fire-and-forget safe — errors are logged but never re-thrown so that a
 * failed notification never blocks the main request flow.
 */
export async function createNotification(
  userId: string,
  title: string,
  body: string,
  type: NotificationType = "info"
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO notifications (user_id, title, body, type)
       VALUES ($1, $2, $3, $4)`,
      [userId, title, body, type]
    );
  } catch (err) {
    console.error("[notifications] Failed to create notification:", err);
  }
}

/**
 * Broadcast the same notification to every active admin and manager.
 * Used for system-wide alerts (security events, auto-corrections, etc.).
 */
export async function notifyAdmins(
  title: string,
  body: string,
  type: NotificationType = "alert"
): Promise<void> {
  try {
    const { rows: admins } = await db.query(
      `SELECT id FROM users
       WHERE role IN ('admin', 'manager') AND status = 'active'`
    );

    if (!admins.length) return;

    // Build a single multi-row INSERT for efficiency instead of N round-trips
    const values: any[] = [];
    const placeholders = admins.map((admin, i) => {
      const base = i * 4;
      values.push(admin.id, title, body, type);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    });

    await db.query(
      `INSERT INTO notifications (user_id, title, body, type)
       VALUES ${placeholders.join(", ")}`,
      values
    );
  } catch (err) {
    console.error("[notifications] Failed to notify admins:", err);
  }
}