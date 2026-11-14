/**
 * Scheduled Reminders Module
 * Handles scheduling, in-memory volatile execution, 30s background sweep,
 * and optional atomic persistence to .data/reminders.json.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { config, normalizePhoneNumber } from './config.js';
import { privacyLog } from './privacy.js';
import { sendProactiveMessage, isWithinSessionWindow } from './templates.js';
import { sendWhatsAppButtons } from './whatsapp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const getDataDir = () => config.DATA_DIR || path.resolve(__dirname, '../.data');
const getRemindersFile = () => path.join(getDataDir(), 'reminders.json');

const MAX_REMINDERS_PER_USER = 20;
const MAX_REMINDER_TEXT_LENGTH = 500;

// In-Memory store: Map<reminderId, { id, anonId, to, text, targetTimeMs, timerId }>
const activeReminders = new Map();
let sweeperInterval = null;

/**
 * Formats an epoch timestamp or Date object into a readable string in the configured timezone.
 * @param {number|Date} dateOrMs
 * @returns {string}
 */
export function formatReminderTime(dateOrMs) {
  const d = typeof dateOrMs === 'number' ? new Date(dateOrMs) : dateOrMs;
  return d.toLocaleString('en-IN', {
    timeZone: config.TIMEZONE || 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Parses user-provided reminder time strings.
 * Supports:
 * - Relative: '10m', '2h', '1d', '30s'
 * - Absolute 24h time: '14:30' (today, or tomorrow if already passed)
 * - Explicit date and time: '25-12-2026 09:30'
 *
 * @param {string} whenStr
 * @param {Date} [now=new Date()]
 * @returns {{ targetTimeMs: number, readableTarget: string } | null}
 */
export function parseReminderTime(whenStr, now = new Date()) {
  if (!whenStr || typeof whenStr !== 'string') return null;
  const trimmed = whenStr.trim();
  const nowMs = now.getTime();

  // 1. Relative offset (e.g. 15m, 2h, 1d, 30s)
  const relMatch = trimmed.match(/^(\d+)\s*(s|sec|m|min|h|hr|d|day)s?$/i);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    let msToAdd = 0;

    if (unit.startsWith('s')) {
      msToAdd = amount * 1000;
    } else if (unit.startsWith('m')) {
      msToAdd = amount * 60 * 1000;
    } else if (unit.startsWith('h')) {
      msToAdd = amount * 60 * 60 * 1000;
    } else if (unit.startsWith('d')) {
      msToAdd = amount * 24 * 60 * 60 * 1000;
    }

    if (msToAdd <= 0) return null;
    const targetTimeMs = nowMs + msToAdd;
    return {
      targetTimeMs,
      readableTarget: formatReminderTime(targetTimeMs),
    };
  }

  // 2. Absolute 24-hour time: HH:MM
  const timeMatch = trimmed.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (timeMatch) {
    const hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);

    const targetDate = new Date(now);
    targetDate.setHours(hours, minutes, 0, 0);

    // If time has already passed today, schedule for tomorrow
    if (targetDate.getTime() <= nowMs) {
      targetDate.setDate(targetDate.getDate() + 1);
    }

    return {
      targetTimeMs: targetDate.getTime(),
      readableTarget: formatReminderTime(targetDate),
    };
  }

  // 3. Absolute date & time: DD-MM-YYYY HH:MM
  const dateTimeMatch = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})\s+([01]?\d|2[0-3]):([0-5]\d)$/);
  if (dateTimeMatch) {
    const day = parseInt(dateTimeMatch[1], 10);
    const month = parseInt(dateTimeMatch[2], 10);
    const year = parseInt(dateTimeMatch[3], 10);
    const hours = parseInt(dateTimeMatch[4], 10);
    const minutes = parseInt(dateTimeMatch[5], 10);

    const targetDate = new Date(year, month - 1, day, hours, minutes, 0, 0);
    if (isNaN(targetDate.getTime()) || targetDate.getTime() <= nowMs) {
      return null;
    }

    return {
      targetTimeMs: targetDate.getTime(),
      readableTarget: formatReminderTime(targetDate),
    };
  }

  return null;
}

