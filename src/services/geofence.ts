import { db } from "../db/pool";
import { DateTime } from "luxon";

export function distanceFeet(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 20902231;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

export async function getSiteSettings() {
  const { rows } = await db.query("SELECT * FROM site_settings WHERE id = 1");
  return rows[0];
}

// Get employee's assigned default worksite, fall back to global settings
export async function getEmployeeWorksite(userId: string) {
  const { rows } = await db.query(
    `SELECT w.* FROM worksites w
     JOIN employee_worksites ew ON ew.worksite_id = w.id
     WHERE ew.employee_id = $1 AND ew.is_default = true
     LIMIT 1`,
    [userId]
  );
  if (rows.length > 0) return rows[0];

  // Fall back to any assigned worksite
  const { rows: any } = await db.query(
    `SELECT w.* FROM worksites w
     JOIN employee_worksites ew ON ew.worksite_id = w.id
     WHERE ew.employee_id = $1 LIMIT 1`,
    [userId]
  );
  if (any.length > 0) return any[0];

  // Fall back to global site settings
  const settings = await getSiteSettings();
  if (settings) {
    return {
      id: null,
      name: settings.site_name,
      latitude: settings.latitude,
      longitude: settings.longitude,
      radius_feet: settings.radius_feet,
    };
  }
  return null;
}

export async function assertOnSite(userId: string, userLat: number, userLon: number) {
  const worksite = await getEmployeeWorksite(userId);
  if (!worksite) throw { status: 500, message: "No worksite configured." };
  const dist = distanceFeet(userLat, userLon, worksite.latitude, worksite.longitude);
  if (dist > worksite.radius_feet) {
    throw { status: 403, message: `Off-site (${Math.round(dist)} ft from ${worksite.name}).` };
  }
  return { dist, worksite };
}

/**
 * Returns true when the current moment falls within the schedule's working
 * window, evaluated in the employee's own timezone.
 *
 * @param settings  - Object with working_hours_start / working_hours_end
 *                    (or scheduled_start_time / scheduled_end_time).
 *                    Time strings must be in "HH:MM" 24-hour format.
 * @param timezone  - IANA timezone string for the employee
 *                    (e.g. "America/New_York", "Asia/Kolkata").
 *                    Defaults to "America/New_York" so existing call sites
 *                    that omit this argument continue to work without change.
 *
 * Bug fixed (was): used new Date().getHours() which returns the SERVER's
 * local hour (Railway = UTC). Employees in America/New_York or Asia/Kolkata
 * would get the wrong answer by 4–9.5 hours.
 *
 * Bug fixed (was): midnight-crossing schedules (e.g. 22:00 → 06:00) were
 * always evaluated as false because no single minute value can be both
 * >= 1320 AND <= 360. Fixed with an OR check, consistent with the
 * crossesMidnight logic already used throughout the attendance service.
 */
export function isWithinWorkingHours(
  settings: any,
  timezone: string = "America/New_York"
): boolean {
  // Resolve the current time in the employee's local timezone, not the server's.
  const now = DateTime.now().setZone(timezone);
  const currentMinutes = now.hour * 60 + now.minute;

  // Accept both column-name conventions used across the codebase.
  const startStr: string =
    settings.working_hours_start ||
    settings.scheduled_start_time ||
    "07:00";
  const endStr: string =
    settings.working_hours_end ||
    settings.scheduled_end_time ||
    "17:00";

  const [startH, startM] = startStr.split(":").map(Number);
  const [endH,   endM  ] = endStr  .split(":").map(Number);

  const startMinutes = startH * 60 + startM;
  const endMinutes   = endH   * 60 + endM;

  // Midnight-crossing schedule (e.g. 22:00 → 06:00):
  //   The working window wraps around midnight, so "within hours" means
  //   the current time is either >= shift-start OR <= shift-end.
  if (endMinutes < startMinutes) {
    return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
  }

  // Normal same-day schedule (e.g. 07:00 → 17:00):
  return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
}