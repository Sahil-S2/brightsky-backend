import { Router, Response } from "express";
import { verifyJWT, AuthRequest } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { assertOnSite, getSiteSettings } from "../services/geofence";
import {
  getEmployeeStatus,
  getOrCreateSession,
  recordPunch,
} from "../services/attendance";
import { db } from "../db/pool";

const router = Router();

router.post(
  "/clock-in",
  verifyJWT,
  auditLog("clock_in", "attendance_sessions"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { latitude, longitude } = req.body;
      await assertOnSite(req.user!.id, latitude, longitude);
      const session = await getOrCreateSession(req.user!.id);
      await recordPunch(req.user!.id, session.id, "clock_in", {
        lat: latitude, lon: longitude, source: "manual",
      });
      res.json({ message: "Clocked in successfully" });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message || "Server error" });
    }
  }
);

router.post(
  "/clock-out",
  verifyJWT,
  auditLog("clock_out", "attendance_sessions"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { latitude, longitude } = req.body;
      await assertOnSite(req.user!.id, latitude, longitude);
      const session = await getOrCreateSession(req.user!.id);
      await recordPunch(req.user!.id, session.id, "clock_out", {
        lat: latitude, lon: longitude, source: "manual",
      });
      res.json({ message: "Clocked out successfully" });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message || "Server error" });
    }
  }
);

router.post(
  "/break-start",
  verifyJWT,
  auditLog("break_start", "attendance_sessions"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { latitude, longitude } = req.body;
      await assertOnSite(req.user!.id, latitude, longitude);
      const session = await getOrCreateSession(req.user!.id);
      await recordPunch(req.user!.id, session.id, "break_start", {
        lat: latitude, lon: longitude, source: "manual",
      });
      res.json({ message: "Break started" });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message || "Server error" });
    }
  }
);

router.post(
  "/break-end",
  verifyJWT,
  auditLog("break_end", "attendance_sessions"),
  async (req: AuthRequest, res: Response) => {
    try {
      const { latitude, longitude } = req.body;
      await assertOnSite(req.user!.id, latitude, longitude);
      const session = await getOrCreateSession(req.user!.id);
      await recordPunch(req.user!.id, session.id, "break_end", {
        lat: latitude, lon: longitude, source: "manual",
      });
      res.json({ message: "Break ended" });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message || "Server error" });
    }
  }
);

router.post(
  "/heartbeat",
  verifyJWT,
  async (req: AuthRequest, res: Response) => {
    try {
      const { latitude, longitude } = req.body;
      const settings = await getSiteSettings();
      const { distanceFeet } = await import("../services/geofence");
      const dist = distanceFeet(latitude, longitude, settings.latitude, settings.longitude);
      const onSite = dist <= settings.radius_feet;
      const status = await getEmployeeStatus(req.user!.id);

      if (!onSite && status === "clocked_in" && settings.auto_break_on_exit_enabled) {
        const session = await getOrCreateSession(req.user!.id);
        await recordPunch(req.user!.id, session.id, "break_start", {
          lat: latitude, lon: longitude, source: "auto",
          remarks: "Auto break — left geofence",
        });
      }

      res.json({ onSite, distanceFt: Math.round(dist), status: await getEmployeeStatus(req.user!.id) });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message || "Server error" });
    }
  }
);

router.get("/me/today", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { rows: sessions } = await db.query(
      `SELECT * FROM attendance_sessions WHERE user_id = $1 AND work_date = $2`,
      [req.user!.id, today]
    );
    const session = sessions[0] || null;
    let punches = [];
    if (session) {
      const { rows } = await db.query(
        `SELECT * FROM punch_records WHERE session_id = $1 ORDER BY punch_time ASC`,
        [session.id]
      );
      punches = rows;
    }
    const status = await getEmployeeStatus(req.user!.id);
    res.json({ session, punches, status });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/me/summary", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await db.query(
      `SELECT
         COUNT(*) as total_sessions,
         COALESCE(SUM(worked_minutes), 0) as total_minutes,
         COALESCE(AVG(worked_minutes), 0) as avg_daily_minutes,
         COALESCE(SUM(CASE WHEN work_date >= CURRENT_DATE - 6 THEN worked_minutes ELSE 0 END), 0) as week_minutes
       FROM attendance_sessions
       WHERE user_id = $1`,
      [req.user!.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/me", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM attendance_sessions
       WHERE user_id = $1
       ORDER BY work_date DESC LIMIT 30`,
      [req.user!.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

export default router;