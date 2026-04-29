// =============================================================================
// src/routes/fuel.ts
//
// Fuel Entry module for Bright Sky Construction
// Handles:
//   - POST   /api/fuel/entry              — Submit a fuel log (fill or EOD)
//   - GET    /api/fuel/logs               — Fetch fuel logs (own or all for admin)
//   - GET    /api/fuel/dashboard          — Admin analytics summary
//   - GET    /api/fuel/alerts             — Theft/misuse alerts
//   - PUT    /api/fuel/alerts/:id/resolve — Mark alert resolved
//   - GET    /api/fuel/job-sites          — List job sites
//   - POST   /api/fuel/job-sites          — Create job site (admin/manager)
//   - GET    /api/fuel/export             — CSV/JSON export (admin/manager)
//   - GET    /api/fuel/equipment          — Equipment master list
// =============================================================================

import { Router, Response } from "express";
import { verifyJWT, AuthRequest } from "../middleware/auth";
import { db } from "../db/pool";

const router = Router();

// ── Auth required for every fuel route ────────────────────────────────────────
router.use(verifyJWT);

// ── Role helpers ──────────────────────────────────────────────────────────────
const isAdmin = (role?: string) =>
  ["admin", "manager", "owner"].includes(role || "");

// ── Equipment master list (single source of truth, mirrors frontend) ──────────
const EQUIPMENT_LIST = [
  { id: "eq1",  brand: "Muller",       model: "VAP-70pt", year: null, type: "vac_excavator"    },
  { id: "eq2",  brand: "Caterpillar",  model: "289D",     year: 2018, type: "compact_track"    },
  { id: "eq3",  brand: "John Deere",   model: "26G",      year: 2016, type: "mini_excavator"   },
  { id: "eq4",  brand: "Komatsu",      model: "PC 360",   year: 2014, type: "excavator"        },
  { id: "eq5",  brand: "Caterpillar",  model: "953C",     year: 2002, type: "track_loader"     },
  { id: "eq6",  brand: "Ditch Witch",  model: "4010 DD",  year: 2016, type: "directional_drill"},
  { id: "eq7",  brand: "Utility",      model: "Trailer",  year: null, type: "trailer"          },
  { id: "eq8",  brand: "Enclosed",     model: "Trailer",  year: null, type: "trailer"          },
  { id: "eq9",  brand: "Dump Truck",   model: "",         year: null, type: "truck"            },
  { id: "eq10", brand: "International",model: "",         year: null, type: "truck"            },
];

// =============================================================================
// GET /api/fuel/equipment
// Returns the equipment master list. No DB table needed — list is static.
// =============================================================================
router.get("/equipment", (req: AuthRequest, res: Response) => {
  res.json(EQUIPMENT_LIST);
});

