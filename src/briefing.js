/**
 * Proactive Daily Briefing Engine
 *
 * Compiles a comprehensive, personalized daily summary for users:
 * - Upcoming scheduled reminders
 * - Pending to-do tasks
 * - Active background jobs (research, document indexing, etc.)
 * - Personalized, deterministic daily highlights
 *
 * Strictly zero hallucinated events: compiles only explicit user data.
 * Supports configurable delivery schedule (hour, minute, timezone, quiet hours)
 * and manual on-demand `/briefing` requests.
 */

import { config } from './config.js';
import { privacyLog } from './privacy.js';
import { getTodos } from './todos.js';
import { listReminders } from './reminders.js';
import { jobEngine } from './job-engine.js';
import { loadUserMemory } from './memory.js';

/**
 * Default briefing settings
 */
export const DEFAULT_BRIEFING_SETTINGS = Object.freeze({
  enabled: true,
  deliveryHour: 8, // 8:00 AM
  deliveryMinute: 0,
  timezone: config.TIMEZONE || 'Asia/Kolkata',
  quietHours: {
    enabled: true,
    start: 22, // 10:00 PM
    end: 7, // 7:00 AM
  },
  lastDeliveredDate: null, // 'YYYY-MM-DD'
});

// User settings store: userId -> settings object
const userSettingsStore = new Map();

// Registered active briefing users set: Set<userId>
const registeredUsers = new Set();

let schedulerTimer = null;

/**
 * Returns briefing settings for a user, filling in defaults.
 * @param {string} userId
 * @returns {object}
 */
export function getUserBriefingSettings(userId) {
  if (!userId) return { ...DEFAULT_BRIEFING_SETTINGS };

  const existing = userSettingsStore.get(userId);
  if (!existing) {
    const fresh = {
      ...DEFAULT_BRIEFING_SETTINGS,
      quietHours: { ...DEFAULT_BRIEFING_SETTINGS.quietHours },
    };
    userSettingsStore.set(userId, fresh);
    return { ...fresh, quietHours: { ...fresh.quietHours } };
  }

  return {
    ...existing,
    quietHours: { ...existing.quietHours },
  };
}

/**
 * Updates briefing settings for a user.
 * @param {string} userId
 * @param {object} patch
 * @returns {object} Updated settings
 */
export function updateUserBriefingSettings(userId, patch = {}) {
  if (!userId) throw new Error('userId is required');

  const current = getUserBriefingSettings(userId);
  const updated = {
    ...current,
    ...patch,
  };

  if (patch.quietHours) {
    updated.quietHours = {
      ...current.quietHours,
      ...patch.quietHours,
    };
  }

  // Validate hour and minute
  if (typeof updated.deliveryHour === 'number') {
    updated.deliveryHour = Math.min(23, Math.max(0, Math.floor(updated.deliveryHour)));
  }
  if (typeof updated.deliveryMinute === 'number') {
    updated.deliveryMinute = Math.min(59, Math.max(0, Math.floor(updated.deliveryMinute)));
  }

  userSettingsStore.set(userId, updated);
  if (updated.enabled) {
    registeredUsers.add(userId);
  } else {
    registeredUsers.delete(userId);
  }

  privacyLog('info', 'BRIEFING_SETTINGS_UPDATED', {
    userId,
    enabled: updated.enabled,
    deliveryHour: updated.deliveryHour,
    deliveryMinute: updated.deliveryMinute,
  });

  return {
    ...updated,
    quietHours: { ...updated.quietHours },
  };
}

/**
 * Register user for automated daily briefings
 * @param {string} userId
 */
export function registerBriefingUser(userId) {
  if (userId) {
    registeredUsers.add(userId);
  }
}

/**
 * Unregister user from automated daily briefings
 * @param {string} userId
 */
export function unregisterBriefingUser(userId) {
  if (userId) {
    registeredUsers.delete(userId);
  }
}

