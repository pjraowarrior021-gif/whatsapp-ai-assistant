/**
 * In-Memory Metrics & Prometheus Exposition Module
 * Zero-dependency implementation strictly tracking counters and gauges in memory.
 */
import { getActiveSessionCount } from './privacy.js';

const startTime = Date.now();

// Counter stores
const messagesTotal = new Map(); // key: `${type}|${result}` -> count
const geminiRequestsTotal = new Map(); // key: `${model}|${result}` -> count
const errorsTotal = new Map(); // key: `${kind}` -> count
let mediaBytesTotal = 0;

/**
 * Records an incoming or handled message event.
 * @param {string} type - e.g. 'text', 'image', 'audio', 'document', 'interactive'
 * @param {'success' | 'rejected' | 'rate_limited' | 'quota_exceeded' | 'error'} result
 */
export function recordMessageMetric(type = 'text', result = 'success') {
  const key = `${type}|${result}`;
  messagesTotal.set(key, (messagesTotal.get(key) || 0) + 1);
}

/**
 * Records a Gemini API request attempt.
 * @param {string} model - Model identifier
 * @param {'success' | 'failed' | 'fallback'} result
 */
export function recordGeminiMetric(model = 'default', result = 'success') {
  const key = `${model}|${result}`;
  geminiRequestsTotal.set(key, (geminiRequestsTotal.get(key) || 0) + 1);
}

/**
 * Records an application error by category.
 * @param {string} kind - Error category
 */
export function recordErrorMetric(kind = 'general') {
  errorsTotal.set(kind, (errorsTotal.get(kind) || 0) + 1);
}

/**
 * Records downloaded/uploaded media bytes.
 * @param {number} bytes
 */
export function recordMediaBytes(bytes) {
  if (typeof bytes === 'number' && bytes > 0) {
    mediaBytesTotal += bytes;
  }
}

/**
 * Resets all metrics (primarily for test isolation).
 */
export function resetMetrics() {
  messagesTotal.clear();
  geminiRequestsTotal.clear();
  errorsTotal.clear();
  mediaBytesTotal = 0;
}

/**
 * Generates Prometheus text exposition format (version 0.0.4).
 * @returns {string}
 */
export function getPrometheusMetrics() {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  const activeSessions = getActiveSessionCount();

  const lines = [
    '# HELP whatsapp_bot_uptime_seconds Total seconds the assistant process has been running',
    '# TYPE whatsapp_bot_uptime_seconds gauge',
    `whatsapp_bot_uptime_seconds ${uptimeSeconds}`,
    '',
    '# HELP whatsapp_bot_active_sessions Number of currently active conversation sessions in RAM',
    '# TYPE whatsapp_bot_active_sessions gauge',
    `whatsapp_bot_active_sessions ${activeSessions}`,
    '',
    '# HELP whatsapp_bot_media_bytes_total Total media bytes processed in memory',
    '# TYPE whatsapp_bot_media_bytes_total counter',
    `whatsapp_bot_media_bytes_total ${mediaBytesTotal}`,
    '',
    '# HELP whatsapp_bot_messages_total Total incoming messages processed by type and result',
    '# TYPE whatsapp_bot_messages_total counter',
  ];

  if (messagesTotal.size === 0) {
    lines.push('whatsapp_bot_messages_total{type="text",result="success"} 0');
  } else {
    for (const [key, count] of messagesTotal.entries()) {
      const [type, result] = key.split('|');
      lines.push(`whatsapp_bot_messages_total{type="${type}",result="${result}"} ${count}`);
    }
  }

  lines.push('');
  lines.push('# HELP whatsapp_bot_gemini_requests_total Total Gemini API requests made by model and result');
  lines.push('# TYPE whatsapp_bot_gemini_requests_total counter');

  if (geminiRequestsTotal.size === 0) {
    lines.push('whatsapp_bot_gemini_requests_total{model="default",result="success"} 0');
  } else {
    for (const [key, count] of geminiRequestsTotal.entries()) {
      const [model, result] = key.split('|');
      lines.push(`whatsapp_bot_gemini_requests_total{model="${model}",result="${result}"} ${count}`);
    }
  }

  lines.push('');
  lines.push('# HELP whatsapp_bot_errors_total Total errors encountered by category');
  lines.push('# TYPE whatsapp_bot_errors_total counter');

  if (errorsTotal.size === 0) {
    lines.push('whatsapp_bot_errors_total{kind="general"} 0');
  } else {
    for (const [kind, count] of errorsTotal.entries()) {
      lines.push(`whatsapp_bot_errors_total{kind="${kind}"} ${count}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