// =============================================================================
// POST /api/fuel/entry
// Submit a fuel log entry (fill or end-of-day remaining).
// Body: {
//   equipment_id, equipment_brand, equipment_model,
//   entry_type ("fill" | "eod"),
//   job_site_id,
//   fuel_level_before?, fuel_level_after?, fuel_level_remaining?,
//   gallons_added?,
//   hours_reading?,
//   remarks?, supervisor_note?,
//   photo_before?, photo_after?,        — base64 data URLs
//   gps_lat?, gps_lon?,
//   device_info?,
//   logged_at                           — ISO string from client
// }
// =============================================================================
router.post("/entry", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const {
      equipment_id, equipment_brand, equipment_model,
      entry_type,
      job_site_id,
      fuel_level_before, fuel_level_after, fuel_level_remaining,
      gallons_added,
      hours_reading,
      remarks, supervisor_note,
      photo_before, photo_after,
      gps_lat, gps_lon,
      device_info,
      logged_at,
    } = req.body;

    // ── Validation ────────────────────────────────────────────────────────────
    if (!equipment_id) {
      res.status(400).json({ error: "equipment_id is required." });
      return;
    }
    if (!["fill", "eod"].includes(entry_type)) {
      res.status(400).json({ error: "entry_type must be 'fill' or 'eod'." });
      return;
    }
    if (entry_type === "fill" && (fuel_level_before == null || gallons_added == null)) {
      res.status(400).json({ error: "fill entry requires fuel_level_before and gallons_added." });
      return;
    }
    if (entry_type === "eod" && fuel_level_remaining == null) {
      res.status(400).json({ error: "eod entry requires fuel_level_remaining." });
      return;
    }

    // ── Resolve job_site_id to name (for denormalized logging) ───────────────
    let jobSiteName: string | null = null;
    if (job_site_id && job_site_id !== "__other__") {
      try {
        const { rows } = await db.query(
          "SELECT name FROM fuel_job_sites WHERE id = $1",
          [job_site_id]
        );
        if (rows[0]) jobSiteName = rows[0].name;
      } catch {}
    }

    // ── Insert log record ─────────────────────────────────────────────────────
    const { rows } = await db.query(
      `INSERT INTO fuel_logs (
         operator_id, operator_name,
         equipment_id, equipment_brand, equipment_model,
         entry_type,
         job_site_id, job_site_name,
         fuel_level_before, fuel_level_after, fuel_level_remaining,
         gallons_added,
         hours_reading,
         remarks, supervisor_note,
         photo_before, photo_after,
         gps_lat, gps_lon,
         device_info,
         logged_at, log_date
       ) VALUES (
         $1, $2,
         $3, $4, $5,
         $6,
         $7, $8,
         $9, $10, $11,
         $12,
         $13,
         $14, $15,
         $16, $17,
         $18, $19,
         $20,
         $21, ($21::timestamptz AT TIME ZONE COALESCE($22, 'America/New_York'))::date
       )
       RETURNING id, log_date`,
      [
        userId, req.user!.name,
        equipment_id, equipment_brand || "", equipment_model || "",
        entry_type,
        job_site_id !== "__other__" ? job_site_id : null, jobSiteName,
        fuel_level_before ?? null, fuel_level_after ?? null, fuel_level_remaining ?? null,
        gallons_added ?? null,
        hours_reading ?? null,
        remarks?.trim() || null, supervisor_note?.trim() || null,
        photo_before || null, photo_after || null,
        gps_lat ?? null, gps_lon ?? null,
        device_info?.slice(0, 255) || null,
        logged_at || new Date().toISOString(),
        req.user!.timezone || "America/New_York",
      ]
    );

    const logId = rows[0].id;

    // ── Run async theft-detection checks (fire and forget) ───────────────────
    runFuelChecks(userId, equipment_id, logId, entry_type, {
      gallons_added: Number(gallons_added) || 0,
      hours_reading: Number(hours_reading) || 0,
      fuel_level_before: Number(fuel_level_before) || 0,
      fuel_level_after: Number(fuel_level_after) || 0,
      gps_lat: Number(gps_lat) || null,
      gps_lon: Number(gps_lon) || null,
      equipment_brand: equipment_brand || "",
      operator_name: req.user!.name,
    }).catch(console.error);

    res.json({ message: "Fuel entry saved.", id: logId });
  } catch (err: any) {
    console.error("[fuel/entry]", err);
    res.status(500).json({ error: err.message || "Server error." });
  }
});