/**
 * Get all registered briefing users
 * @returns {Array<string>}
 */
export function getRegisteredBriefingUsers() {
  return Array.from(registeredUsers);
}

/**
 * Checks if a given timestamp is inside configured quiet hours.
 * Handles overnight wrap-around (e.g., 22:00 to 07:00).
 * @param {object} settings
 * @param {Date} [date=new Date()]
 * @returns {boolean}
 */
export function isInQuietHours(settings, date = new Date()) {
  const quiet = settings?.quietHours;
  if (!quiet || !quiet.enabled) return false;

  const tz = settings.timezone || config.TIMEZONE || 'Asia/Kolkata';
  const localHourStr = date.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false });
  const localHour = parseInt(localHourStr, 10);

  const start = quiet.start ?? 22;
  const end = quiet.end ?? 7;

  if (start > end) {
    // Overnight window (e.g. 22:00 to 07:00)
    return localHour >= start || localHour < end;
  } else if (start < end) {
    // Daytime window
    return localHour >= start && localHour < end;
  }
  return false;
}

/**
 * Formats a date into YYYY-MM-DD for delivery deduplication.
 * @param {Date} date
 * @param {string} timezone
 * @returns {string}
 */
function getLocalDateKey(date, timezone) {
  return date.toLocaleDateString('en-CA', { timeZone: timezone }); // 'YYYY-MM-DD'
}

/**
 * Evaluates whether a daily briefing is due for delivery.
 * @param {object} settings
 * @param {Date} [now=new Date()]
 * @returns {boolean}
 */
export function isBriefingDue(settings, now = new Date()) {
  if (!settings || !settings.enabled) return false;

  // Check quiet hours
  if (isInQuietHours(settings, now)) return false;

  const tz = settings.timezone || config.TIMEZONE || 'Asia/Kolkata';
  const todayKey = getLocalDateKey(now, tz);

  // Already delivered today
  if (settings.lastDeliveredDate === todayKey) return false;

  const currentHour = parseInt(now.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }), 10);
  const currentMinute = parseInt(now.toLocaleString('en-US', { timeZone: tz, minute: 'numeric' }), 10);

  const targetHour = settings.deliveryHour ?? 8;
  const targetMinute = settings.deliveryMinute ?? 0;

  // Due if current time is at or after target delivery time
  if (currentHour > targetHour) return true;
  if (currentHour === targetHour && currentMinute >= targetMinute) return true;

  return false;
}

/**
 * Records that briefing was delivered to user today.
 * @param {string} userId
 * @param {Date} [date=new Date()]
 */
export function recordBriefingDelivered(userId, date = new Date()) {
  const current = getUserBriefingSettings(userId);
  const tz = current.timezone || config.TIMEZONE || 'Asia/Kolkata';
  current.lastDeliveredDate = getLocalDateKey(date, tz);
  userSettingsStore.set(userId, current);
}

/**
 * Helper to fetch and normalize user's active reminders without hallucinating.
 * @param {string} userId
 * @returns {Array<{ id: string, time: string, relative: string, text: string }>}
 */
