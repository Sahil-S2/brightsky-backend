"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const audit_1 = require("../middleware/audit");
const geofence_1 = require("../services/geofence");
const attendance_1 = require("../services/attendance");
const pool_1 = require("../db/pool");
const router = (0, express_1.Router)();
router.post("/clock-in", auth_1.verifyJWT, (0, audit_1.auditLog)("clock_in", "attendance_sessions"), async (req, res) => {
    try {
        // Check if already clocked out today
        const { rows: completed } = await pool_1.db.query(`SELECT id FROM attendance_sessions 
         WHERE user_id = $1 AND work_date = CURRENT_DATE AND status = 'completed'`, [req.user.id]);
        if (completed.length > 0) {
            res.status(409).json({ error: "You have already clocked out today. Cannot clock in again." });
            return;
        }
        const { latitude, longitude, photo } = req.body;
        await (0, geofence_1.assertOnSite)(req.user.id, latitude, longitude);
        const session = await (0, attendance_1.getOrCreateSession)(req.user.id);
        await (0, attendance_1.recordPunch)(req.user.id, session.id, "clock_in", {
            lat: latitude,
            lon: longitude,
            source: "manual",
            remarks: "",
            photoData: photo,
        });
        const data = await (0, attendance_1.getSessionData)(req.user.id);
        res.json({ message: "Clocked in successfully", data });
    }
    catch (err) {
        res.status(err.status || 500).json({ error: err.message || "Server error" });
    }
});
router.post("/clock-out", auth_1.verifyJWT, (0, audit_1.auditLog)("clock_out", "attendance_sessions"), async (req, res) => {
    try {
        const { latitude, longitude } = req.body;
        await (0, geofence_1.assertOnSite)(req.user.id, latitude, longitude);
        const session = await (0, attendance_1.getOrCreateSession)(req.user.id);
        await (0, attendance_1.recordPunch)(req.user.id, session.id, "clock_out", {
            lat: latitude, lon: longitude, source: "manual",
        });
        const data = await (0, attendance_1.getSessionData)(req.user.id);
        res.json({ message: "Clocked out successfully", data });
    }
    catch (err) {
        res.status(err.status || 500).json({ error: err.message || "Server error" });
    }
});
router.post("/break-start", auth_1.verifyJWT, (0, audit_1.auditLog)("break_start", "attendance_sessions"), async (req, res) => {
    try {
        const { latitude, longitude, reason } = req.body;
        // No on‑site check – personal break allowed anywhere
        const session = await (0, attendance_1.getOrCreateSession)(req.user.id);
        await (0, attendance_1.recordPunch)(req.user.id, session.id, "break_start", {
            lat: latitude,
            lon: longitude,
            source: "manual",
            remarks: reason || "Personal break",
            breakType: "personal",
        });
        const data = await (0, attendance_1.getSessionData)(req.user.id);
        res.json({ message: "Personal break started.", data });
    }
    catch (err) {
        res.status(err.status || 500).json({ error: err.message || "Server error" });
    }
});
router.post("/custom-break-start", auth_1.verifyJWT, (0, audit_1.auditLog)("break_start", "attendance_sessions"), async (req, res) => {
    try {
        const { latitude, longitude, reason } = req.body;
        if (!reason?.trim()) {
            res.status(400).json({ error: "Break reason is required." });
            return;
        }
        const session = await (0, attendance_1.getOrCreateSession)(req.user.id);
        await (0, attendance_1.recordPunch)(req.user.id, session.id, "break_start", {
            lat: latitude,
            lon: longitude,
            source: "manual",
            remarks: reason,
            breakType: "work",
        });
        const data = await (0, attendance_1.getSessionData)(req.user.id);
        res.json({ message: "Work-related break started", data });
    }
    catch (err) {
        res.status(err.status || 500).json({ error: err.message || "Server error" });
    }
});
router.post("/break-end", auth_1.verifyJWT, (0, audit_1.auditLog)("break_end", "attendance_sessions"), async (req, res) => {
    try {
        const { latitude, longitude } = req.body;
        await (0, geofence_1.assertOnSite)(req.user.id, latitude, longitude);
        const session = await (0, attendance_1.getOrCreateSession)(req.user.id);
        await (0, attendance_1.recordPunch)(req.user.id, session.id, "break_end", {
            lat: latitude, lon: longitude, source: "manual",
        });
        const data = await (0, attendance_1.getSessionData)(req.user.id);
        res.json({ message: "Break ended", data });
    }
    catch (err) {
        res.status(err.status || 500).json({ error: err.message || "Server error" });
    }
});
router.post("/heartbeat", auth_1.verifyJWT, async (req, res) => {
    try {
        const { latitude, longitude } = req.body;
        const settings = await (0, geofence_1.getSiteSettings)();
        const { distanceFeet } = await Promise.resolve().then(() => __importStar(require("../services/geofence")));
        const dist = distanceFeet(latitude, longitude, settings.latitude, settings.longitude);
        const onSite = dist <= settings.radius_feet;
        let status = await (0, attendance_1.getEmployeeStatus)(req.user.id);
        const session = await (0, attendance_1.getOrCreateSession)(req.user.id);
        // Auto start personal break when leaving geofence
        if (!onSite && status === "clocked_in" && settings.auto_break_on_exit_enabled) {
            await (0, attendance_1.recordPunch)(req.user.id, session.id, "break_start", {
                lat: latitude, lon: longitude, source: "auto",
                remarks: "Auto break — left geofence",
                breakType: "personal",
            });
            status = await (0, attendance_1.getEmployeeStatus)(req.user.id);
        }
        // Auto end personal break when re‑entering geofence
        if (onSite && status === "on_break") {
            const lastPunch = await (0, attendance_1.getLastPunch)(req.user.id, session.id);
            if (lastPunch?.break_type === "personal") {
                await (0, attendance_1.recordPunch)(req.user.id, session.id, "break_end", {
                    lat: latitude, lon: longitude, source: "auto",
                    remarks: "Auto break end — re-entered geofence",
                });
                status = await (0, attendance_1.getEmployeeStatus)(req.user.id);
            }
        }
        // Auto clock‑out after shift end if outside geofence
        if (status === "clocked_in" && session && !session.clock_out_time) {
            const schedule = await (0, attendance_1.getEffectiveSchedule)(req.user.id);
            const now = new Date();
            const [endH, endM] = schedule.end.split(':').map(Number);
            const scheduledEnd = new Date(now);
            scheduledEnd.setHours(endH, endM, 0, 0);
            // If schedule crosses midnight, adjust scheduledEnd to next day
            if (schedule.crossesMidnight && (endH < parseInt(schedule.start.split(':')[0]))) {
                scheduledEnd.setDate(scheduledEnd.getDate() + 1);
            }
            const afterShiftEnd = now > scheduledEnd;
            if (afterShiftEnd && !onSite) {
                await (0, attendance_1.recordPunch)(req.user.id, session.id, "clock_out", {
                    lat: latitude, lon: longitude, source: "auto",
                    remarks: "Auto clock-out — shift ended and off-site",
                });
                status = await (0, attendance_1.getEmployeeStatus)(req.user.id);
            }
        }
        res.json({ onSite, distanceFt: Math.round(dist), status });
    }
    catch (err) {
        res.status(err.status || 500).json({ error: err.message || "Server error" });
    }
});
router.get("/me/today", auth_1.verifyJWT, async (req, res) => {
    try {
        const data = await (0, attendance_1.getSessionData)(req.user.id);
        res.json(data);
    }
    catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});
