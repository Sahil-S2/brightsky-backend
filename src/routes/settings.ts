import { Router, Response } from "express";
import { verifyJWT, requireRole, AuthRequest } from "../middleware/auth";
import { db } from "../db/pool";

const router = Router();

router.use(verifyJWT, requireRole("admin", "manager"));

router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const { rows } = await db.query("SELECT * FROM site_settings WHERE id = 1");
    res.json(rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

router.put("/", async (req: AuthRequest, res: Response) => {
  try {
    const {
      companyName, siteName, latitude, longitude, radiusFeet,
      workingHoursStart, workingHoursEnd,
      autoClockInEnabled, autoBreakOnExitEnabled, autoCorrectionEnabled,
    } = req.body;

    await db.query(
      `INSERT INTO site_settings
         (id, company_name, site_name, latitude, longitude, radius_feet,
          working_hours_start, working_hours_end,
          auto_clock_in_enabled, auto_break_on_exit_enabled, auto_correction_enabled,
          updated_by, updated_at)
       VALUES (1, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
       ON CONFLICT (id) DO UPDATE SET
         company_name = $1, site_name = $2, latitude = $3, longitude = $4,
         radius_feet = $5, working_hours_start = $6, working_hours_end = $7,
         auto_clock_in_enabled = $8, auto_break_on_exit_enabled = $9,
         auto_correction_enabled = $10, updated_by = $11, updated_at = NOW()`,
      [companyName, siteName, latitude, longitude, radiusFeet,
       workingHoursStart, workingHoursEnd,
       autoClockInEnabled, autoBreakOnExitEnabled, autoCorrectionEnabled,
       req.user!.id]
    );
    res.json({ message: "Settings saved" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

export default router;