export function getUserUpcomingReminders(userId) {
  try {
    const rawOutput = listReminders(userId);
    if (!rawOutput || rawOutput.includes('You have no scheduled reminders')) {
      return [];
    }

    const items = [];
    const lines = rawOutput.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Format: • *`id`* - timeFormatted (relativeText)
      const match = line.match(/• \*\`([^\`]+)\`\* - ([^(]+)(?:\((.*?)\))?/);
      if (match) {
        const id = match[1].trim();
        const time = match[2].trim();
        const relative = (match[3] || '').trim();
        let text = '';

        // Next line contains: "text"
        if (i + 1 < lines.length && lines[i + 1].trim().startsWith('"')) {
          text = lines[i + 1].trim().replace(/^"|"$/g, '');
        }

        items.push({ id, time, relative, text });
      }
    }

    return items;
  } catch (err) {
    privacyLog('warn', 'BRIEFING_REMINDERS_FETCH_FAILED', { userId, error: err.message });
    return [];
  }
}

/**
 * Helper to fetch user's pending to-dos without hallucinating.
 * @param {string} userId
 * @returns {Array<{ id: string, text: string, completed: boolean, createdAt: number }>}
 */
export function getUserPendingTodos(userId) {
  try {
    const todos = getTodos(userId);
    if (!Array.isArray(todos)) return [];
    return todos.filter((t) => !t.completed);
  } catch (err) {
    privacyLog('warn', 'BRIEFING_TODOS_FETCH_FAILED', { userId, error: err.message });
    return [];
  }
}

/**
 * Helper to fetch user's active background jobs.
 * @param {string} userId
 * @param {JobEngine} [engine=jobEngine]
 * @returns {Promise<Array<object>>}
 */
export async function getUserActiveJobs(userId, engine = jobEngine) {
  try {
    if (!engine || typeof engine.listJobs !== 'function') return [];
    const result = await engine.listJobs({ userId, limit: 20 });
    const jobs = result?.jobs || [];
    return jobs.filter((j) => ['running', 'queued'].includes(j.status));
  } catch (err) {
    privacyLog('warn', 'BRIEFING_JOBS_FETCH_FAILED', { userId, error: err.message });
    return [];
  }
}

/**
 * Attempt to extract user's preferred name or title from stored memory facts
 * @param {string} userId
 * @returns {Promise<string|null>}
 */
async function resolveUserName(userId) {
  try {
    const memory = await loadUserMemory(userId);
    if (memory && Array.isArray(memory.facts)) {
      const nameFact = memory.facts.find((f) => f.category === 'identity_name' || /my name is/i.test(f.text));
      if (nameFact) {
        const match = nameFact.text.match(/(?:my name is|call me|i am)\s+([A-Z][a-z]+)/i);
        if (match) return match[1];
        return nameFact.text.replace(/^.*(?:is|call me)\s*/i, '').trim();
      }
    }
  } catch {
    // Non-critical fallback
  }
  return null;
}

/**
 * Compile the complete Proactive Daily Briefing
 * Strictly uses explicit user data with zero hallucinations.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {Date} [params.now=new Date()]
 * @param {JobEngine} [params.engine=jobEngine]
 * @param {Array} [params.overrideReminders] - For testing or direct injection
 * @param {Array} [params.overrideTodos] - For testing or direct injection
 * @param {Array} [params.overrideJobs] - For testing or direct injection
 * @returns {Promise<{ text: string, structured: object }>}
 */
export async function compileDailyBriefing(params) {
  const {
    userId,
    now = new Date(),
    engine = jobEngine,
    overrideReminders = null,
    overrideTodos = null,
    overrideJobs = null,
  } = params;

  if (!userId) {
    throw new Error('userId is required to compile daily briefing');
  }

  const settings = getUserBriefingSettings(userId);
  const tz = settings.timezone || config.TIMEZONE || 'Asia/Kolkata';

  // 1. Resolve User Name & Date
  const userName = await resolveUserName(userId);
  const formattedDate = now.toLocaleDateString('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  // Time-appropriate greeting
  const localHour = parseInt(now.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }), 10);
  let greeting = 'Good day';
  if (localHour >= 4 && localHour < 12) greeting = 'Good morning';
  else if (localHour >= 12 && localHour < 17) greeting = 'Good afternoon';
  else if (localHour >= 17 && localHour < 22) greeting = 'Good evening';

  const greetingLine = userName ? `☀️ *${greeting}, ${userName}!*` : `☀️ *${greeting}!*`;

  // 2. Fetch Explicit User Data
  const reminders = overrideReminders ?? getUserUpcomingReminders(userId);
  const todos = overrideTodos ?? getUserPendingTodos(userId);
  const activeJobs = overrideJobs ?? (await getUserActiveJobs(userId, engine));

  // 3. Build Markdown Sections
  const lines = [
    greetingLine,
    `📅 *${formattedDate}*`,
    '',
    `📊 *Daily Snapshot:* ${reminders.length} reminder${reminders.length === 1 ? '' : 's'} | ${todos.length} pending task${todos.length === 1 ? '' : 's'} | ${activeJobs.length} active job${activeJobs.length === 1 ? '' : 's'}`,
    '━━━━━━━━━━━━━━━━━━━━',
  ];

  // Section A: Reminders
  lines.push('⏰ *Upcoming Reminders:*');
  if (reminders.length === 0) {
    lines.push('• _No reminders scheduled for today._');
  } else {
    for (const r of reminders) {
      const rel = r.relative ? ` (${r.relative})` : '';
      lines.push(`• *\`${r.id}\`* [${r.time}${rel}]\n  "${r.text}"`);
    }
  }
  lines.push('');

  // Section B: Pending To-Dos
  lines.push('📋 *Pending Tasks:*');
  if (todos.length === 0) {
    lines.push('• _All caught up! No pending tasks on your list._');
  } else {
    for (const t of todos) {
      lines.push(`• [ ] *\`${t.id}\`*: ${t.text}`);
    }
  }
  lines.push('');

  // Section C: Active Background Tasks
  lines.push('⚙️ *Active Background Tasks:*');
  if (activeJobs.length === 0) {
    lines.push('• _No background jobs currently running._');
  } else {
    for (const j of activeJobs) {
      const progressText = j.progress > 0 ? ` (${j.progress}%)` : '';
      lines.push(`• *\`${j.id}\`* - ${j.type} [${j.priority.toUpperCase()}] • _${j.status}_${progressText}`);
    }
  }
  lines.push('');

  // Section D: Deterministic Actionable Focus (Zero Hallucination)
  lines.push('🎯 *Focus Suggestion:*');
  if (reminders.length > 0) {
    const nextReminder = reminders[0];
    lines.push(`• Your next scheduled commitment: *"${nextReminder.text}"* at ${nextReminder.time}.`);
  } else if (todos.length > 0) {
    const topTodo = todos[0];
    lines.push(`• Top priority to tackle first: *"${topTodo.text}"*.`);
  } else if (activeJobs.length > 0) {
    lines.push(`• Background tasks are processing in the engine. You are free to focus on strategic work.`);
  } else {
    lines.push('• Your schedule is clear and all tasks are complete. Enjoy your focused time!');
  }

  lines.push('');
  lines.push('_Type `/todos` to manage tasks, `/remind` to set alerts, or `/briefing off` to pause daily digests._');

  const text = lines.join('\n');

  const structured = {
    userId,
    date: formattedDate,
    greeting,
    userName,
    stats: {
      remindersCount: reminders.length,
      todosCount: todos.length,
      jobsCount: activeJobs.length,
    },
    reminders,
    todos,
    activeJobs,
  };

  return { text, structured };
}

