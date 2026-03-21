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
const router = (0, express_1.Router)();
router.post("/login", async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            res.status(400).json({ error: "Email and password required" });
            return;
        }
        const { rows } = await pool_1.db.query("SELECT * FROM users WHERE email = $1 AND status = 'active'", [email]);
        const user = rows[0];
        if (!user || !bcryptjs_1.default.compareSync(password, user.password_hash)) {
            res.status(401).json({ error: "Invalid email or password" });
            return;
        }
        const accessToken = jsonwebtoken_1.default.sign({ id: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: "8h" });
        const refreshToken = jsonwebtoken_1.default.sign({ id: user.id }, process.env.REFRESH_SECRET, { expiresIn: "30d" });
        res.cookie("refreshToken", refreshToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "strict",
            maxAge: 30 * 24 * 60 * 60 * 1000,
        });
        res.json({
            accessToken,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
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
        const accessToken = jsonwebtoken_1.default.sign({ id: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: "8h" });
        res.json({ accessToken });
    }
    catch {
        res.status(401).json({ error: "Invalid refresh token" });
    }
});
router.post("/logout", (req, res) => {
    res.clearCookie("refreshToken");
    res.json({ message: "Logged out successfully" });
});
router.get("/me", auth_1.verifyJWT, async (req, res) => {
    try {
        const { rows } = await pool_1.db.query(`SELECT u.id, u.name, u.email, u.role,
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