/**
 * Atomically writes current reminders to disk if persistence is enabled.
 */
function savePersistedReminders() {
  if (!config.REMINDERS_PERSIST) return;

  try {
    const dataDir = getDataDir();
    const remindersFile = getRemindersFile();
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const serializable = Array.from(activeReminders.values()).map((r) => ({
      id: r.id,
      anonId: r.anonId,
      to: r.to,
      text: r.text,
      targetTimeMs: r.targetTimeMs,
    }));

    const tmpPath = `${remindersFile}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(serializable, null, 2), 'utf-8');
    fs.renameSync(tmpPath, remindersFile);
  } catch (err) {
    privacyLog('error', 'REMINDERS_PERSIST_SAVE_FAILED', { error: err.message });
  }
}

/**
 * Loads reminders from disk on startup if persistence is enabled.
 */
function loadPersistedReminders() {
  if (!config.REMINDERS_PERSIST) return;

  try {
    const remindersFile = getRemindersFile();
    if (fs.existsSync(remindersFile)) {
      const data = fs.readFileSync(remindersFile, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.id && item.targetTimeMs && item.text && item.to) {
            scheduleTimer(item);
          }
        }
        privacyLog('info', 'REMINDERS_LOADED_FROM_DISK', { count: activeReminders.size });
      }
    }
  } catch (err) {
    privacyLog('warn', 'REMINDERS_LOAD_FROM_DISK_FAILED', { error: err.message });
  }
}

/**
 * Fires a reminder notification back to the user via WhatsApp.
 * @param {string} reminderId
 */
async function fireReminder(reminderId) {
  const reminder = activeReminders.get(reminderId);
  if (!reminder) return;

  if (reminder.timerId) {
    clearTimeout(reminder.timerId);
  }
  reminder.fired = true;
  reminder.firedAt = Date.now();
  savePersistedReminders();

  privacyLog('info', 'REMINDER_FIRED', { user: reminder.anonId, reminderId });

  const message = `⏰ *Reminder:*\n${reminder.text}`;
  const buttons = [
    { id: `rem_done_${reminder.id}`, title: '✅ Done' },
    { id: `rem_snooze_${reminder.id}`, title: '⏱️ Snooze 15m' },
    { id: `rem_dismiss_${reminder.id}`, title: '❌ Dismiss' },
  ];

  try {
    if (await isWithinSessionWindow(reminder.to)) {
      await sendWhatsAppButtons(reminder.to, message, buttons);
    } else {
      await sendProactiveMessage(reminder.to, {
        text: message,
        templateName: config.TEMPLATE_PROACTIVE_NAME || 'utility_reminder_notification',
        templateParams: [reminder.text],
      });
    }
  } catch (err) {
    privacyLog('warn', 'REMINDER_DISPATCH_FAILED', { error: err.message });
  }
}

/**
 * Sets up a timer for a reminder.
 * @param {object} reminder
 */
function scheduleTimer(reminder) {
  const now = Date.now();
  const delayMs = Math.max(0, reminder.targetTimeMs - now);

  // If timer is within max 32-bit integer timeout (~24.8 days)
  if (delayMs < 2147483647) {
    reminder.timerId = setTimeout(() => {
      fireReminder(reminder.id).catch(() => {});
    }, delayMs);

    if (reminder.timerId && reminder.timerId.unref) {
      reminder.timerId.unref();
    }
  }

  activeReminders.set(reminder.id, reminder);
}

/**
 * Schedules a new reminder for an authorized user.
 *
 * @param {string} from - Recipient phone number
 * @param {string} anonId - Anonymized user identifier
 * @param {string} whenStr - When to fire
 * @param {string} reminderText - Reminder description
 * @returns {{ success: boolean, message: string, reminder?: object }}
 */
export function scheduleReminder(from, anonId, whenStr, reminderText) {
  if (!reminderText || !reminderText.trim()) {
    return {
      success: false,
      message: '⚠️ *Reminder Error:* Please provide a reminder description.\n_Example:_ `/remind 30m Check oven`',
    };
  }

  // Count active reminders for this user
  let userCount = 0;
  for (const r of activeReminders.values()) {
    if (r.anonId === anonId) userCount++;
  }

  if (userCount >= MAX_REMINDERS_PER_USER) {
    return {
      success: false,
      message: `⚠️ *Limit Reached:* You have reached the maximum of ${MAX_REMINDERS_PER_USER} active reminders. Please delete old ones using \`/remind delete <id>\`.`,
    };
  }

  const parsedTime = parseReminderTime(whenStr);
  if (!parsedTime) {
    return {
      success: false,
      message: [
        '⚠️ *Invalid Reminder Format:*',
        'Please specify a valid time format:',
        '• Relative: `/remind 10m Take a break` (e.g. `10m`, `2h`, `1d`)',
        '• Time: `/remind 14:30 Meeting with team`',
        '• Date & Time: `/remind 25-12-2026 09:00 Christmas morning`',
      ].join('\n'),
    };
  }

  const cleanText = reminderText.trim().substring(0, MAX_REMINDER_TEXT_LENGTH);
  const reminderId = crypto.randomBytes(3).toString('hex'); // 6-char hex ID

  const reminder = {
    id: reminderId,
    anonId,
    to: normalizePhoneNumber(from),
    text: cleanText,
    targetTimeMs: parsedTime.targetTimeMs,
  };

  scheduleTimer(reminder);
  savePersistedReminders();

  privacyLog('info', 'REMINDER_SCHEDULED', {
    user: anonId,
    reminderId,
    targetTimeMs: parsedTime.targetTimeMs,
  });

  return {
    success: true,
    message: `⏰ *Reminder Scheduled:*\n• *ID:* \`${reminderId}\`\n• *Time:* ${parsedTime.readableTarget}\n• *Text:* "${cleanText}"\n\n_Type \`/reminders\` to view active reminders._`,
    reminder,
  };
}

