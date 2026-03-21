import { db } from "../db/pool";

export function distanceFeet(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 20902231;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function getSiteSettings() {
  const { rows } = await db.query("SELECT * FROM site_settings WHERE id = 1");
  return rows[0];
}

export async function assertOnSite(userLat: number, userLon: number) {
  const settings = await getSiteSettings();
  if (!settings) throw { status: 500, message: "Site settings not configured" };
  const dist = distanceFeet(userLat, userLon, settings.latitude, settings.longitude);
  if (dist > settings.radius_feet) {
    throw { status: 403, message: `You are off-site (${Math.round(dist)} ft away). Must be within ${settings.radius_feet} ft.` };
  }
  return dist;
}

export function isWithinWorkingHours(settings: any): boolean {
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const [startH, startM] = settings.working_hours_start.split(":").map(Number);
  const [endH, endM] = settings.working_hours_end.split(":").map(Number);
  const start = startH * 60 + startM;
  const end = endH * 60 + endM;
  return current >= start && current <= end;
}