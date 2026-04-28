import { db } from "../db/pool";
import { DateTime } from 'luxon';

const VALID_TRANSITIONS: Record<string, string[]> = {
  clocked_out: ["clock_in"],
  clocked_in:  ["break_start", "clock_out"],
  on_break:    ["break_end"],
};

// Helper to get effective schedule for an employee (personal or global fallback)
export async function getEffectiveSchedule(userId: string) {
  // Try employee-specific schedule
  const { rows: schedRows } = await db.query(
    `SELECT scheduled_start_time, scheduled_end_time
     FROM employee_schedules
     WHERE employee_id = $1`,
    [userId]
  );
  if (schedRows.length) {
    let { scheduled_start_time, scheduled_end_time } = schedRows[0];

    // If end time is missing, equal to start, or invalid, fall back to global
    if (!scheduled_end_time || scheduled_end_time === scheduled_start_time) {
      const { rows: settingsRows } = await db.query(
        `SELECT working_hours_start, working_hours_end
         FROM site_settings WHERE id = 1`
      );
      if (settingsRows.length) {
        scheduled_start_time = settingsRows[0].working_hours_start;
        scheduled_end_time = settingsRows[0].working_hours_end;
      } else {
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
  const { rows: settingsRows } = await db.query(
    `SELECT working_hours_start, working_hours_end
     FROM site_settings
     WHERE id = 1`
  );
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
export function computeRegularOvertime(
  clockIn: Date,
  clockOut: Date | null,
  breakMinutes: number,
  schedule: { start: string; end: string; crossesMidnight: boolean },
  timezone: string
): { regular: number; overtime: number } {
  const clockInLocal = DateTime.fromJSDate(clockIn).setZone(timezone);
  const endLocal = clockOut
    ? DateTime.fromJSDate(clockOut).setZone(timezone)
    : DateTime.now().setZone(timezone);

  const [startHour, startMin] = schedule.start.split(':').map(Number);
  const [endHour, endMin] = schedule.end.split(':').map(Number);

  // Validate schedule
  if (isNaN(startHour) || isNaN(endHour) || (startHour === endHour && startMin === endMin && !schedule.crossesMidnight)) {
    const totalWorked = Math.max(0, endLocal.diff(clockInLocal, 'minutes').minutes - breakMinutes);
    return { regular: totalWorked, overtime: 0 };
  }

  let scheduledStart = clockInLocal.set({ hour: startHour, minute: startMin, second: 0, millisecond: 0 });
  let scheduledEnd = clockInLocal.set({ hour: endHour, minute: endMin, second: 0, millisecond: 0 });

  if (schedule.crossesMidnight) {
    scheduledEnd = scheduledEnd.plus({ days: 1 });
    const midnight = clockInLocal.set({ hour: 24, minute: 0, second: 0, millisecond: 0 });
    const effectiveEnd = endLocal < midnight ? endLocal : midnight;
    const overlapStart = scheduledStart > clockInLocal ? scheduledStart : clockInLocal;
    const overlapEnd = effectiveEnd < scheduledEnd ? effectiveEnd : scheduledEnd;
    let regularMinutes = 0;
    if (overlapEnd > overlapStart) {
      regularMinutes = overlapEnd.diff(overlapStart, 'minutes').minutes;
    }
    const totalWorked = endLocal.diff(clockInLocal, 'minutes').minutes - breakMinutes;
    const overtimeMinutes = Math.max(0, totalWorked - regularMinutes);
    return { regular: Math.round(regularMinutes), overtime: Math.round(overtimeMinutes) };
  } else {
    const overlapStart = scheduledStart > clockInLocal ? scheduledStart : clockInLocal;
    const overlapEnd = endLocal < scheduledEnd ? endLocal : scheduledEnd;
    let regularMinutes = 0;
    if (overlapEnd > overlapStart) {
      regularMinutes = overlapEnd.diff(overlapStart, 'minutes').minutes;
    }
    const totalWorked = endLocal.diff(clockInLocal, 'minutes').minutes - breakMinutes;
    const overtimeMinutes = Math.max(0, totalWorked - regularMinutes);
    return { regular: Math.round(regularMinutes), overtime: Math.round(overtimeMinutes) };
  }
}

export async function getEmployeeStatus(userId: string): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const { rows: sessions } = await db.query(
    `SELECT * FROM attendance_sessions WHERE user_id = $1 AND work_date = $2`,
    [userId, today]
  );
  if (!sessions.length || !sessions[0].clock_in_time) return "clocked_out";
  if (sessions[0].clock_out_time) return "clocked_out";

  const { rows: punches } = await db.query(
    `SELECT * FROM punch_records WHERE session_id = $1 ORDER BY punch_time DESC LIMIT 1`,
    [sessions[0].id]
  );
  if (!punches.length) return "clocked_out";

  const last = punches[0].punch_type;
  if (last === "break_start") return "on_break";
  if (["clock_in", "break_end", "auto_clock_in"].includes(last)) return "clocked_in";
  return "clocked_out";
}

export async function getOrCreateSession(userId: string) {
  const today = new Date().toISOString().slice(0, 10);
  const { rows } = await db.query(
    `SELECT * FROM attendance_sessions WHERE user_id = $1 AND work_date = $2`,
    [userId, today]
  );
  if (rows.length) return rows[0];

  const { rows: newRows } = await db.query(
    `INSERT INTO attendance_sessions (user_id, work_date, status)
     VALUES ($1, $2, 'active') RETURNING *`,
    [userId, today]
  );
  return newRows[0];
}

export async function recordPunch(
  userId: string,
  sessionId: string,
  punchType: string,
  meta: {
    lat?: number;
    lon?: number;
    source?: string;
    remarks?: string;
    breakType?: "personal" | "work";
    breakCompleted?: boolean;
    photoData?: string;
  }
) {
  const currentStatus = await getEmployeeStatus(userId);
  const allowed = VALID_TRANSITIONS[currentStatus];

  if (!allowed || !allowed.includes(punchType)) {
    throw {
      status: 409,
      message: `Cannot perform '${punchType}' when status is '${currentStatus}'`
    };
  }

  await db.query(
    `INSERT INTO punch_records
       (user_id, session_id, punch_type, latitude, longitude, source, remarks,
        break_type, break_completed, photo_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
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
    ]
  );

  await updateSessionSummary(sessionId);
}

export async function updateSessionSummary(sessionId: string) {
  // Fetch session's user_id
  const { rows: sessionRows } = await db.query(
    `SELECT user_id FROM attendance_sessions WHERE id = $1`,
    [sessionId]
  );
  if (!sessionRows.length) return;
  const userId = sessionRows[0].user_id;

  // Fetch user's timezone
  const userTz = await getUserTimezone(userId);

  // Fetch all punches in order
  const { rows: punches } = await db.query(
    `SELECT * FROM punch_records WHERE session_id = $1 ORDER BY punch_time ASC`,
    [sessionId]
  );

  let clockInTime: Date | null = null;
  let clockOutTime: Date | null = null;
  let breakStart: Date | null = null;
  let currentBreakType: string | null = null; // 'personal' or 'work'
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
      } else if (currentBreakType === "work") {
        workBreakMinutes += breakDuration;
      } else {
        // Fallback: add to personal (old data)
        personalBreakMinutes += breakDuration;
      }
      breakStart = null;
      currentBreakType = null;
    }
  }

  // If still on break (and no clockOut), count current break time.
  // NOTE: For auto-corrected historical sessions we always insert a break_end
  // punch before the clock_out punch, so breakStart will be null here for
  // those sessions. This branch only fires for genuinely active sessions.
  if (breakStart && !clockOutTime) {
    const ongoing = Math.round((new Date().getTime() - breakStart.getTime()) / 60000);
    if (currentBreakType === "personal") {
      personalBreakMinutes += ongoing;
    } else if (currentBreakType === "work") {
      workBreakMinutes += ongoing;
    } else {
      personalBreakMinutes += ongoing;
    }
  }

  const totalBreakMinutes = personalBreakMinutes + workBreakMinutes;

  let workedMinutes = 0;
  if (clockInTime) {
    const endTime = clockOutTime || new Date();
    workedMinutes = Math.max(
      0,
      Math.round((endTime.getTime() - clockInTime.getTime()) / 60000) - totalBreakMinutes
    );
  }

  const status = clockOutTime ? "completed" : "active";

  // --- Regular / Overtime split ---
  let regularMinutes = 0;
  let overtimeMinutes = 0;
  let isOvertime = false;

  if (clockInTime) {
    const schedule = await getEffectiveSchedule(userId);
    const { regular, overtime } = computeRegularOvertime(
      clockInTime,
      clockOutTime,
      totalBreakMinutes,
      schedule,
      userTz   // 👈 pass the timezone
    );
    regularMinutes = regular;
    overtimeMinutes = overtime;
    isOvertime = overtimeMinutes > 0;
  }

  // Update the session record with new columns
  await db.query(
    `UPDATE attendance_sessions
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
     WHERE id = $11`,
    [
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
    ]
  );
}

export async function getSessionData(userId: string) {
  const today = new Date().toISOString().slice(0, 10);
  const { rows: sessions } = await db.query(
    "SELECT * FROM attendance_sessions WHERE user_id = $1 AND work_date = $2",
    [userId, today]
  );
  const session = sessions[0] || null;
  let punches = [];
  if (session) {
    const { rows } = await db.query(
      "SELECT * FROM punch_records WHERE session_id = $1 ORDER BY punch_time ASC",
      [session.id]
    );
    punches = rows;
  }
  const status = await getEmployeeStatus(userId);
  return { session, punches, status };
}

export async function getLastPunch(userId: string, sessionId: string) {
  const { rows } = await db.query(
    `SELECT * FROM punch_records
     WHERE user_id = $1 AND session_id = $2
     ORDER BY punch_time DESC LIMIT 1`,
    [userId, sessionId]
  );
  return rows[0] || null;
}

export async function getUserTimezone(userId: string): Promise<string> {
  const { rows } = await db.query(
    "SELECT timezone FROM users WHERE id = $1",
    [userId]
  );
  return rows[0]?.timezone || 'America/New_York';
}

// =============================================================================
// Auto-clock-out for previous day's active sessions
// =============================================================================
// Called at login time. Finds any session from a prior work_date that was
// never closed and closes it properly via punch records so that ALL computed
// columns (regular_minutes, overtime_minutes, personal_break_minutes,
// work_break_minutes, is_overtime) are correctly populated.
//
// Previous bug: the old implementation wrote a manual UPDATE directly to
// attendance_sessions with only worked_minutes set, leaving every other
// computed column at 0/false. It also never wrote a clock_out punch record,
// so the punch history was incomplete.
// =============================================================================
export async function autoClockOutPreviousDay(userId: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const { rows: activeSessions } = await db.query(
    `SELECT * FROM attendance_sessions
     WHERE user_id = $1 AND status = 'active' AND work_date < $2`,
    [userId, today]
  );

  for (const session of activeSessions) {
    // ── Guard: session exists but clock_in was never recorded ─────────────
    // This is an empty shell (getOrCreateSession was called but the employee
    // never actually clocked in). Just mark it completed and move on.
    if (!session.clock_in_time) {
      await db.query(
        `UPDATE attendance_sessions
         SET status = 'completed', is_auto_corrected = true
         WHERE id = $1`,
        [session.id]
      );
      continue;
    }

    // ── Anchor: end-of-work-day timestamps ────────────────────────────────
    // Clock-out is set to 23:59:59 of the work_date.
    // If there is an unclosed break, that break ends at 23:58:59 (60 s before
    // clock-out) so the punch order is valid and the break duration is
    // naturally bounded to that day.
    const workDate = new Date(session.work_date);
    const clockOutTime = new Date(workDate);
    clockOutTime.setHours(23, 59, 59, 0);

    const breakEndTime = new Date(workDate);
    breakEndTime.setHours(23, 58, 59, 0);

    // ── Close any open break ──────────────────────────────────────────────
    // Inspect the last punch for this session. If it is a break_start then
    // no matching break_end was ever recorded — insert one now so that
    // updateSessionSummary does not count the break as running until NOW().
    const { rows: lastPunchRows } = await db.query(
      `SELECT punch_type FROM punch_records
       WHERE session_id = $1
       ORDER BY punch_time DESC
       LIMIT 1`,
      [session.id]
    );

    const lastPunchType = lastPunchRows[0]?.punch_type;

    if (lastPunchType === "break_start") {
      await db.query(
        `INSERT INTO punch_records
           (user_id, session_id, punch_type, source, remarks, punch_time)
         VALUES ($1, $2, 'break_end', 'auto',
                 'Auto break-end — session not closed on previous day', $3)`,
        [userId, session.id, breakEndTime.toISOString()]
      );
    }

    // ── Insert the synthetic clock_out punch ──────────────────────────────
    // Writing to punch_records (not directly to attendance_sessions) keeps the
    // punch history consistent and lets updateSessionSummary derive every
    // computed column from the canonical source of truth.
    await db.query(
      `INSERT INTO punch_records
         (user_id, session_id, punch_type, source, remarks, punch_time)
       VALUES ($1, $2, 'clock_out', 'auto',
               'Auto clock-out — session not closed on previous day', $3)`,
      [userId, session.id, clockOutTime.toISOString()]
    );

    // ── Recompute all columns from punch records ───────────────────────────
    // This populates: clock_in_time, clock_out_time, break_minutes,
    // personal_break_minutes, work_break_minutes, worked_minutes,
    // regular_minutes, overtime_minutes, is_overtime, status = 'completed'.
    await updateSessionSummary(session.id);

    // ── Mark as auto-corrected ─────────────────────────────────────────────
    // updateSessionSummary does not touch is_auto_corrected, so we set it
    // explicitly after the recompute.
    await db.query(
      `UPDATE attendance_sessions
       SET is_auto_corrected = true
       WHERE id = $1`,
      [session.id]
    );
  }
}