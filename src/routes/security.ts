import { Router, Response, Request } from "express";
import { verifyJWT, AuthRequest } from "../middleware/auth";
import { db } from "../db/pool";

const router = Router();

// Update language preference
router.put("/language", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const { language } = req.body;
    if (!["en","es"].includes(language)) {
      res.status(400).json({ error: "Unsupported language." }); return;
    }
    await db.query("UPDATE users SET language=$1 WHERE id=$2", [language, req.user!.id]);
    res.json({ message: "Language updated", language });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Log unauthorized access attempt
router.post("/log-attempt", async (req: Request, res: Response) => {
  try {
    const { targetUserId, deviceFingerprint, reason } = req.body;
    const ip = req.headers["x-forwarded-for"]?.toString() || req.ip || "unknown";
    await db.query(
      `INSERT INTO security_logs (attempted_user_id, device_fingerprint, ip_address, reason)
       VALUES ($1,$2,$3,$4)`,
      [targetUserId||null, deviceFingerprint||null, ip, reason||"unauthorized_access"]
    );
    // Notify admins
    const { rows: admins } = await db.query(
      "SELECT id FROM users WHERE role IN ('admin','manager') AND status='active'"
    );
    res.json({ logged: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Check device binding
router.post("/check-device", async (req: Request, res: Response) => {
  try {
    const { userId, deviceFingerprint } = req.body;
    if (!userId || !deviceFingerprint) {
      res.json({ allowed: true }); return;
    }
    // Check if device is bound to a DIFFERENT user
    const { rows } = await db.query(
      `SELECT user_id FROM device_bindings
       WHERE device_fingerprint=$1 AND user_id!=$2
       LIMIT 1`,
      [deviceFingerprint, userId]
    );
    if (rows.length > 0) {
      const ip = req.headers["x-forwarded-for"]?.toString() || req.ip || "unknown";
      await db.query(
        `INSERT INTO security_logs (attempted_user_id, device_fingerprint, ip_address, reason)
         VALUES ($1,$2,$3,$4)`,
        [userId, deviceFingerprint, ip, "device_bound_to_different_user"]
      );
      res.json({ allowed: false, reason: "Device is registered to another account." });
      return;
    }
    // Bind device to this user
    await db.query(
      `INSERT INTO device_bindings (user_id, device_fingerprint, last_seen)
       VALUES ($1,$2,NOW())
       ON CONFLICT (user_id, device_fingerprint)
       DO UPDATE SET last_seen=NOW()`,
      [userId, deviceFingerprint]
    );
    res.json({ allowed: true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

export default router;