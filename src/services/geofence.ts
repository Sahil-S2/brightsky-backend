import { db } from "../db/pool";

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

export function isWithinWorkingHours(settings: any): boolean {
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const [startH, startM] = (settings.working_hours_start || settings.scheduled_start_time || "07:00").split(":").map(Number);
  const [endH, endM] = (settings.working_hours_end || settings.scheduled_end_time || "17:00").split(":").map(Number);
  return current >= (startH*60+startM) && current <= (endH*60+endM);
}