// =============================================================================
// GET /api/fuel/logs
// Returns fuel logs. Admin/manager sees all; employee sees own.
// Query params: equipment_id, entry_type, date_from, date_to, limit (default 50)
// =============================================================================
router.get("/logs", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const admin = isAdmin(req.user!.role);
    const { equipment_id, entry_type, date_from, date_to, limit = "50" } = req.query as Record<string, string>;

    const conditions: string[] = [];
    const params: any[] = [];
    let p = 1;

    if (!admin) {
      conditions.push(`operator_id = $${p++}`);
      params.push(userId);
    }
    if (equipment_id) { conditions.push(`equipment_id = $${p++}`); params.push(equipment_id); }
    if (entry_type)   { conditions.push(`entry_type = $${p++}`);   params.push(entry_type); }
    if (date_from)    { conditions.push(`log_date >= $${p++}`);    params.push(date_from); }
    if (date_to)      { conditions.push(`log_date <= $${p++}`);    params.push(date_to); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const lim = Math.min(parseInt(limit) || 50, 500);

    const { rows: logs } = await db.query(
      `SELECT
         id, operator_id, operator_name,
         equipment_id, equipment_brand, equipment_model,
         entry_type,
         job_site_id, job_site_name,
         fuel_level_before, fuel_level_after, fuel_level_remaining,
         gallons_added, hours_reading,
         remarks, supervisor_note,
         gps_lat, gps_lon,
         log_date,
         logged_at
         -- photos omitted from list view to keep payload small
       FROM fuel_logs
       ${where}
       ORDER BY logged_at DESC
       LIMIT ${lim}`,
      params
    );

    res.json({ logs });
  } catch (err: any) {
    console.error("[fuel/logs]", err);
    res.status(500).json({ error: "Server error." });
  }
});

// =============================================================================
// GET /api/fuel/dashboard
// Admin-only — aggregate analytics for the dashboard view.
// =============================================================================
router.get("/dashboard", async (req: AuthRequest, res: Response) => {
  if (!isAdmin(req.user!.role)) {
    res.status(403).json({ error: "Admins and managers only." });
    return;
  }
  try {
    // Total gallons by day (last 30 days)
    const { rows: dailyTotals } = await db.query(
      `SELECT log_date::text, COALESCE(SUM(gallons_added),0)::float AS gallons
       FROM fuel_logs
       WHERE entry_type = 'fill' AND log_date >= CURRENT_DATE - 29
       GROUP BY log_date
       ORDER BY log_date`
    );

    // Gallons by equipment (all time)
    const { rows: byEquipment } = await db.query(
      `SELECT equipment_id, equipment_brand, equipment_model,
              COALESCE(SUM(gallons_added),0)::float AS total_gallons,
              COUNT(*) AS entry_count
       FROM fuel_logs WHERE entry_type = 'fill'
       GROUP BY equipment_id, equipment_brand, equipment_model
       ORDER BY total_gallons DESC`
    );

    // EOD status today
    const { rows: eodToday } = await db.query(
      `SELECT equipment_id, fuel_level_remaining, operator_name
       FROM fuel_logs
       WHERE entry_type = 'eod' AND log_date = CURRENT_DATE`
    );

    // Operators (top 10 by usage)
    const { rows: byOperator } = await db.query(
      `SELECT operator_id, operator_name,
              COALESCE(SUM(gallons_added),0)::float AS total_gallons,
              COUNT(*) AS entry_count
       FROM fuel_logs
       GROUP BY operator_id, operator_name
       ORDER BY total_gallons DESC
       LIMIT 10`
    );

    // Unresolved alert count
    const { rows: alertCount } = await db.query(
      `SELECT COUNT(*) AS cnt FROM fuel_alerts WHERE resolved = false`
    );

    res.json({
      daily_totals: dailyTotals,
      by_equipment: byEquipment,
      eod_today: eodToday,
      by_operator: byOperator,
      unresolved_alerts: parseInt(alertCount[0]?.cnt || "0"),
    });
  } catch (err: any) {
    console.error("[fuel/dashboard]", err);
    res.status(500).json({ error: "Server error." });
  }
});

// =============================================================================
// GET /api/fuel/alerts
// Returns fuel theft/misuse alerts. Admin sees all; employee sees own.
// =============================================================================
router.get("/alerts", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const admin = isAdmin(req.user!.role);
    const where = admin ? "" : "WHERE operator_id = $1";
    const params = admin ? [] : [userId];

    const { rows: alerts } = await db.query(
      `SELECT id, alert_type, equipment_id, equipment_brand,
              operator_id, operator_name, job_site_name,
              reason, severity, resolved, created_at
       FROM fuel_alerts
       ${where}
       ORDER BY resolved ASC, created_at DESC
       LIMIT 100`,
      params
    );

    res.json({ alerts });
  } catch (err: any) {
    console.error("[fuel/alerts]", err);
    res.status(500).json({ error: "Server error." });
  }
});

