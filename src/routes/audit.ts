import { Router, Response } from "express";
import { verifyJWT, requireRole, AuthRequest } from "../middleware/auth";
import { db } from "../db/pool";

const router = Router();

router.get("/", verifyJWT, requireRole("admin","manager"), async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await db.query(
      `SELECT al.*, u.name as actor_name FROM audit_logs al
       LEFT JOIN users u ON u.id = al.actor_user_id
       ORDER BY al.created_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

export default router;