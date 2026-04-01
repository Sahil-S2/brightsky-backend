"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEffectiveSchedule = getEffectiveSchedule;
exports.computeRegularOvertime = computeRegularOvertime;
exports.getEmployeeStatus = getEmployeeStatus;
exports.getOrCreateSession = getOrCreateSession;
exports.recordPunch = recordPunch;
exports.updateSessionSummary = updateSessionSummary;
exports.getSessionData = getSessionData;
exports.getLastPunch = getLastPunch;
exports.getUserTimezone = getUserTimezone;
exports.autoClockOutPreviousDay = autoClockOutPreviousDay;
const pool_1 = require("../db/pool");
const VALID_TRANSITIONS = {
    clocked_out: ["clock_in"],
    clocked_in: ["break_start", "clock_out"],
    on_break: ["break_end"],
};
// Helper to get effective schedule for an employee (personal or global fallback)
async function getEffectiveSchedule(userId) {
    // Try employee-specific schedule
    const { rows: schedRows } = await pool_1.db.query(`SELECT scheduled_start_time, scheduled_end_time
     FROM employee_schedules
     WHERE employee_id = $1`, [userId]);
    if (schedRows.length) {
        let { scheduled_start_time, scheduled_end_time } = schedRows[0];
        // If end time is missing, equal to start, or invalid, fall back to global
        if (!scheduled_end_time || scheduled_end_time === scheduled_start_time) {
            const { rows: settingsRows } = await pool_1.db.query(`SELECT working_hours_start, working_hours_end
         FROM site_settings WHERE id = 1`);
            if (settingsRows.length) {
                scheduled_start_time = settingsRows[0].working_hours_start;
                scheduled_end_time = settingsRows[0].working_hours_end;
            }
            else {
                scheduled_start_time = "07:00";
                scheduled_end_time = "17:00";
            }
        }
        return {
            start: scheduled_start_time,
            end: scheduled_end_time,
            crossesMidnight: scheduled_end_time < scheduled_start_time,
        };
    }
    // Fallback to global site settings
    const { rows: settingsRows } = await pool_1.db.query(`SELECT working_hours_start, working_hours_end
     FROM site_settings
     WHERE id = 1`);
    if (settingsRows.length) {
        const start = settingsRows[0].working_hours_start;
        const end = settingsRows[0].working_hours_end;
        return {
            start: start,
            end: end,
            crossesMidnight: end < start,
        };
    }
    // Ultimate fallback
    return {
        start: "07:00",
        end: "17:00",
        crossesMidnight: false,
    };
}
/**
 * Computes regular and overtime minutes for a given shift
 * @param clockIn - actual clock-in time
 * @param clockOut - actual clock-out time (or null if still active)
 * @param breakMinutes - total break minutes taken during the shift
 * @param schedule - the employee's schedule for that day
 */