/**
 * Returns formatted list of active reminders for a user.
 * @param {string} anonId
 * @returns {string}
 */
export function listReminders(anonId) {
  const userReminders = [];
  const now = Date.now();

  for (const r of activeReminders.values()) {
    if (r.anonId === anonId) {
      userReminders.push(r);
    }
  }

  if (userReminders.length === 0) {
    return '⏰ *Active Reminders:*\nYou have no scheduled reminders.\nSchedule one with `/remind <time> <description>`.';
  }

  userReminders.sort((a, b) => a.targetTimeMs - b.targetTimeMs);

  const lines = ['⏰ *Your Active Reminders:*', ''];
  for (const r of userReminders) {
    const timeFormatted = formatReminderTime(r.targetTimeMs);
    const diffMin = Math.round((r.targetTimeMs - now) / 60000);
    const relativeText = diffMin > 0 ? `(in ~${diffMin}m)` : '(due soon)';
    lines.push(`• *\`${r.id}\`* - ${timeFormatted} ${relativeText}\n  "${r.text}"`);
  }

  lines.push('');
  lines.push('_To cancel: `/remind delete <id>`_');
  return lines.join('\n');
}

/**
 * Deletes a scheduled reminder by its ID.
 * @param {string} anonId
 * @param {string} reminderId
 * @returns {{ success: boolean, message: string }}
 */
export function deleteReminder(anonId, reminderId) {
  if (!reminderId) {
    return {
      success: false,
      message: '⚠️ *Delete Error:* Please specify reminder ID. Example: `/remind delete a1b2c3`',
    };
  }

  const cleanId = reminderId.trim().toLowerCase();
  const reminder = activeReminders.get(cleanId);

  if (!reminder || reminder.anonId !== anonId) {
    return {
      success: false,
      message: `⚠️ *Reminder Not Found:* No active reminder found with ID \`${cleanId}\`. Type \`/reminders\` to view all.`,
    };
  }

  if (reminder.timerId) {
    clearTimeout(reminder.timerId);
  }
  activeReminders.delete(cleanId);
  savePersistedReminders();

  privacyLog('info', 'REMINDER_DELETED', { user: anonId, reminderId: cleanId });

  return {
    success: true,
    message: `🗑️ *Reminder Cancelled:*\nReminder \`${cleanId}\` ("${reminder.text}") has been deleted.`,
  };
}

