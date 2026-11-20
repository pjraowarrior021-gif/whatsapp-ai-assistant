/**
 * Defaults and validation for per-group configuration.
 *
 * New groups always start disabled. Nothing in this file may enable a group
 * implicitly.
 */

export const RESPONSE_MODES = Object.freeze({
  MENTION: 'mention',
  PREFIX: 'prefix',
  ALL: 'all',
  NEVER: 'never',
});

export const MODERATION_ACTIONS = Object.freeze({
  ESCALATE: 'escalate',
  WARN: 'warn',
  DELETE: 'delete',
});

export const GROUP_PERSONAS = Object.freeze({
  professional: 'Professional and concise. Clear, neutral, no slang, no filler.',
  friendly: 'Warm and approachable. Short, human, lightly informal, never over-familiar.',
  concise: 'Extremely brief. One or two sentences. No preamble.',
  moderator: 'Calm authority. Focused on keeping the group safe and on-topic.',
  assistant: 'Helpful general-purpose assistant for the group.',
});

/**
 * @typedef {object} GroupSettings
 */

/** @returns {GroupSettings} */
export function defaultGroupSettings() {
  return {
    persona: 'professional',
    customPersona: '',
    responseMode: RESPONSE_MODES.MENTION,
    triggerPrefix: '/',
    botAliases: [],
    replyCooldownMs: 15000,
    maxRepliesPerHour: 30,
    maxReplyChars: 1400,
    respondToQuestions: true,
    processPreActivationHistory: false,
    welcomeNewMembers: false,
    welcomeMessage: '',
    allowAnnouncements: false,
    requireAnnouncementApproval: true,
    adminJids: [],
    models: {
      chat: '',
      moderation: '',
      summary: '',
      report: '',
      memory: '',
    },
    moderation: {
      enabled: true,
      antiSpam: true,
      suspiciousLinks: true,
      scamDetection: true,
      bannedWords: [],
      blockedDomains: [],
      repeatedMessageThreshold: 3,
      repeatedWindowMs: 10 * 60 * 1000,
      action: MODERATION_ACTIONS.ESCALATE,
      warnEnabled: true,
      warnCooldownMs: 6 * 60 * 60 * 1000,
      notifyInGroup: false,
      maxMentions: 12,
      muteAfterWarnings: 3,
    },
    memory: {
      autoCapture: true,
      maxFacts: 200,
      summarizeDaily: true,
    },
    reports: {
      daily: true,
      weekly: true,
      hour: 21,
      timezone: 'Asia/Kolkata',
      sendToGroup: false,
    },
  };
}

/**
 * Deep-merges known settings onto defaults and drops unknown top-level keys.
 * Values are validated/clamped so a bad dashboard payload cannot loosen a
 * security boundary (e.g. a string "false" cannot disable moderation).
 * @param {object} patch
 * @param {GroupSettings} [base]
 * @returns {GroupSettings}
 */
