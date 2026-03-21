"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEmployeeStatus = getEmployeeStatus;
exports.getOrCreateSession = getOrCreateSession;
exports.recordPunch = recordPunch;
exports.updateSessionSummary = updateSessionSummary;
const pool_1 = require("../db/pool");
const VALID_TRANSITIONS = {
    clocked_out: ["clock_in"],
    clocked_in: ["break_start", "clock_out"],
    on_break: ["break_end"],
};
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
    await pool_1.db.query(`INSERT INTO punch_records (user_id, session_id, punch_type, latitude, longitude, source, remarks)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`, [userId, sessionId, punchType, meta.lat || null, meta.lon || null,
        meta.source || "manual", meta.remarks || ""]);
    await updateSessionSummary(sessionId);
}
async function updateSessionSummary(sessionId) {
    const { rows: punches } = await pool_1.db.query(`SELECT * FROM punch_records WHERE session_id = $1 ORDER BY punch_time ASC`, [sessionId]);
    let clockInTime = null;
    let clockOutTime = null;
    let breakMinutes = 0;
    let breakStart = null;
    for (const p of punches) {
        if (p.punch_type === "clock_in" || p.punch_type === "auto_clock_in") {
            clockInTime = new Date(p.punch_time);
        }
        if (p.punch_type === "clock_out") {
            clockOutTime = new Date(p.punch_time);
        }
        if (p.punch_type === "break_start") {
            breakStart = new Date(p.punch_time);
        }
        if (p.punch_type === "break_end" && breakStart) {
            breakMinutes += Math.round((new Date(p.punch_time).getTime() - breakStart.getTime()) / 60000);
            breakStart = null;
        }
    }
    // If still on break, count current break time too
    if (breakStart) {
        breakMinutes += Math.round((new Date().getTime() - breakStart.getTime()) / 60000);
    }
    let workedMinutes = 0;
    if (clockInTime) {
        const endTime = clockOutTime || new Date();
        workedMinutes = Math.max(0, Math.round((endTime.getTime() - clockInTime.getTime()) / 60000) - breakMinutes);
    }
    const status = clockOutTime ? "completed" : "active";
    await pool_1.db.query(`UPDATE attendance_sessions
     SET clock_in_time  = $1,
         clock_out_time = $2,
         break_minutes  = $3,
         worked_minutes = $4,
         status         = $5,
         updated_at     = NOW()
     WHERE id = $6`, [
        clockInTime?.toISOString() || null,
        clockOutTime?.toISOString() || null,
        Math.round(breakMinutes),
        Math.max(0, workedMinutes),
        status,
        sessionId,
    ]);
}
