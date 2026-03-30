"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEffectiveSchedule = getEffectiveSchedule;
exports.getEmployeeStatus = getEmployeeStatus;
exports.getOrCreateSession = getOrCreateSession;
exports.recordPunch = recordPunch;
exports.updateSessionSummary = updateSessionSummary;
exports.getSessionData = getSessionData;
exports.getLastPunch = getLastPunch;
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
        const { scheduled_start_time, scheduled_end_time } = schedRows[0];
        return {
            start: scheduled_start_time,
            end: scheduled_end_time,
            crossesMidnight: scheduled_end_time < scheduled_start_time
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
            crossesMidnight: end < start
        };
    }
    // Ultimate fallback
    return {
        start: "07:00",
        end: "17:00",
        crossesMidnight: false
    };
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
        meta.photoData || null, // <-- new
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
    // --- Overtime calculation (same as before, using the schedule) ---
    const schedule = await getEffectiveSchedule(userId);
    let overtimeMinutes = 0;
    if (clockInTime && schedule.start) {
        const [startHour, startMin] = schedule.start.split(':').map(Number);
        const scheduledStart = new Date(clockInTime);
        scheduledStart.setHours(startHour, startMin, 0, 0);
        if (clockInTime < scheduledStart) {
            overtimeMinutes += Math.round((scheduledStart.getTime() - clockInTime.getTime()) / 60000);
        }
    }
    if (clockOutTime && schedule.end) {
        const [endHour, endMin] = schedule.end.split(':').map(Number);
        const scheduledEnd = new Date(clockOutTime);
        scheduledEnd.setHours(endHour, endMin, 0, 0);
        if (schedule.crossesMidnight && (endHour < parseInt(schedule.start.split(':')[0]))) {
            scheduledEnd.setDate(scheduledEnd.getDate() + 1);
        }
        if (clockOutTime > scheduledEnd) {
            overtimeMinutes += Math.round((clockOutTime.getTime() - scheduledEnd.getTime()) / 60000);
        }
    }
    const isOvertime = overtimeMinutes > 0;
    // Update the session record
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
         updated_at        = NOW()
     WHERE id = $10`, [
        clockInTime?.toISOString() || null,
        clockOutTime?.toISOString() || null,
        Math.round(totalBreakMinutes),
        Math.round(personalBreakMinutes),
        Math.round(workBreakMinutes),
        Math.max(0, workedMinutes),
        status,
        isOvertime,
        overtimeMinutes,
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