/**
 * Snoozes an active or recently fired reminder by a specified number of minutes.
 *
 * @param {string} reminderId
 * @param {number} [minutes=15]
 * @returns {{ success: boolean, message: string, reminder?: object }}
 */
export function snoozeReminder(reminderId, minutes = 15) {
  if (!reminderId) {
    return { success: false, message: 'Missing reminder ID to snooze.' };
  }

  const cleanId = reminderId.trim().toLowerCase();
  const reminder = activeReminders.get(cleanId);
  if (!reminder) {
    return { success: false, message: `⚠️ *Reminder Not Found:* No active reminder with ID \`${cleanId}\`.` };
  }

  if (reminder.timerId) {
    clearTimeout(reminder.timerId);
  }

  const newTargetMs = Date.now() + Math.max(1, minutes) * 60 * 1000;
  reminder.targetTimeMs = newTargetMs;
  reminder.fired = false;
  reminder.firedAt = null;

  scheduleTimer(reminder);
  savePersistedReminders();

  const formattedTime = formatReminderTime(newTargetMs, reminder.to);
  privacyLog('info', 'REMINDER_SNOOZED', { reminderId: cleanId, minutes, newTargetTime: formattedTime });

  return {
    success: true,
    reminder,
    message: `⏱️ *Reminder Snoozed:* I will remind you again in ${minutes} minutes (${formattedTime}).`,
  };
}

/**
 * Marks a reminder as done/completed.
 *
 * @param {string} reminderId
 * @returns {{ success: boolean, message: string }}
 */
export function completeReminder(reminderId) {
  if (!reminderId) {
    return { success: false, message: 'Missing reminder ID to complete.' };
  }

  const cleanId = reminderId.trim().toLowerCase();
  const reminder = activeReminders.get(cleanId);
  if (!reminder) {
    return { success: false, message: `⚠️ *Reminder Not Found:* No active reminder with ID \`${cleanId}\`.` };
  }

  if (reminder.timerId) {
    clearTimeout(reminder.timerId);
  }
  activeReminders.delete(cleanId);
  savePersistedReminders();

  privacyLog('info', 'REMINDER_COMPLETED', { reminderId: cleanId });

  return {
    success: true,
    message: `✅ *Reminder Completed:* "${reminder.text}" marked as done! Great job.`,
  };
}

/**
 * 30-Second sweeper for catching missed timers or clock jumps.
 */
function runReminderSweeper() {
  const now = Date.now();
  for (const [id, r] of activeReminders.entries()) {
    if (!r.fired && r.targetTimeMs <= now) {
      fireReminder(id).catch(() => {});
    } else if (r.fired && r.firedAt && now - r.firedAt > 2 * 60 * 60 * 1000) {
      // Retain fired reminders for 2 hours so action buttons resolve, then prune
      activeReminders.delete(id);
    }
  }
}

/**
 * Initializes reminders subsystem and background sweeper.
 */
export function initReminders() {
  loadPersistedReminders();
  if (!sweeperInterval) {
    sweeperInterval = setInterval(runReminderSweeper, 30000);
    if (sweeperInterval.unref) {
      sweeperInterval.unref();
    }
  }
}

/**
 * Stops reminders subsystem (for testing and shutdown).
 */
export function stopReminders() {
  if (sweeperInterval) {
    clearInterval(sweeperInterval);
    sweeperInterval = null;
  }
  for (const r of activeReminders.values()) {
    if (r.timerId) clearTimeout(r.timerId);
  }
  activeReminders.clear();
}