/**
 * Interactive command dispatcher for `/briefing`
 * @param {string} userId
 * @param {string} commandText
 * @param {object} [options]
 * @returns {Promise<string>} WhatsApp response message
 */
export async function handleBriefingCommand(userId, commandText = '', options = {}) {
  const parts = commandText.trim().split(/\s+/);
  const subCommand = (parts[1] || '').toLowerCase();

  const settings = getUserBriefingSettings(userId);

  if (subCommand === 'on') {
    updateUserBriefingSettings(userId, { enabled: true });
    return `✅ *Daily Briefing Enabled:*\nYou will receive your morning briefing every day at *${String(settings.deliveryHour).padStart(2, '0')}:${String(settings.deliveryMinute).padStart(2, '0')}* (${settings.timezone}).\n\nType \`/briefing\` to view it anytime on-demand.`;
  }

  if (subCommand === 'off') {
    updateUserBriefingSettings(userId, { enabled: false });
    return '⏸️ *Daily Briefing Disabled:*\nAutomated morning digests are paused. You can still type `/briefing` whenever you want an on-demand update.';
  }

  if (subCommand === 'time') {
    const timeStr = parts[2];
    const match = timeStr ? timeStr.match(/^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/) : null;

    if (!match) {
      return '⚠️ *Invalid Time Format:*\nPlease provide a 24-hour time format `HH:MM`.\n_Example:_ `/briefing time 08:30`';
    }

    const hour = parseInt(match[1], 10);
    const minute = parseInt(match[2], 10);
    updateUserBriefingSettings(userId, { deliveryHour: hour, deliveryMinute: minute, enabled: true });

    return `⏰ *Briefing Schedule Updated:*\nDaily briefing delivery time set to *${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}* (${settings.timezone}).`;
  }

  if (subCommand === 'status') {
    const statusIcon = settings.enabled ? '🟢 Enabled' : '🔴 Disabled';
    const quietHoursText = settings.quietHours?.enabled
      ? `${settings.quietHours.start}:00 - ${settings.quietHours.end}:00`
      : 'Disabled';

    return [
      '⚙️ *Daily Briefing Configuration:*',
      `• *Status:* ${statusIcon}`,
      `• *Scheduled Time:* ${String(settings.deliveryHour).padStart(2, '0')}:${String(settings.deliveryMinute).padStart(2, '0')}`,
      `• *Timezone:* ${settings.timezone}`,
      `• *Quiet Hours:* ${quietHoursText}`,
      `• *Last Delivered:* ${settings.lastDeliveredDate || 'Never today'}`,
      '',
      '_Commands:_',
      '• `/briefing on` / `/briefing off`',
      '• `/briefing time HH:MM`',
      '• `/briefing` (immediate on-demand summary)',
    ].join('\n');
  }

  // Default: Immediate on-demand briefing
  const briefing = await compileDailyBriefing({ userId, options });
  return briefing.text;
}

