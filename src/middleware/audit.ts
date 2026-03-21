import { Response, NextFunction } from "express";
import { db } from "../db/pool";
import { AuthRequest } from "./auth";

export const auditLog = (actionType: string, entityType: string) =>
  (req: AuthRequest, res: Response, next: NextFunction) => {
    res.on("finish", async () => {
      if (res.statusCode < 400 && req.user) {
        try {
          await db.query(
            `INSERT INTO audit_logs (actor_user_id, action_type, entity_type, ip_address)
             VALUES ($1, $2, $3, $4)`,
            [req.user.id, actionType, entityType, req.ip]
          );
        } catch (err) {
          console.error("Audit log error:", err);
        }
      }
    });
    next();
  };