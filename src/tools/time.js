/**
 * Real-Time World Clock Tool
 * Returns formatted time, date, and day of week across global timezones.
 */
import { config } from '../config.js';

export async function getCurrentTime(args = {}) {
  const tz = args.timezone || config.TIMEZONE || 'Asia/Kolkata';
  const now = new Date();

  try {
    const formatted = now.toLocaleString('en-US', {
      timeZone: tz,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    });

    return {
      status: 'success',
      timezone: tz,
      current_time: formatted,
      iso: now.toISOString(),
    };
  } catch {
    // If invalid timezone, fallback to server timezone
    const fallbackFormatted = now.toLocaleString('en-US', {
      timeZone: config.TIMEZONE || 'Asia/Kolkata',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    });
    return {
      status: 'success',
      timezone: config.TIMEZONE || 'Asia/Kolkata',
      current_time: fallbackFormatted,
      note: `Requested timezone '${tz}' was invalid; defaulted to ${config.TIMEZONE || 'Asia/Kolkata'}.`,
    };
  }
}