/**
 * Background Scheduler for automated proactive briefings
 * @param {object} [options]
 * @param {number} [options.checkIntervalMs=60000] - Frequency of schedule check
 * @param {Function} [options.sendBriefingFn] - Async function: async (userId, messageText) => void
 */
export function initBriefingScheduler(options = {}) {
  const checkIntervalMs = options.checkIntervalMs || 60000;
  const sendBriefingFn = options.sendBriefingFn;

  if (schedulerTimer) {
    clearInterval(schedulerTimer);
  }

  schedulerTimer = setInterval(async () => {
    const now = new Date();
    for (const userId of registeredUsers) {
      try {
        const settings = getUserBriefingSettings(userId);
        if (isBriefingDue(settings, now)) {
          const { text } = await compileDailyBriefing({ userId, now });
          if (typeof sendBriefingFn === 'function') {
            await sendBriefingFn(userId, text);
          }
          recordBriefingDelivered(userId, now);
          privacyLog('info', 'PROACTIVE_BRIEFING_DELIVERED', { userId });
        }
      } catch (err) {
        privacyLog('warn', 'PROACTIVE_BRIEFING_CHECK_ERROR', { userId, error: err.message });
      }
    }
  }, checkIntervalMs);

  if (schedulerTimer.unref) {
    schedulerTimer.unref();
  }

  privacyLog('info', 'BRIEFING_SCHEDULER_INITIALIZED', { checkIntervalMs });
}

/**
 * Stop background briefing scheduler
 */
export function stopBriefingScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    privacyLog('info', 'BRIEFING_SCHEDULER_STOPPED');
  }
}

/**
 * Reset all user briefing settings (useful for tests)
 */
export function resetBriefingState() {
  stopBriefingScheduler();
  userSettingsStore.clear();
  registeredUsers.clear();
}
