import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db } from "../db/pool";
import { verifyJWT, AuthRequest } from "../middleware/auth";
import { autoClockOutPreviousDay } from "../services/attendance";

const router = Router();

// Login with user_id (4-digit) or email
router.post("/login", async (req: Request, res: Response) => {
  try {
    const { userId, password, email } = req.body;

    // Support both user_id and email login
    let query: string;
    let param: string;

    if (userId) {
      if (!/^[A-Za-z0-9]{4}$/.test(userId)) {
        res.status(400).json({ error: "User ID must be exactly 4 characters." });
        return;
      }
      query = "SELECT * FROM users WHERE user_id = $1 AND status = 'active'";
      param = userId;
    } else if (email) {
      query = "SELECT * FROM users WHERE email = $1 AND status = 'active'";
      param = email;
    } else {
      res.status(400).json({ error: "User ID or email required." });
      return;
    }

    const { rows } = await db.query(query, [param]);
    const user = rows[0];

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      res.status(401).json({ error: "Invalid credentials." });
      return;
    }

    // Auto-clock-out any active sessions from previous days
    try {
      await autoClockOutPreviousDay(user.id);
    } catch (err) {
      console.error("Auto clock-out failed:", err);
      // Don't block login; just log the error
    }

    const accessToken = jwt.sign(
      {
        id: user.id,
        role: user.role,
        name: user.full_name || user.name,
        timezone: user.timezone,
        work_mode: user.work_mode || "onsite",
      },
      process.env.JWT_SECRET!,
      { expiresIn: "8h" }
    );

    const refreshToken = jwt.sign(
      { id: user.id },
      process.env.REFRESH_SECRET!,
      { expiresIn: "30d" }
    );

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
        work_mode: user.work_mode || "onsite",
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/refresh", async (req: Request, res: Response) => {
  try {
    const token = req.cookies?.refreshToken;
    if (!token) { res.status(401).json({ error: "No refresh token" }); return; }
    const decoded = jwt.verify(token, process.env.REFRESH_SECRET!) as any;
    const { rows } = await db.query(
      "SELECT * FROM users WHERE id = $1 AND status = 'active'", [decoded.id]
    );
    const user = rows[0];
    if (!user) { res.status(401).json({ error: "User not found" }); return; }
    const accessToken = jwt.sign(
      {
        id: user.id,
        role: user.role,
        name: user.full_name || user.name,
        timezone: user.timezone,
        work_mode: user.work_mode || "onsite",
      },
      process.env.JWT_SECRET!,
      { expiresIn: "8h" }
    );
    res.json({ accessToken });
  } catch {
    res.status(401).json({ error: "Invalid refresh token" });
  }
});

router.post("/logout", (req: Request, res: Response) => {
  res.clearCookie("refreshToken", { secure: true, sameSite: "none" });
  res.json({ message: "Logged out" });
});

router.get("/me", verifyJWT, async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.full_name, u.email, u.role, u.user_id, u.work_mode,
              ep.employee_code, ep.department, ep.designation, ep.phone, ep.joined_at
       FROM users u
       LEFT JOIN employee_profiles ep ON ep.user_id = u.id
       WHERE u.id = $1`,
      [req.user!.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

export default router;