function computeRegularOvertime(clockIn, clockOut, breakMinutes, schedule) {
    const end = clockOut || new Date();
    const [startHour, startMin] = schedule.start.split(':').map(Number);
    const [endHour, endMin] = schedule.end.split(':').map(Number);
    // Validate schedule (start must be valid, end must be valid and not equal to start)
    if (isNaN(startHour) || isNaN(endHour) || (startHour === endHour && startMin === endMin && !schedule.crossesMidnight)) {
        // Invalid schedule – fallback to global (or treat all as regular)
        const totalWorked = Math.max(0, Math.round((end.getTime() - clockIn.getTime()) / 60000) - breakMinutes);
        return { regular: totalWorked, overtime: 0 };
    }
    const scheduledStart = new Date(clockIn);
    scheduledStart.setHours(startHour, startMin, 0, 0);
    const scheduledEnd = new Date(clockIn);
    scheduledEnd.setHours(endHour, endMin, 0, 0);
    if (schedule.crossesMidnight) {
        scheduledEnd.setDate(scheduledEnd.getDate() + 1);
        // If clock‑out is before midnight, we need to cap overlap to midnight
        const midnight = new Date(clockIn);
        midnight.setHours(24, 0, 0, 0);
        const effectiveEnd = end < midnight ? end : midnight;
        const overlapStart = new Date(Math.max(clockIn.getTime(), scheduledStart.getTime()));
        const overlapEnd = new Date(Math.min(effectiveEnd.getTime(), scheduledEnd.getTime()));
        let regularMinutes = 0;
        if (overlapEnd > overlapStart) {
            regularMinutes = Math.round((overlapEnd.getTime() - overlapStart.getTime()) / 60000);
        }
        const totalWorked = Math.max(0, Math.round((end.getTime() - clockIn.getTime()) / 60000) - breakMinutes);
        const overtimeMinutes = Math.max(0, totalWorked - regularMinutes);
        return { regular: regularMinutes, overtime: overtimeMinutes };
    }
    else {
        // Normal shift (same day)
        const overlapStart = new Date(Math.max(clockIn.getTime(), scheduledStart.getTime()));
        const overlapEnd = new Date(Math.min(end.getTime(), scheduledEnd.getTime()));
        let regularMinutes = 0;
        if (overlapEnd > overlapStart) {
            regularMinutes = Math.round((overlapEnd.getTime() - overlapStart.getTime()) / 60000);
        }
        const totalWorked = Math.max(0, Math.round((end.getTime() - clockIn.getTime()) / 60000) - breakMinutes);
        const overtimeMinutes = Math.max(0, totalWorked - regularMinutes);
        return { regular: regularMinutes, overtime: overtimeMinutes };
    }
}
async function getEmployeeStatus(userId) {
    const today = new Date().toISOString().slice(0, 10);
    const { rows: sessions } = await pool_1.db.query(`SELECT * FROM attendance_sessions WHERE user_id = $1 AND work_date = $2`, [userId, today]);
    if (!sessions.length || !sessions[0].clock_in_time)
        return "clocked_out";
    if (sessions[0].clock_out_time)
        return "clocked_out";
    const { rows: punches } = await pool_1.db.query(`SELECT * FROM punch_records WHERE session_id = $1 ORDER BY punch_time DESC LIMIT 1`, [sessions[0].id]);
    if (!punches.length)
        return "clocked_out";
    const last = punches[0].punch_type;
    if (last === "break_start")
        return "on_break";
    if (["clock_in", "break_end", "auto_clock_in"].includes(last))
        return "clocked_in";
    return "clocked_out";
}
async function getOrCreateSession(userId) {
    const today = new Date().toISOString().slice(0, 10);
    const { rows } = await pool_1.db.query(`SELECT * FROM attendance_sessions WHERE user_id = $1 AND work_date = $2`, [userId, today]);
    if (rows.length)
        return rows[0];
    const { rows: newRows } = await pool_1.db.query(`INSERT INTO attendance_sessions (user_id, work_date, status)
     VALUES ($1, $2, 'active') RETURNING *`, [userId, today]);
    return newRows[0];
}
async function recordPunch(userId, sessionId, punchType, meta) {
    const currentStatus = await getEmployeeStatus(userId);
    const allowed = VALID_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.includes(punchType)) {
        throw {
            status: 409,
            message: `Cannot perform '${punchType}' when status is '${currentStatus}'`
        };
    }
    await pool_1.db.query(`INSERT INTO punch_records
       (user_id, session_id, punch_type, latitude, longitude, source, remarks,
        break_type, break_completed, photo_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [
        userId,
        sessionId,
        punchType,
        meta.lat || null,
        meta.lon || null,
        meta.source || "manual",
        meta.remarks || "",
        meta.breakType || null,
        meta.breakCompleted !== undefined ? meta.breakCompleted : null,
        meta.photoData || null,
    ]);
    await updateSessionSummary(sessionId);
}
async function updateSessionSummary(sessionId) {
    // Fetch session's user_id
    const { rows: sessionRows } = await pool_1.db.query(`SELECT user_id FROM attendance_sessions WHERE id = $1`, [sessionId]);
    if (!sessionRows.length)
        return;
    const userId = sessionRows[0].user_id;
    // Fetch all punches in order
    const { rows: punches } = await pool_1.db.query(`SELECT * FROM punch_records WHERE session_id = $1 ORDER BY punch_time ASC`, [sessionId]);
    let clockInTime = null;
    let clockOutTime = null;
    let breakStart = null;
    let currentBreakType = null; // 'personal' or 'work'
    let personalBreakMinutes = 0;
    let workBreakMinutes = 0;
    for (const p of punches) {
        const punchTime = new Date(p.punch_time);
        if (p.punch_type === "clock_in" || p.punch_type === "auto_clock_in") {
            clockInTime = punchTime;
        }
        if (p.punch_type === "clock_out") {
            clockOutTime = punchTime;
        }
        if (p.punch_type === "break_start") {
            breakStart = punchTime;
            currentBreakType = p.break_type; // 'personal' or 'work'
        }
        if (p.punch_type === "break_end" && breakStart) {
            const breakDuration = Math.round((punchTime.getTime() - breakStart.getTime()) / 60000);
            if (currentBreakType === "personal") {
                personalBreakMinutes += breakDuration;
            }
            else if (currentBreakType === "work") {
                workBreakMinutes += breakDuration;
            }
            else {
                // Fallback: add to personal (old data)
                personalBreakMinutes += breakDuration;
            }
            breakStart = null;
            currentBreakType = null;
        }
    }
    // If still on break, count current break time
    if (breakStart) {
        const ongoing = Math.round((new Date().getTime() - breakStart.getTime()) / 60000);
        if (currentBreakType === "personal") {
            personalBreakMinutes += ongoing;
        }
        else if (currentBreakType === "work") {
            workBreakMinutes += ongoing;
        }
        else {
            personalBreakMinutes += ongoing;
        }
    }
    const totalBreakMinutes = personalBreakMinutes + workBreakMinutes;
    let workedMinutes = 0;
    if (clockInTime) {
        const endTime = clockOutTime || new Date();
        workedMinutes = Math.max(0, Math.round((endTime.getTime() - clockInTime.getTime()) / 60000) - totalBreakMinutes);
    }
    const status = clockOutTime ? "completed" : "active";
    // --- Regular / Overtime split ---
    let regularMinutes = 0;
    let overtimeMinutes = 0;
    let isOvertime = false;
    if (clockInTime) {
        const schedule = await getEffectiveSchedule(userId);
        const { regular, overtime } = computeRegularOvertime(clockInTime, clockOutTime, totalBreakMinutes, schedule);
        regularMinutes = regular;
        overtimeMinutes = overtime;
        isOvertime = overtimeMinutes > 0;
    }
    // Update the session record with new columns
    await pool_1.db.query(`UPDATE attendance_sessions
     SET clock_in_time     = $1,
         clock_out_time    = $2,
         break_minutes     = $3,
         personal_break_minutes = $4,
         work_break_minutes = $5,
         worked_minutes    = $6,
         status            = $7,
         is_overtime       = $8,
         overtime_minutes  = $9,
         regular_minutes   = $10,
         updated_at        = NOW()
     WHERE id = $11`, [
        clockInTime?.toISOString() || null,
        clockOutTime?.toISOString() || null,
        Math.round(totalBreakMinutes),
        Math.round(personalBreakMinutes),
        Math.round(workBreakMinutes),
        Math.max(0, workedMinutes),
        status,
        isOvertime,
        overtimeMinutes,
        regularMinutes,
        sessionId,
    ]);
}
async function getSessionData(userId) {
    const today = new Date().toISOString().slice(0, 10);
    const { rows: sessions } = await pool_1.db.query("SELECT * FROM attendance_sessions WHERE user_id = $1 AND work_date = $2", [userId, today]);
    const session = sessions[0] || null;
    let punches = [];
    if (session) {
        const { rows } = await pool_1.db.query("SELECT * FROM punch_records WHERE session_id = $1 ORDER BY punch_time ASC", [session.id]);
        punches = rows;
    }
    const status = await getEmployeeStatus(userId);
    return { session, punches, status };
}
async function getLastPunch(userId, sessionId) {
    const { rows } = await pool_1.db.query(`SELECT * FROM punch_records 
     WHERE user_id = $1 AND session_id = $2 
     ORDER BY punch_time DESC LIMIT 1`, [userId, sessionId]);
    return rows[0] || null;
}
async function getUserTimezone(userId) {
    const { rows } = await pool_1.db.query("SELECT timezone FROM users WHERE id = $1", [userId]);
    return rows[0]?.timezone || 'America/New_York';
}
// Auto-clock-out for previous day’s active sessions
async function autoClockOutPreviousDay(userId) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { rows: activeSessions } = await pool_1.db.query(`SELECT * FROM attendance_sessions
     WHERE user_id = $1 AND status = 'active' AND work_date < $2`, [userId, today]);
    for (const session of activeSessions) {
        const clockOutTime = new Date(session.work_date);
        clockOutTime.setHours(23, 59, 59); // end of that day
        const workedMinutes = Math.round((clockOutTime.getTime() - new Date(session.clock_in_time).getTime()) / 60000) - (session.break_minutes || 0);
        await pool_1.db.query(`UPDATE attendance_sessions
       SET clock_out_time = $1, worked_minutes = $2, status = 'completed', is_auto_corrected = true
       WHERE id = $3`, [clockOutTime, workedMinutes, session.id]);
    }
}
