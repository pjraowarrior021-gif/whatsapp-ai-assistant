/**
 * Moderation Agent.
 *
 * Deterministic detectors produce findings; this agent records them, decides
 * whether a warning is permitted, and escalates anything uncertain. It never
 * deletes messages or removes members on its own.
 */
import { analyzeMessage, SEVERITY } from '../moderation-detector.js';

export class ModerationAgent {
  /**
   * @param {{ moderationStore: object, spamTracker: object, audit: object, config: object, clock?: () => number }} options
   */
  constructor({ moderationStore, spamTracker, audit, config, clock = () => Date.now() }) {
    this.moderationStore = moderationStore;
    this.spamTracker = spamTracker;
    this.audit = audit;
    this.config = config;
    this.clock = clock;
    this.warnedAt = new Map(); // `${groupJid}|${sender}` -> timestamp
  }

  /**
   * @param {{ groupJid: string, senderJid: string, senderIsAdmin?: boolean, text: string, messageId?: string, settings: object, mentionCount?: number }} input
   * @returns {Promise<{ finding: object, event: object|null, warnText: string|null, escalate: boolean }>}
   */
  async evaluate({
    groupJid,
    senderJid,
    senderIsAdmin = false,
    text,
    messageId = '',
    settings = {},
    mentionCount = 0,
  }) {
    const moderation = settings.moderation || {};
    if (moderation.enabled === false) {
      return { finding: emptyFinding(), event: null, warnText: null, escalate: false };
    }

    const spamCount = this.spamTracker.observe({
      groupJid,
      senderJid,
      text,
      now: this.clock(),
      windowMs: moderation.repeatedWindowMs || 600000,
    });

    const finding = analyzeMessage({ text, settings, spamCount, mentionCount });
    if (finding.severity === SEVERITY.NONE) {
      return { finding, event: null, warnText: null, escalate: false };
    }

    // Group admins are trusted for moderator purposes; the finding is recorded
    // but no automated action is taken.
    if (senderIsAdmin) {
      const event = await this.moderationStore.record({
        groupJid,
        messageId,
        senderJid,
        categories: finding.categories,
        severity: finding.severity,
        reasons: [...finding.reasons, 'Sender is a group admin; no automated action'],
        action: 'none',
        status: 'dismissed',
        excerpt: excerpt(text),
      });
      return { finding, event, warnText: null, escalate: false };
    }

    const action = decideAction(finding, moderation);
    const escalate = finding.requiresHuman || action === 'escalate';
    const warnText = action === 'warn' ? this.#buildWarning({ finding, settings, groupJid, senderJid }) : null;

    const event = await this.moderationStore.record({
      groupJid,
      messageId,
      senderJid,
      categories: finding.categories,
      severity: finding.severity,
      reasons: finding.reasons,
      action,
      status: escalate ? 'escalated' : 'open',
      excerpt: excerpt(text),
    });

    await this.audit
      .record({
        groupJid,
        actor: 'moderation-agent',
        action: 'moderation_finding',
        detail: {
          eventId: event.id,
          severity: finding.severity,
          categories: finding.categories,
          action,
          escalated: escalate,
        },
      })
      .catch(() => {});

    return { finding, event, warnText, escalate };
  }

  /**
   * Called by the transport after a warning was delivered. Records delivery so
   * the cooldown survives only as a best-effort in-memory guard.
   */
  markWarned(groupJid, senderJid) {
    this.warnedAt.set(`${groupJid}|${senderJid}`, this.clock());
  }

  #buildWarning({ finding, settings, groupJid, senderJid }) {
    const cooldown = Number(settings.moderation?.warnCooldownMs) || 0;
    const key = `${groupJid}|${senderJid}`;
    const last = this.warnedAt.get(key) || 0;
    if (cooldown > 0 && this.clock() - last < cooldown) return null;

    const reasons = finding.reasons.slice(0, 2).join('; ');
    const label = finding.categories.includes('scam')
      ? 'possible scam'
      : finding.categories.includes('spam')
        ? 'spam'
        : finding.categories.includes('suspicious_link')
          ? 'a suspicious link'
          : 'inappropriate content';
    return `⚠️ Friendly reminder: this message looks like ${label} (${reasons}). Please avoid posting it again. A human admin may review this.`;
  }
}

function decideAction(finding, moderation) {
  if (finding.severity === SEVERITY.HIGH || finding.requiresHuman) return 'escalate';
  if (moderation.warnEnabled === false) return 'escalate';
  if (moderation.action === 'warn' && finding.severity === SEVERITY.MEDIUM) return 'warn';
  return 'escalate';
}

function excerpt(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function emptyFinding() {
  return { severity: SEVERITY.NONE, categories: [], reasons: [], requiresHuman: false, suggestedAction: 'none' };
}