router.get("/me/summary", auth_1.verifyJWT, async (req, res) => {
    try {
        const { rows } = await pool_1.db.query(`SELECT
         COUNT(*) as total_sessions,
         COALESCE(SUM(worked_minutes), 0) as total_minutes,
         COALESCE(AVG(worked_minutes), 0) as avg_daily_minutes,
         COALESCE(SUM(CASE WHEN work_date >= CURRENT_DATE - 6 THEN worked_minutes ELSE 0 END), 0) as week_minutes
       FROM attendance_sessions
       WHERE user_id = $1`, [req.user.id]);
        res.json(rows[0]);
    }
    catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});
// Updated GET /me – now includes regular_minutes and overtime_minutes
router.get("/me", auth_1.verifyJWT, async (req, res) => {
    try {
        // Fetch user's sessions (last 30)
        const { rows: sessions } = await pool_1.db.query(`SELECT * FROM attendance_sessions
       WHERE user_id = $1
       ORDER BY work_date DESC LIMIT 30`, [req.user.id]);
        // Get the user's effective schedule (the same for all sessions unless date‑specific, but we use a single schedule)
        const schedule = await (0, attendance_1.getEffectiveSchedule)(req.user.id);
        // Enhance each session with regular & overtime minutes
        const enhancedSessions = sessions.map((session) => {
            let regular = 0, overtime = 0;
            if (session.clock_in_time) {
                const { regular: reg, overtime: ov } = (0, attendance_1.computeRegularOvertime)(new Date(session.clock_in_time), session.clock_out_time ? new Date(session.clock_out_time) : null, session.break_minutes || 0, schedule);
                regular = reg;
                overtime = ov;
            }
            return {
                ...session,
                regular_minutes: regular,
                overtime_minutes: overtime,
            };
        });
        res.json(enhancedSessions);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
router.put("/break/:punchId/complete", auth_1.verifyJWT, async (req, res) => {
    try {
        const { punchId } = req.params;
        const { rows } = await pool_1.db.query("SELECT user_id FROM punch_records WHERE id = $1", [punchId]);
        if (rows.length === 0) {
            res.status(404).json({ error: "Break not found" });
            return;
        }
        if (rows[0].user_id !== req.user.id) {
            res.status(403).json({ error: "Unauthorized" });
            return;
        }
        await pool_1.db.query("UPDATE punch_records SET break_completed = true WHERE id = $1", [punchId]);
        const data = await (0, attendance_1.getSessionData)(req.user.id);
        res.json({ message: "Break marked as completed", data });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
router.put("/break/:punchId/not-complete", auth_1.verifyJWT, async (req, res) => {
    try {
        const { punchId } = req.params;
        const { reason } = req.body;
        if (!reason?.trim()) {
            res.status(400).json({ error: "Reason for not completing is required." });
            return;
        }
        const { rows } = await pool_1.db.query("SELECT user_id FROM punch_records WHERE id = $1", [punchId]);
        if (rows.length === 0) {
            res.status(404).json({ error: "Break not found" });
            return;
        }
        if (rows[0].user_id !== req.user.id) {
            res.status(403).json({ error: "Unauthorized" });
            return;
        }
        await pool_1.db.query("UPDATE punch_records SET break_completed = false, break_incomplete_reason = $1 WHERE id = $2", [reason, punchId]);
        const data = await (0, attendance_1.getSessionData)(req.user.id);
        res.json({ message: "Break marked as not completed", data });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
router.get("/session/:sessionId/punches", auth_1.verifyJWT, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { rows: sessionRows } = await pool_1.db.query("SELECT user_id FROM attendance_sessions WHERE id = $1", [sessionId]);
        if (sessionRows.length === 0) {
            res.status(404).json({ error: "Session not found" });
            return;
        }
        if (sessionRows[0].user_id !== req.user.id) {
            res.status(403).json({ error: "Unauthorized" });
            return;
        }
        const { rows: punches } = await pool_1.db.query("SELECT * FROM punch_records WHERE session_id = $1 ORDER BY punch_time ASC", [sessionId]);
        res.json(punches);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
router.get("/:id/overtime", auth_1.verifyJWT, async (req, res) => {
    try {
        const { id } = req.params;
        const today = new Date().toISOString().slice(0, 10);
        const { rows } = await pool_1.db.query(`SELECT overtime_minutes FROM attendance_sessions
       WHERE user_id = $1 AND work_date = $2 AND status = 'active'`, [id, today]);
        const overtimeMins = rows[0]?.overtime_minutes || 0;
        res.json({ isOvertime: overtimeMins > 0, overtimeMins });
    }
    catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});
exports.default = router;