export function mergeGroupSettings(patch = {}, base = defaultGroupSettings()) {
  const next = { ...base };
  if (!patch || typeof patch !== 'object') return next;

  if (typeof patch.persona === 'string' && (GROUP_PERSONAS[patch.persona] || patch.persona === 'custom')) {
    next.persona = patch.persona;
  }
  if (typeof patch.customPersona === 'string') next.customPersona = patch.customPersona.slice(0, 2000);
  if (Object.values(RESPONSE_MODES).includes(patch.responseMode)) next.responseMode = patch.responseMode;
  if (typeof patch.triggerPrefix === 'string' && patch.triggerPrefix.trim()) {
    next.triggerPrefix = patch.triggerPrefix.trim().slice(0, 5);
  }
  if (Array.isArray(patch.botAliases)) {
    next.botAliases = patch.botAliases
      .map((a) => String(a).trim().slice(0, 32))
      .filter(Boolean)
      .slice(0, 20);
  }
  if (patch.replyCooldownMs !== undefined) next.replyCooldownMs = clampInt(patch.replyCooldownMs, 0, 3600000, 15000);
  if (patch.maxRepliesPerHour !== undefined) {
    next.maxRepliesPerHour = clampInt(patch.maxRepliesPerHour, 1, 500, 30);
  }
  if (patch.maxReplyChars !== undefined) next.maxReplyChars = clampInt(patch.maxReplyChars, 200, 3000, 1400);
  if (patch.respondToQuestions !== undefined) next.respondToQuestions = Boolean(patch.respondToQuestions);
  if (patch.processPreActivationHistory !== undefined) {
    next.processPreActivationHistory = Boolean(patch.processPreActivationHistory);
  }
  if (patch.welcomeNewMembers !== undefined) next.welcomeNewMembers = Boolean(patch.welcomeNewMembers);
  if (typeof patch.welcomeMessage === 'string') next.welcomeMessage = patch.welcomeMessage.slice(0, 1000);
  if (patch.allowAnnouncements !== undefined) next.allowAnnouncements = Boolean(patch.allowAnnouncements);
  if (patch.requireAnnouncementApproval !== undefined) {
    next.requireAnnouncementApproval = Boolean(patch.requireAnnouncementApproval);
  }
  if (Array.isArray(patch.adminJids)) {
    next.adminJids = patch.adminJids
      .map((j) => String(j).trim())
      .filter(Boolean)
      .slice(0, 50);
  }

  if (patch.models && typeof patch.models === 'object') {
    for (const key of Object.keys(next.models)) {
      if (typeof patch.models[key] === 'string') {
        next.models[key] = patch.models[key].trim().slice(0, 200);
      }
    }
  }

  if (patch.moderation && typeof patch.moderation === 'object') {
    const m = patch.moderation;
    next.moderation = { ...next.moderation };
    if (m.enabled !== undefined) next.moderation.enabled = Boolean(m.enabled);
    if (m.antiSpam !== undefined) next.moderation.antiSpam = Boolean(m.antiSpam);
    if (m.suspiciousLinks !== undefined) next.moderation.suspiciousLinks = Boolean(m.suspiciousLinks);
    if (m.scamDetection !== undefined) next.moderation.scamDetection = Boolean(m.scamDetection);
    if (Array.isArray(m.bannedWords)) {
      next.moderation.bannedWords = m.bannedWords
        .map((w) => String(w).trim().toLowerCase().slice(0, 60))
        .filter(Boolean)
        .slice(0, 200);
    }
    if (Array.isArray(m.blockedDomains)) {
      next.moderation.blockedDomains = m.blockedDomains
        .map((d) => String(d).trim().toLowerCase().slice(0, 253))
        .filter(Boolean)
        .slice(0, 200);
    }
    if (m.repeatedMessageThreshold !== undefined) {
      next.moderation.repeatedMessageThreshold = clampInt(m.repeatedMessageThreshold, 2, 20, 3);
    }
    if (m.repeatedWindowMs !== undefined) {
      next.moderation.repeatedWindowMs = clampInt(m.repeatedWindowMs, 10000, 86400000, 600000);
    }
    if (Object.values(MODERATION_ACTIONS).includes(m.action)) next.moderation.action = m.action;
    if (m.warnEnabled !== undefined) next.moderation.warnEnabled = Boolean(m.warnEnabled);
    if (m.warnCooldownMs !== undefined) {
      next.moderation.warnCooldownMs = clampInt(m.warnCooldownMs, 0, 86400000, 21600000);
    }
    if (m.notifyInGroup !== undefined) next.moderation.notifyInGroup = Boolean(m.notifyInGroup);
    if (m.maxMentions !== undefined) next.moderation.maxMentions = clampInt(m.maxMentions, 2, 100, 12);
    if (m.muteAfterWarnings !== undefined) {
      next.moderation.muteAfterWarnings = clampInt(m.muteAfterWarnings, 1, 20, 3);
    }
  }

  if (patch.memory && typeof patch.memory === 'object') {
    next.memory = { ...next.memory };
    if (patch.memory.autoCapture !== undefined) next.memory.autoCapture = Boolean(patch.memory.autoCapture);
    if (patch.memory.maxFacts !== undefined) next.memory.maxFacts = clampInt(patch.memory.maxFacts, 10, 2000, 200);
    if (patch.memory.summarizeDaily !== undefined) {
      next.memory.summarizeDaily = Boolean(patch.memory.summarizeDaily);
    }
  }

  if (patch.reports && typeof patch.reports === 'object') {
    next.reports = { ...next.reports };
    if (patch.reports.daily !== undefined) next.reports.daily = Boolean(patch.reports.daily);
    if (patch.reports.weekly !== undefined) next.reports.weekly = Boolean(patch.reports.weekly);
    if (patch.reports.hour !== undefined) next.reports.hour = clampInt(patch.reports.hour, 0, 23, 21);
    if (typeof patch.reports.timezone === 'string' && patch.reports.timezone.trim()) {
      next.reports.timezone = patch.reports.timezone.trim().slice(0, 64);
    }
    if (patch.reports.sendToGroup !== undefined) next.reports.sendToGroup = Boolean(patch.reports.sendToGroup);
  }

  return next;
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}
