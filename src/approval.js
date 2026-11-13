/**
 * Human-in-the-Loop Confirmation & Escalation Gate
 * Stateful Redis-backed two-turn approval gate for high-risk actions
 * and per-chat human operator takeover pause flags.
 */
import { store } from './store/index.js';
import { config } from './config.js';
import { privacyLog } from './privacy.js';

const DEFAULT_APPROVAL_TTL_SEC = Number(config.APPROVAL_TIMEOUT_SECONDS) || 600; // 10 minutes

/**
 * Standard positive affirmation patterns
 */
const AFFIRMATIVE_REGEX = /^(yes|y|confirm|approve|proceed|ok|sure|agree|do it|go ahead|cmd_approve)/i;

/**
 * Standard negative rejection patterns
 */
const NEGATIVE_REGEX = /^(no|n|cancel|deny|reject|abort|stop|dont|don't|cmd_deny)/i;

/**
 * Requests confirmation for a high-risk action.
 *
 * @param {string} userId - User identifier (phone or anonId)
 * @param {object} action - Action details { type, description, payload, actionId? }
 * @param {number} [ttlSec=DEFAULT_APPROVAL_TTL_SEC] - Expiration time in seconds
 * @returns {Promise<{ actionId: string, promptText: string, buttons: Array<{ id: string, title: string }> }>}
 */
export async function requestActionApproval(userId, action = {}, ttlSec = DEFAULT_APPROVAL_TTL_SEC) {
  if (!userId || !action || !action.type) {
    throw new Error('UserId and action details are required for approval gate');
  }

  const actionId = action.actionId || `act_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const description = action.description || `Execute action: ${action.type}`;

  const record = {
    actionId,
    type: action.type,
    description,
    payload: action.payload || {},
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlSec * 1000,
    status: 'pending',
  };

  const key = `approval:pending:${userId}`;
  await store.set(key, record, ttlSec);

  privacyLog('info', 'APPROVAL_REQUESTED', {
    user: userId,
    actionId,
    type: action.type,
    ttlSec,
  });

  const promptText = `⚠️ *Action Confirmation Required:*\n\n${description}\n\nPlease confirm if you would like to proceed:`;
  const buttons = [
    { id: `approve_action_${actionId}`, title: '✅ Confirm' },
    { id: `deny_action_${actionId}`, title: '❌ Cancel' },
  ];

  return {
    actionId,
    promptText,
    buttons,
  };
}

/**
 * Retrieves an active pending approval for a user.
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
export async function getPendingApproval(userId) {
  if (!userId) return null;
  const key = `approval:pending:${userId}`;
  const record = await store.get(key);
  if (!record) return null;

  if (record.expiresAt && Date.now() > record.expiresAt) {
    await store.del(key);
    return null;
  }

  return record;
}

/**
 * Evaluates user input against an active pending approval.
 *
 * @param {string} userId
 * @param {string} userResponse - User message or button ID
 * @returns {Promise<{ hasPending: boolean, resolved: boolean, approved?: boolean, action?: object, message?: string }>}
 */
export async function resolveApproval(userId, userResponse = '') {
  if (!userId) {
    return { hasPending: false, resolved: false };
  }

  const pending = await getPendingApproval(userId);
  if (!pending) {
    return { hasPending: false, resolved: false };
  }

  const key = `approval:pending:${userId}`;
  const trimmed = String(userResponse || '').trim();

  // Check button ID direct match
  const isApproveButton = trimmed === `approve_action_${pending.actionId}` || trimmed === 'cmd_approve';
  const isDenyButton = trimmed === `deny_action_${pending.actionId}` || trimmed === 'cmd_deny';

  if (isApproveButton || AFFIRMATIVE_REGEX.test(trimmed)) {
    await store.del(key);
    privacyLog('info', 'APPROVAL_RESOLVED_APPROVED', {
      user: userId,
      actionId: pending.actionId,
      type: pending.type,
    });
    return {
      hasPending: true,
      resolved: true,
      approved: true,
      action: pending,
      message: `✅ Action approved: *${pending.description}*`,
    };
  }

  if (isDenyButton || NEGATIVE_REGEX.test(trimmed)) {
    await store.del(key);
    privacyLog('info', 'APPROVAL_RESOLVED_DENIED', {
      user: userId,
      actionId: pending.actionId,
      type: pending.type,
    });
    return {
      hasPending: true,
      resolved: true,
      approved: false,
      action: pending,
      message: `❌ Action cancelled: *${pending.description}*`,
    };
  }

  return {
    hasPending: true,
    resolved: false,
    action: pending,
    message: `⚠️ *Confirmation Pending:*\n${pending.description}\n\nPlease reply with *Confirm* / *Yes* to proceed, or *Cancel* / *No* to abort.`,
  };
}

/**
 * Cancels or clears a pending approval without executing.
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function cancelPendingApproval(userId) {
  if (!userId) return false;
  return await store.del(`approval:pending:${userId}`);
}

/**
 * Sets or updates the human handoff status for a user.
 *
 * @param {string} userId
 * @param {boolean} enabled - True to pause bot, false to resume bot
 * @param {string} [reason=''] - Reason for handoff
 * @param {string} [operatorId=''] - Assigned operator identifier
 * @returns {Promise<boolean>}
 */
export async function setHumanHandoff(userId, enabled, reason = '', operatorId = '') {
  if (!userId) return false;
  const key = `handoff:active:${userId}`;

  if (enabled) {
    const record = {
      userId,
      enabled: true,
      reason: reason || 'User requested human agent assistance',
      operatorId: operatorId || 'unassigned',
      timestamp: Date.now(),
    };
    await store.set(key, record);
    await store.sadd('handoff:active_users', userId);
    privacyLog('info', 'HUMAN_HANDOFF_ACTIVATED', { user: userId, reason });
  } else {
    await store.del(key);
    await store.srem('handoff:active_users', userId);
    privacyLog('info', 'HUMAN_HANDOFF_DEACTIVATED', { user: userId });
  }

  return true;
}

/**
 * Checks if human handoff is currently active for a user.
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function isHumanHandoffActive(userId) {
  if (!userId) return false;
  const record = await store.get(`handoff:active:${userId}`);
  return Boolean(record && record.enabled === true);
}

/**
 * Clears human handoff and resumes autonomous bot operation.
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function clearHumanHandoff(userId) {
  return await setHumanHandoff(userId, false);
}

/**
 * Lists all active human handoff conversations for the admin dashboard.
 * @returns {Promise<Array<object>>}
 */
export async function listActiveHandoffs() {
  const userIds = await store.smembers('handoff:active_users');
  const results = [];

  for (const uid of userIds || []) {
    const rec = await store.get(`handoff:active:${uid}`);
    if (rec && rec.enabled) {
      results.push(rec);
    } else {
      // Clean up orphaned index member
      await store.srem('handoff:active_users', uid);
    }
  }

  return results;
}
