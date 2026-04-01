"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const pool_1 = require("../db/pool");
const auth_1 = require("../middleware/auth");
const attendance_1 = require("../services/attendance");
const router = (0, express_1.Router)();
// Login with user_id (4-digit) or email
router.post("/login", async (req, res) => {
    try {
        const { userId, password, email } = req.body;
        // Support both user_id and email login
        let query;
        let param;
        if (userId) {
            if (!/^[A-Za-z0-9]{4}$/.test(userId)) {
                res.status(400).json({ error: "User ID must be exactly 4 characters." });
                return;
            }
            query = "SELECT * FROM users WHERE user_id = $1 AND status = 'active'";
            param = userId;
        }
        else if (email) {
            query = "SELECT * FROM users WHERE email = $1 AND status = 'active'";
            param = email;
        }
        else {
            res.status(400).json({ error: "User ID or email required." });
            return;
        }
        const { rows } = await pool_1.db.query(query, [param]);
        const user = rows[0];
        if (!user || !bcryptjs_1.default.compareSync(password, user.password_hash)) {
            res.status(401).json({ error: "Invalid credentials." });
            return;
        }
        // Auto-clock-out any active sessions from previous days
        try {
            await (0, attendance_1.autoClockOutPreviousDay)(user.id);
        }
        catch (err) {
            console.error("Auto clock-out failed:", err);
            // Don't block login; just log the error
        }
        // routes/auth.ts – inside login route
        const accessToken = jsonwebtoken_1.default.sign({ id: user.id, role: user.role, name: user.full_name || user.name, timezone: user.timezone }, process.env.JWT_SECRET, { expiresIn: "8h" });
        const refreshToken = jsonwebtoken_1.default.sign({ id: user.id }, process.env.REFRESH_SECRET, { expiresIn: "30d" });
        res.cookie("refreshToken", refreshToken, {
            httpOnly: true,
            secure: true,
            sameSite: "none",
            maxAge: 30 * 24 * 60 * 60 * 1000,
        });
        res.json({
            accessToken,
            user: {
                id: user.id,
                name: user.full_name || user.name,
                email: user.email,
                role: user.role,
                userId: user.user_id,
                timezone: user.timezone,
            },
        });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});
router.post("/refresh", async (req, res) => {
    try {
        const token = req.cookies?.refreshToken;
        if (!token) {
            res.status(401).json({ error: "No refresh token" });
            return;
        }
        const decoded = jsonwebtoken_1.default.verify(token, process.env.REFRESH_SECRET);
        const { rows } = await pool_1.db.query("SELECT * FROM users WHERE id = $1 AND status = 'active'", [decoded.id]);
        const user = rows[0];
        if (!user) {
            res.status(401).json({ error: "User not found" });
            return;
        }
        const accessToken = jsonwebtoken_1.default.sign({ id: user.id, role: user.role, name: user.full_name || user.name, timezone: user.timezone }, process.env.JWT_SECRET, { expiresIn: "8h" });
        res.json({ accessToken });
    }
    catch {
        res.status(401).json({ error: "Invalid refresh token" });
    }
});
router.post("/logout", (req, res) => {
    res.clearCookie("refreshToken", { secure: true, sameSite: "none" });
    res.json({ message: "Logged out" });
});
router.get("/me", auth_1.verifyJWT, async (req, res) => {
    try {
        const { rows } = await pool_1.db.query(`SELECT u.id, u.name, u.full_name, u.email, u.role, u.user_id,
              ep.employee_code, ep.department, ep.designation, ep.phone, ep.joined_at
       FROM users u
       LEFT JOIN employee_profiles ep ON ep.user_id = u.id
       WHERE u.id = $1`, [req.user.id]);
        res.json(rows[0]);
    }
    catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});
exports.default = router;
