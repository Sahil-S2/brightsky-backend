"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.distanceFeet = distanceFeet;
exports.getSiteSettings = getSiteSettings;
exports.getEmployeeWorksite = getEmployeeWorksite;
exports.assertOnSite = assertOnSite;
exports.isWithinWorkingHours = isWithinWorkingHours;
const pool_1 = require("../db/pool");
function distanceFeet(lat1, lon1, lat2, lon2) {
    const R = 20902231;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
async function getSiteSettings() {
    const { rows } = await pool_1.db.query("SELECT * FROM site_settings WHERE id = 1");
    return rows[0];
}
// Get employee's assigned default worksite, fall back to global settings
async function getEmployeeWorksite(userId) {
    const { rows } = await pool_1.db.query(`SELECT w.* FROM worksites w
     JOIN employee_worksites ew ON ew.worksite_id = w.id
     WHERE ew.employee_id = $1 AND ew.is_default = true
     LIMIT 1`, [userId]);
    if (rows.length > 0)
        return rows[0];
    // Fall back to any assigned worksite
    const { rows: any } = await pool_1.db.query(`SELECT w.* FROM worksites w
     JOIN employee_worksites ew ON ew.worksite_id = w.id
     WHERE ew.employee_id = $1 LIMIT 1`, [userId]);
    if (any.length > 0)
        return any[0];
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
async function assertOnSite(userId, userLat, userLon) {
    const worksite = await getEmployeeWorksite(userId);
    if (!worksite)
        throw { status: 500, message: "No worksite configured." };
    const dist = distanceFeet(userLat, userLon, worksite.latitude, worksite.longitude);
    if (dist > worksite.radius_feet) {
        throw { status: 403, message: `Off-site (${Math.round(dist)} ft from ${worksite.name}).` };
    }
    return { dist, worksite };
}
function isWithinWorkingHours(settings) {
    const now = new Date();
    const current = now.getHours() * 60 + now.getMinutes();
    const [startH, startM] = (settings.working_hours_start || settings.scheduled_start_time || "07:00").split(":").map(Number);
    const [endH, endM] = (settings.working_hours_end || settings.scheduled_end_time || "17:00").split(":").map(Number);
    return current >= (startH * 60 + startM) && current <= (endH * 60 + endM);
}