// =============================================================================
// PUT /api/fuel/alerts/:id/resolve
// Mark an alert as resolved. Admin/manager only.
// =============================================================================
router.put("/alerts/:id/resolve", async (req: AuthRequest, res: Response) => {
  if (!isAdmin(req.user!.role)) {
    res.status(403).json({ error: "Admins and managers only." });
    return;
  }
  try {
    await db.query(
      "UPDATE fuel_alerts SET resolved = true, resolved_by = $1, resolved_at = NOW() WHERE id = $2",
      [req.user!.id, req.params.id]
    );
    res.json({ message: "Alert resolved." });
  } catch (err: any) {
    res.status(500).json({ error: "Server error." });
  }
});

// =============================================================================
// GET /api/fuel/job-sites
// Returns active job sites for fuel entry selection.
// =============================================================================
router.get("/job-sites", async (req: AuthRequest, res: Response) => {
  try {
    const { rows: sites } = await db.query(
      `SELECT id, name, address, project_name, site_manager
       FROM fuel_job_sites
       WHERE active = true
       ORDER BY name`
    );
    res.json({ sites });
  } catch (err: any) {
    console.error("[fuel/job-sites]", err);
    res.status(500).json({ error: "Server error." });
  }
});

// =============================================================================
// POST /api/fuel/job-sites
// Create a new job site. Admin/manager only.
// =============================================================================
router.post("/job-sites", async (req: AuthRequest, res: Response) => {
  if (!isAdmin(req.user!.role)) {
    res.status(403).json({ error: "Admins and managers only." });
    return;
  }
  try {
    const { name, address, project_name, site_manager, latitude, longitude } = req.body;
    if (!name?.trim()) {
      res.status(400).json({ error: "Site name is required." });
      return;
    }
    const { rows } = await db.query(
      `INSERT INTO fuel_job_sites (name, address, project_name, site_manager, latitude, longitude, active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING *`,
      [name.trim(), address || null, project_name || null, site_manager || null, latitude || null, longitude || null]
    );
    res.json({ site: rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: "Server error." });
  }
});

