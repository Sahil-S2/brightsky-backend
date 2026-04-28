// =============================================================================
// src/routes/security.ts
//
// Changes from original:
//   - /log-attempt and /check-device now call notifyAdmins() so that every
//     active admin/manager actually receives an in-app alert.
//   - The fetched admin list from the old dead-code block is removed; the
//     notification service handles that query internally.
// =============================================================================

import { Router, Response, Request } from "express";
import { verifyJWT, AuthRequest } from "../middleware/auth";
import { db } from "../db/pool";
import { notifyAdmins } from "../services/notifications";

const router = Router();

// ── PUT /api/security/language ───────────────────────────────────────────────
router.put("/language", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const { language } = req.body;
    if (!["en", "es"].includes(language)) {
      res.status(400).json({ error: "Unsupported language." });
      return;
    }
    await db.query("UPDATE users SET language=$1 WHERE id=$2", [language, req.user!.id]);
    res.json({ message: "Language updated", language });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// ── POST /api/security/log-attempt ───────────────────────────────────────────
// Called by the frontend when it detects an unauthorised access attempt
// (e.g. wrong PIN entered repeatedly, locked-out account).
// Previously fetched admins but never did anything with them — now actually
// sends an in-app alert to every active admin and manager.
router.post("/log-attempt", async (req: Request, res: Response) => {
  try {
    const { targetUserId, deviceFingerprint, reason } = req.body;
    const ip =
      req.headers["x-forwarded-for"]?.toString() || req.ip || "unknown";

    await db.query(
      `INSERT INTO security_logs
         (attempted_user_id, device_fingerprint, ip_address, reason)
       VALUES ($1, $2, $3, $4)`,
      [
        targetUserId || null,
        deviceFingerprint || null,
        ip,
        reason || "unauthorized_access",
      ]
    );

    // Deliver a real alert to every admin/manager in-app.
    const reasonLabel = reason || "unauthorized_access";
    const userLabel   = targetUserId ? ` for user ID ${targetUserId}` : "";
    await notifyAdmins(
      "⚠️ Security Alert",
      `Unauthorised access attempt${userLabel}. Reason: ${reasonLabel}. IP: ${ip}`,
      "alert"
    );

    res.json({ logged: true });
  } catch (err) {
    console.error("[security] log-attempt error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ── POST /api/security/check-device ──────────────────────────────────────────
// Called at login time. If the device fingerprint is already bound to a
// *different* user account, rejects the login and alerts admins.
router.post("/check-device", async (req: Request, res: Response) => {
  try {
    const { userId, deviceFingerprint } = req.body;
    if (!userId || !deviceFingerprint) {
      res.json({ allowed: true });
      return;
    }

    // Check if the device is bound to a different user
    const { rows } = await db.query(
      `SELECT user_id FROM device_bindings
       WHERE device_fingerprint = $1 AND user_id != $2
       LIMIT 1`,
      [deviceFingerprint, userId]
    );

    if (rows.length > 0) {
      const ip =
        req.headers["x-forwarded-for"]?.toString() || req.ip || "unknown";

      await db.query(
        `INSERT INTO security_logs
           (attempted_user_id, device_fingerprint, ip_address, reason)
         VALUES ($1, $2, $3, $4)`,
        [userId, deviceFingerprint, ip, "device_bound_to_different_user"]
      );

      // Alert admins that a device is being used by the wrong account
      await notifyAdmins(
        "⚠️ Device Conflict Detected",
        `User ${userId} attempted to log in from a device already registered to another account. IP: ${ip}`,
        "alert"
      );

      res.json({
        allowed: false,
        reason: "Device is registered to another account.",
      });
      return;
    }

    // Bind (or refresh) the device → user association
    await db.query(
      `INSERT INTO device_bindings (user_id, device_fingerprint, last_seen)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, device_fingerprint)
       DO UPDATE SET last_seen = NOW()`,
      [userId, deviceFingerprint]
    );

    res.json({ allowed: true });
  } catch (err) {
    console.error("[security] check-device error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;