// =============================================================================
// GET /api/fuel/export
// Export fuel logs as CSV or JSON. Admin/manager only.
// Query: equipment_id?, date_from?, date_to?, format (csv|json)
// =============================================================================
router.get("/export", async (req: AuthRequest, res: Response) => {
  if (!isAdmin(req.user!.role)) {
    res.status(403).json({ error: "Admins and managers only." });
    return;
  }
  try {
    const { equipment_id, date_from, date_to, format = "csv" } = req.query as Record<string, string>;
    const conditions: string[] = [];
    const params: any[] = [];
    let p = 1;

    if (equipment_id) { conditions.push(`equipment_id = $${p++}`); params.push(equipment_id); }
    if (date_from)    { conditions.push(`log_date >= $${p++}`);    params.push(date_from); }
    if (date_to)      { conditions.push(`log_date <= $${p++}`);    params.push(date_to); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows } = await db.query(
      `SELECT
         log_date, logged_at,
         operator_name,
         equipment_brand, equipment_model,
         entry_type,
         job_site_name,
         fuel_level_before, fuel_level_after, fuel_level_remaining,
         gallons_added, hours_reading,
         gps_lat, gps_lon,
         remarks, supervisor_note
       FROM fuel_logs
       ${where}
       ORDER BY log_date DESC, logged_at DESC
       LIMIT 5000`,
      params
    );

    if (format === "json") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="fuel_export_${new Date().toISOString().slice(0,10)}.json"`);
      res.json(rows);
      return;
    }

    // CSV
    const headers = [
      "Date", "Time", "Operator",
      "Equipment", "Model",
      "Entry Type",
      "Job Site",
      "Fuel Before (%)", "Fuel After (%)", "Fuel Remaining (%)",
      "Gallons Added", "Hours Reading",
      "GPS Lat", "GPS Lon",
      "Remarks", "Supervisor Note",
    ];
    const csvEsc = (v: any) => {
      if (v == null) return "";
      const s = String(v);
      return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      headers.join(","),
      ...rows.map(r => [
        r.log_date,
        r.logged_at ? new Date(r.logged_at).toLocaleTimeString() : "",
        r.operator_name,
        r.equipment_brand, r.equipment_model,
        r.entry_type,
        r.job_site_name || "",
        r.fuel_level_before ?? "", r.fuel_level_after ?? "", r.fuel_level_remaining ?? "",
        r.gallons_added ?? "", r.hours_reading ?? "",
        r.gps_lat ?? "", r.gps_lon ?? "",
        r.remarks || "", r.supervisor_note || "",
      ].map(csvEsc).join(","))
    ];

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="fuel_export_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(lines.join("\n"));
  } catch (err: any) {
    console.error("[fuel/export]", err);
    res.status(500).json({ error: "Server error." });
  }
});

// =============================================================================
// THEFT & MISUSE DETECTION ENGINE
// Called async after every fuel entry. Inserts alerts into fuel_alerts.
// Checks performed:
//   1. Duplicate rapid entries (same equipment, same operator, <15 min apart)
//   2. Unusually high gallons added (>100 gal for single fill)
//   3. High fuel add with very low hours (possible meter manipulation)
//   4. EOD level significantly lower than previous EOD (unexplained drop >30%)
//   5. Entry GPS far from any registered job site (>2 miles)
// =============================================================================
async function runFuelChecks(
  operatorId: string,
  equipmentId: string,
  logId: string,
  entryType: string,
  data: {
    gallons_added: number;
    hours_reading: number;
    fuel_level_before: number;
    fuel_level_after: number;
    gps_lat: number | null;
    gps_lon: number | null;
    equipment_brand: string;
    operator_name: string;
  }
) {
  const addAlert = async (
    alertType: string,
    severity: "low" | "medium" | "high",
    reason: string,
    jobSiteName: string | null = null
  ) => {
    try {
      await db.query(
        `INSERT INTO fuel_alerts
           (fuel_log_id, alert_type, equipment_id, equipment_brand,
            operator_id, operator_name, job_site_name,
            reason, severity, resolved)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false)
         ON CONFLICT DO NOTHING`,
        [logId, alertType, equipmentId, data.equipment_brand,
         operatorId, data.operator_name, jobSiteName,
         reason, severity]
      );
    } catch (e) {
      console.error("[fuel alert insert]", e);
    }
  };

  // 1. Rapid repeat entry — same equipment, same operator, within 15 minutes
  try {
    const { rows } = await db.query(
      `SELECT id FROM fuel_logs
       WHERE equipment_id = $1 AND operator_id = $2
         AND entry_type = $3
         AND logged_at > NOW() - INTERVAL '15 minutes'
         AND id != $4`,
      [equipmentId, operatorId, entryType, logId]
    );
    if (rows.length > 0) {
      await addAlert("rapid_repeat_entry", "high",
        `${data.equipment_brand} has ${rows.length + 1} ${entryType} entries within 15 minutes from the same operator.`);
    }
  } catch {}

  if (entryType === "fill") {
    // 2. Unusually high gallons — >100 gal in a single fill
    if (data.gallons_added > 100) {
      await addAlert("high_consumption", "high",
        `${data.gallons_added} gallons added in a single fill for ${data.equipment_brand}. Typical max is ~100 gal.`);
    }

    // 3. High fuel + very low hours delta
    if (data.gallons_added > 40 && data.hours_reading > 0) {
      try {
        const { rows } = await db.query(
          `SELECT hours_reading FROM fuel_logs
           WHERE equipment_id = $1 AND entry_type = 'fill'
             AND hours_reading IS NOT NULL AND id != $2
           ORDER BY logged_at DESC LIMIT 1`,
          [equipmentId, logId]
        );
        if (rows[0]?.hours_reading != null) {
          const prevHours = Number(rows[0].hours_reading);
          const delta = data.hours_reading - prevHours;
          if (delta >= 0 && delta < 2) {
            await addAlert("low_hours_high_fuel", "medium",
              `${data.gallons_added} gallons added but only ${delta.toFixed(1)} machine hours elapsed since last fill on ${data.equipment_brand}.`);
          }
        }
      } catch {}
    }

    // 4. Fuel level after fill is lower than expected (level_after < level_before)
    if (data.fuel_level_after > 0 && data.fuel_level_before > 0 && data.fuel_level_after < data.fuel_level_before) {
      await addAlert("meter_inconsistency", "medium",
        `Fuel level after fill (${data.fuel_level_after}%) is lower than before fill (${data.fuel_level_before}%) on ${data.equipment_brand}. Possible reporting error.`);
    }
  }

  if (entryType === "eod") {
    // 5. Large unexplained EOD drop since last EOD (>30 percentage points, no fill in between)
    try {
      const { rows } = await db.query(
        `SELECT fl.fuel_level_remaining, fl.log_date
         FROM fuel_logs fl
         WHERE fl.equipment_id = $1 AND fl.entry_type = 'eod'
           AND fl.id != $2
         ORDER BY fl.logged_at DESC LIMIT 1`,
        [equipmentId, logId]
      );
      if (rows[0]) {
        const prev = Number(rows[0].fuel_level_remaining);
        // Check if any fill happened between last EOD and now
        const { rows: fills } = await db.query(
          `SELECT COUNT(*) AS cnt FROM fuel_logs
           WHERE equipment_id = $1 AND entry_type = 'fill'
             AND log_date > $2 AND id != $3`,
          [equipmentId, rows[0].log_date, logId]
        );
        const fillCount = parseInt(fills[0]?.cnt || "0");
        const currentLevel = Number(
          (await db.query("SELECT fuel_level_remaining FROM fuel_logs WHERE id = $1", [logId])).rows[0]?.fuel_level_remaining || 0
        );
        if (fillCount === 0 && prev - currentLevel > 30) {
          await addAlert("high_consumption", "high",
            `Fuel dropped from ${prev}% to ${currentLevel}% overnight with no recorded fill on ${data.equipment_brand}. Possible unauthorized use.`);
        }
      }
    } catch {}
  }

  // 6. GPS off-site check (only if GPS provided and job sites exist)
  if (data.gps_lat != null && data.gps_lon != null) {
    try {
      const { rows: sites } = await db.query(
        "SELECT name, latitude, longitude FROM fuel_job_sites WHERE active = true AND latitude IS NOT NULL"
      );
      if (sites.length > 0) {
        const distMiles = (lat1: number, lon1: number, lat2: number, lon2: number) => {
          const R = 3958.8;
          const dLat = (lat2 - lat1) * Math.PI / 180;
          const dLon = (lon2 - lon1) * Math.PI / 180;
          const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
          return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        };
        const closest = sites.reduce((best: any, s: any) => {
          const d = distMiles(data.gps_lat!, data.gps_lon!, Number(s.latitude), Number(s.longitude));
          return d < best.dist ? { site: s, dist: d } : best;
        }, { site: null, dist: Infinity });

        if (closest.dist > 2.0) {
          await addAlert("off_site_entry", "medium",
            `Fuel entry for ${data.equipment_brand} logged ${closest.dist.toFixed(1)} miles from nearest job site (${closest.site?.name || "unknown"}). Expected on-site logging.`);
        }
      }
    } catch {}
  }
}

export default router;