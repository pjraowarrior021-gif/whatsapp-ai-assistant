/**
 * Central Group Orchestrator.
 *
 * Coordinates the six agents, enforces activation before any work, and owns the
 * persistent stores. Every inbound path goes through `handleInbound`, which is
 * the single place where "is this group enabled?" is decided.
 */
import path from 'node:path';
import { config as defaultConfig } from '../config.js';
import { cloudGroupIdToJid, isCloudGroupJid, normalizeGroupJid, normalizeUserJid } from './jid.js';
import { GroupActivationStore } from './activation-store.js';
import { GroupMemoryStore } from './memory-store.js';
import { ModerationStore } from './moderation-store.js';
import { AnalyticsStore } from './analytics-store.js';
import { ApprovalStore } from './approvals.js';
import { AuditLog } from './audit.js';
import { ConversationStore } from './conversations.js';
import { DedupeStore } from './dedupe.js';
import { SpamTracker } from './moderation-detector.js';
import { SecurityAgent } from './agents/security-agent.js';
import { ConversationAgent } from './agents/conversation-agent.js';
import { ModerationAgent } from './agents/moderation-agent.js';
import { AdministrationAgent } from './agents/administration-agent.js';
import { MemoryAgent } from './agents/memory-agent.js';
import { AnalyticsAgent } from './agents/analytics-agent.js';
import { AIGateway } from '../ai-gateway/index.js';
import { AIUsageStore } from '../ai-gateway/usage-store.js';
import { PersonalWhatsAppTransport } from '../transports/personal-whatsapp.js';
import { CloudGroupTransport } from '../transports/cloud-api.js';

const SCHEDULER_INTERVAL_MS = 60 * 1000;

export class GroupOrchestrator {
  /**
   * @param {{
   *   config?: object,
   *   dataDir?: string,
   *   logger?: object,
   *   clock?: () => number,
   *   startTransports?: boolean,
   *   startScheduler?: boolean,
   *   personalTransport?: object,
   *   cloudTransport?: object,
   *   fetchImpl?: Function
   * }} [options]
   */
  constructor({
    config = defaultConfig,
    dataDir = '',
    logger = console,
    clock = () => Date.now(),
    startTransports = true,
    startScheduler = true,
    personalTransport = null,
    cloudTransport = null,
    fetchImpl = null,
  } = {}) {
    this.config = config;
    this.logger = logger;
    this.clock = clock;
    this.startTransports = startTransports;
    this.startScheduler = startScheduler;
    this.dataDir = dataDir || config.GROUP_ADMIN_DATA_DIR || path.join(config.DATA_DIR || '.data', 'group-admin');
    this.personalOverride = personalTransport;
    this.cloudOverride = cloudTransport;
    this.fetchImpl = fetchImpl;
    this.initialized = false;
    this.schedulerTimer = null;
    this.transports = {};
    this.personal = null;
  }

  async init() {
    if (this.initialized) return this;

    this.activation = await new GroupActivationStore({
      filePath: path.join(this.dataDir, 'groups.json'),
      clock: this.clock,
    }).init();

    const [memoryStore, moderationStore, analyticsStore, approvals, dedupe, usageStore] = await Promise.all([
      new GroupMemoryStore({ filePath: path.join(this.dataDir, 'memory.json') }).init(),
      new ModerationStore({ filePath: path.join(this.dataDir, 'moderation.json') }).init(),
      new AnalyticsStore({ filePath: path.join(this.dataDir, 'analytics.json'), clock: this.clock }).init(),
      new ApprovalStore({ filePath: path.join(this.dataDir, 'approvals.json'), clock: this.clock }).init(),
      new DedupeStore({ filePath: path.join(this.dataDir, 'dedupe.json') }).init(),
      new AIUsageStore({ filePath: path.join(this.dataDir, 'ai-usage.json'), clock: this.clock }).init(),
    ]);

    this.memoryStore = memoryStore;
    this.moderationStore = moderationStore;
    this.analyticsStore = analyticsStore;
    this.approvals = approvals;
    this.dedupe = dedupe;
    this.usageStore = usageStore;
    this.audit = new AuditLog({
      filePath: path.join(this.dataDir, 'audit.log'),
      maxEntries: this.config.GROUP_ADMIN_AUDIT_MAX_ENTRIES || 2000,
    });
    await this.audit.init();

    this.conversations = new ConversationStore({
      ttlMs: (Number(this.config.GROUP_ADMIN_HISTORY_TTL_MINUTES) || 360) * 60 * 1000,
      maxMessages: 60,
    });
    this.spamTracker = new SpamTracker();
    this.gateway = new AIGateway({
      config: this.config,
      usageStore: this.usageStore,
      logger: this.logger,
      fetchImpl: this.fetchImpl,
      clock: this.clock,
    });

    this.security = new SecurityAgent({
      config: this.config,
      activation: this.activation,
      audit: this.audit,
      approvals: this.approvals,
    });
    this.memoryAgent = new MemoryAgent({
      memoryStore: this.memoryStore,
      gateway: this.gateway,
      config: this.config,
      audit: this.audit,
    });
    this.conversationAgent = new ConversationAgent({
      gateway: this.gateway,
      conversations: this.conversations,
      memoryAgent: this.memoryAgent,
      config: this.config,
      logger: this.logger,
    });
    this.moderationAgent = new ModerationAgent({
      moderationStore: this.moderationStore,
      spamTracker: this.spamTracker,
      audit: this.audit,
      config: this.config,
      clock: this.clock,
    });
    this.administrationAgent = new AdministrationAgent({
      gateway: this.gateway,
      approvals: this.approvals,
      audit: this.audit,
      memoryAgent: this.memoryAgent,
      security: this.security,
      config: this.config,
    });
    this.analyticsAgent = new AnalyticsAgent({
      analyticsStore: this.analyticsStore,
      moderationStore: this.moderationStore,
      memoryAgent: this.memoryAgent,
      gateway: this.gateway,
      config: this.config,
    });

    this.cloud =
      this.cloudOverride ||
      new CloudGroupTransport({
        config: this.config,
        logger: this.logger,
        clock: this.clock,
        fetchImpl: this.fetchImpl,
      });
    this.transports.cloud = this.cloud;
    if (this.personalOverride) {
      this.personal = this.personalOverride;
    } else {
      this.personal = new PersonalWhatsAppTransport({
        config: this.config,
        logger: this.logger,
        clock: this.clock,
        onMessage: (envelope) => this.handleInbound(envelope),
        onGroups: (groups) => this.registerDiscoveredGroups(groups, 'personal'),
        onParticipants: (event) => this.handleParticipantUpdate(event),
        onPrivateMessage: async () => ({ handled: false, reason: 'private_chats_not_configured' }),
      });
    }
    this.transports.personal = this.personal;

    if (this.config.GROUP_ADMIN_IMPORT_LEGACY && this.config.ALLOWED_GROUP_IDS) {
      const legacy = [...this.config.ALLOWED_GROUP_IDS];
      if (legacy.length > 0) {
        const result = await this.activation.importLegacyGroups(legacy, { actor: 'legacy-env' });
        if (result.imported > 0) {
          await this.audit.record({
            actor: 'system',
            action: 'legacy_groups_imported',
            detail: { imported: result.imported, skipped: result.skipped },
          });
        }
      }
    }

    this.initialized = true;

    if (this.startTransports && this.personal?.enabled) {
      this.personal.start().catch((err) => {
        this.logger.error?.('[group-admin] Personal transport failed to start:', err.message);
      });
    }
    if (this.startTransports && this.config.GROUP_ADMIN_ENABLED && this.config.CLOUD_GROUPS_AUTO_DISCOVER !== false) {
      this.refreshCloudGroups().catch((err) => {
        this.logger.warn?.('[group-admin] Cloud group discovery skipped:', err.message);
      });
    }
    if (this.startScheduler) this.startSchedulerLoop();

    return this;
  }

  /* ------------------------------ activation ----------------------------- */

  async enableGroup(groupInput, { actor = 'dashboard', reason = '' } = {}) {
    const jid = this.#requireJid(groupInput);
    const group = await this.activation.setEnabled(jid, true, { actor, reason });
    this.conversations.clear(jid); // no stale context from before activation
    await this.security.record({ groupJid: jid, actor, action: 'group_enabled', detail: { reason } });
    return group;
  }

  async disableGroup(groupInput, { actor = 'dashboard', reason = '' } = {}) {
    const jid = this.#requireJid(groupInput);
    const group = await this.activation.setEnabled(jid, false, { actor, reason });
    this.conversations.clear(jid);
    await this.security.record({ groupJid: jid, actor, action: 'group_disabled', detail: { reason } });
    return group;
  }

  async updateGroupSettings(groupInput, patch, { actor = 'dashboard' } = {}) {
    const jid = this.#requireJid(groupInput);
    const group = await this.activation.updateSettings(jid, patch, { actor });
    await this.security.record({
      groupJid: jid,
      actor,
      action: 'group_settings_updated',
      detail: { keys: Object.keys(patch || {}) },
    });
    return group;
  }

  async emergencyStop(paused, { actor = 'dashboard', reason = 'Emergency stop' } = {}) {
    const state = await this.activation.setGlobalPause(paused === true, { actor, reason });
    await this.security.record({
      actor,
      action: paused ? 'global_ai_paused' : 'global_ai_resumed',
      detail: { reason },
    });
    return state;
  }

  async registerDiscoveredGroups(groups, transport = 'personal') {
    const created = [];
    for (const group of Array.isArray(groups) ? groups : []) {
      const jid = normalizeGroupJid(group?.jid);
      if (!jid) continue;
      const result = await this.activation.registerDiscoveredGroup({
        jid,
        name: group.name || '',
        transport,
        metadata: {
          participantCount: group.participantCount,
          adminJids: group.adminJids,
        },
      });
      if (result.created) {
        created.push(jid);
        await this.audit.record({
          groupJid: jid,
          actor: 'transport',
          action: 'group_discovered',
          detail: { transport, enabled: false },
        });
      }
    }
    return { discovered: created.length, groups: created };
  }

  /* --------------------------- cloud api groups -------------------------- */

  /**
   * Creates a business-owned Cloud API group. It is registered disabled like
   * any other discovery; AI never starts without an explicit enable.
   * @param {{ subject: string, description?: string, joinApprovalMode?: string }} input
   * @param {{ actor?: string }} [options]
   */
  async createCloudGroup({ subject, description = '', joinApprovalMode = '' } = {}, { actor = 'dashboard' } = {}) {
    if (!this.initialized) await this.init();
    if (this.config.CLOUD_GROUPS_ENABLED === false) throw new Error('Cloud group transport is disabled');
    if (!this.cloud || typeof this.cloud.createGroup !== 'function') {
      throw new Error('Cloud group transport is unavailable');
    }

    const result = await this.cloud.createGroup({ subject, description, joinApprovalMode });
    if (result.groupJid) {
      await this.registerDiscoveredGroups(
        [
          {
            jid: result.groupJid,
            name: String(subject || '')
              .trim()
              .slice(0, 120),
          },
        ],
        'cloud'
      );
    }
    await this.audit.record({
      groupJid: result.groupJid || null,
      actor,
      action: 'cloud_group_create_requested',
      outcome: result.pendingConfirmation ? 'pending' : 'success',
      detail: { subject: String(subject || '').slice(0, 128), joinApprovalMode },
    });
    return result;
  }

  /**
   * Lists Cloud API groups owned by this business number and registers any new
   * ones as disabled. Safe to call when Cloud credentials are absent.
   * @returns {Promise<{ discovered: object, groups: Array<object> }>}
   */
  async refreshCloudGroups() {
    if (!this.initialized) await this.init();
    if (this.config.CLOUD_GROUPS_ENABLED === false) {
      return { discovered: { discovered: 0, groups: [] }, groups: [] };
    }
    const status = this.cloud?.getStatus ? this.cloud.getStatus() : null;
    if (!status?.connected) {
      return { discovered: { discovered: 0, groups: [] }, groups: [] };
    }
    const groups = await this.cloud.refreshGroups();
    const registered = await this.registerDiscoveredGroups(groups, 'cloud');
    return { discovered: registered, groups: await this.listGroups() };
  }

  async getCloudInviteLink(groupInput) {
    const jid = this.#requireCloudJid(groupInput);
    const result = await this.cloud.getInviteLink(jid);
    await this.security.record({
      groupJid: jid,
      actor: 'dashboard',
      action: 'cloud_invite_link_viewed',
      outcome: result.verified ? 'success' : 'unverified',
    });
    return result;
  }

  async resetCloudInviteLink(groupInput, { actor = 'dashboard' } = {}) {
    const jid = this.#requireCloudJid(groupInput);
    const result = await this.cloud.resetInviteLink(jid);
    await this.security.record({
      groupJid: jid,
      actor,
      action: 'cloud_invite_link_reset',
      outcome: result.verified ? 'success' : 'unverified',
    });
    return result;
  }

  async listCloudJoinRequests(groupInput) {
    const jid = this.#requireCloudJid(groupInput);
    return this.cloud.listJoinRequests(jid);
  }

  async resolveCloudJoinRequests(groupInput, { approve = false, ids = [], actor = 'dashboard' } = {}) {
    const jid = this.#requireCloudJid(groupInput);
    const result = approve
      ? await this.cloud.approveJoinRequests(jid, ids)
      : await this.cloud.rejectJoinRequests(jid, ids);
    const approvedCount = (result.approved || result.rejected || []).length;
    await this.security.record({
      groupJid: jid,
      actor,
      action: approve ? 'cloud_join_requests_approved' : 'cloud_join_requests_rejected',
      outcome: approvedCount > 0 ? 'success' : 'unverified',
      detail: { requested: ids.length, applied: approvedCount, failed: (result.failed || []).length },
    });
    return result;
  }

  /**
   * Applies a Graph API groups webhook. Everything here is fail-closed:
   * a suspended group is disabled, and a cleared suspension is never
   * auto-enabled.
   * @param {{ field: string, groups: Array<object> }} event
   */
  async handleCloudGroupEvent(event = {}) {
    if (!this.initialized) await this.init();
    const field = String(event.field || '');
    const groups = Array.isArray(event.groups) ? event.groups : [];
    let processed = 0;

    for (const raw of groups) {
      const jid = cloudGroupIdToJid(raw?.group_id);
      if (!jid) continue;
      processed += 1;
      const type = String(raw.type || '');

      if (field === 'group_lifecycle_update') {
        if (type === 'group_create') {
          if (Array.isArray(raw.errors) && raw.errors.length > 0) {
            await this.audit.record({
              actor: 'cloud-webhook',
              action: 'cloud_group_create_failed',
              outcome: 'failed',
              detail: { subject: String(raw.subject || '').slice(0, 128) },
            });
            continue;
          }
          await this.registerDiscoveredGroups([{ jid, name: String(raw.subject || '') }], 'cloud');
          await this.audit.record({
            groupJid: jid,
            actor: 'cloud-webhook',
            action: 'cloud_group_created',
            detail: {
              joinApprovalMode: String(raw.join_approval_mode || ''),
              hasInviteLink: typeof raw.invite_link === 'string' && raw.invite_link.startsWith('https://'),
            },
          });
        } else if (type === 'group_delete') {
          await this.#disableDiscoveredGroup(jid, 'Cloud group was deleted', 'cloud-webhook');
          await this.audit.record({
            groupJid: jid,
            actor: 'cloud-webhook',
            action: 'cloud_group_deleted',
            outcome: Array.isArray(raw.errors) && raw.errors.length ? 'failed' : 'success',
          });
        }
        continue;
      }

      if (field === 'group_participants_update') {
        if (type === 'group_participants_add') {
          const added = Array.isArray(raw.added_participants) ? raw.added_participants : [];
          if (added.length > 0) {
            await this.handleParticipantUpdate({
              groupJid: jid,
              action: 'add',
              timestampMs: Number(raw.timestamp) ? Number(raw.timestamp) * 1000 : 0,
              participants: added.map((p) => ({
                jid: String(p?.wa_id || p?.user_id || p?.input || ''),
                name: String(p?.username || ''),
              })),
            });
          }
        } else if (type === 'group_participants_remove') {
          await this.audit.record({
            groupJid: jid,
            actor: 'cloud-webhook',
            action: 'cloud_participants_removed',
            detail: {
              count: Array.isArray(raw.removed_participants) ? raw.removed_participants.length : 0,
              initiatedBy: String(raw.initiated_by || 'business'),
            },
          });
        } else {
          await this.audit.record({
            groupJid: jid,
            actor: 'cloud-webhook',
            action: `cloud_${type || 'participants_update'}`,
            detail: { joinRequestId: String(raw.join_request_id || '') },
          });
        }
        continue;
      }

      if (field === 'group_settings_update') {
        const subject = raw.group_subject;
        if (subject?.update_successful === true && subject.text) {
          await this.registerDiscoveredGroups([{ jid, name: String(subject.text) }], 'cloud');
        }
        await this.audit.record({
          groupJid: jid,
          actor: 'cloud-webhook',
          action: 'cloud_group_settings_updated',
          detail: {
            subject: subject?.update_successful === true,
            description: raw.group_description?.update_successful === true,
            picture: raw.profile_picture?.update_successful === true,
          },
        });
        continue;
      }

      if (field === 'group_status_update') {
        if (type === 'group_suspend') {
          await this.#disableDiscoveredGroup(jid, 'Cloud group suspended by WhatsApp', 'cloud-webhook');
        }
        await this.audit.record({
          groupJid: jid,
          actor: 'cloud-webhook',
          action: type === 'group_suspend' ? 'cloud_group_suspended' : 'cloud_group_status_updated',
          detail: { type },
        });
      }
    }

    return { handled: true, field, processed };
  }

  async #disableDiscoveredGroup(jid, reason, actor) {
    try {
      await this.disableGroup(jid, { actor, reason });
    } catch (err) {
      if (!/not found/i.test(String(err.message))) throw err;
    }
  }

  #requireCloudJid(input) {
    const jid = this.#requireJid(input);
    if (this.config.CLOUD_GROUPS_ENABLED === false) throw new Error('Cloud group transport is disabled');
    if (!this.transports?.cloud?.getInviteLink) throw new Error('Cloud group transport is unavailable');
    if (!isCloudGroupJid(jid)) throw new Error('Not a Cloud API group');
    return jid;
  }

  /* ------------------------------- inbound ------------------------------- */

  /**
   * @param {object} envelope
   * @returns {Promise<{ handled: boolean, reason: string, action?: string }>}
   */
  async handleInbound(envelope = {}) {
    if (!this.initialized) await this.init();
    if (!envelope.isGroup || !envelope.groupJid) return { handled: false, reason: 'not_group' };

    const jid = normalizeGroupJid(envelope.groupJid);
    if (!jid) return { handled: false, reason: 'invalid_group_id' };

    if (this.#isBotSender(envelope.senderJid)) return { handled: false, reason: 'from_bot' };

    const messageKey = `${envelope.transport || 'unknown'}:${envelope.messageId || ''}`;
    if (envelope.messageId) {
      const claimed = await this.dedupe.claim(messageKey);
      if (!claimed) return { handled: false, reason: 'duplicate' };
    }

    let authorization = this.security.authorizeInbound({ groupJid: jid, timestampMs: envelope.timestampMs || 0 });
    if (!authorization.allowed && authorization.reason === 'group_not_discovered') {
      // New group: record it, always disabled, then stop.
      await this.activation.registerDiscoveredGroup({
        jid,
        name: envelope.groupName || '',
        transport: envelope.transport === 'personal' ? 'personal' : 'cloud',
      });
      authorization = this.security.authorizeInbound({ groupJid: jid, timestampMs: envelope.timestampMs || 0 });
    }
    if (!authorization.allowed) return { handled: false, reason: authorization.reason };

    const group = authorization.group;
    const settings = group.settings;
    const transport = this.transports[envelope.transport] || this.personal || this.transports.cloud;

    await this.analyticsAgent.record(jid, 'messagesSeen');
    this.conversations.addTurn(jid, {
      role: 'user',
      text: envelope.text,
      senderJid: envelope.senderJid,
      messageId: envelope.messageId,
    });

    const senderIsAdmin = await this.security.isHumanAdmin({
      groupJid: jid,
      senderJid: envelope.senderJid,
      group,
      transport,
    });

    // 1. Moderation runs before any AI reply, so we never amplify spam.
    let moderation = { finding: null, event: null, warnText: null, escalate: false };
    try {
      moderation = await this.moderationAgent.evaluate({
        groupJid: jid,
        senderJid: envelope.senderJid,
        senderIsAdmin,
        text: envelope.text,
        messageId: envelope.messageId,
        settings,
        mentionCount: envelope.mentionCount || (envelope.mentions || []).length,
      });
    } catch (err) {
      await this.audit.record({
        groupJid: jid,
        actor: 'moderation-agent',
        action: 'moderation_error',
        outcome: 'failed',
        detail: { error: err.message },
      });
    }

    if (moderation.event) {
      await this.analyticsAgent.record(jid, 'moderationEvents');
      if (moderation.warnText) {
        const sent = await this.#sendVerified(transport, jid, moderation.warnText, 'moderation_warning');
        if (sent?.verified) {
          this.moderationAgent.markWarned(jid, envelope.senderJid);
          await this.analyticsAgent.record(jid, 'warnings');
        }
      }
      if (moderation.escalate) {
        await this.analyticsAgent.record(jid, 'escalations');
        await this.#notifyAdmins(jid, {
          title: 'Moderation case escalated',
          detail: `Severity: ${moderation.finding.severity}. Categories: ${moderation.finding.categories.join(', ')}.`,
        });
      }
      // Do not generate a conversational answer for a flagged message.
      return {
        handled: true,
        reason: 'moderation',
        action: moderation.escalate ? 'escalated' : moderation.warnText ? 'warned' : 'recorded',
      };
    }

    // 2. Explicit admin commands (human admins only).
    const command = parseAdminCommand(envelope.text);
    if (command && senderIsAdmin) {
      const result = await this.#handleAdminCommand({ command, groupJid: jid, group, settings, envelope, transport });
      if (result) return { handled: true, reason: 'admin_command', action: result.action };
    }

    // 3. Explicit "remember:" capture from a human admin.
    if (senderIsAdmin && settings.memory?.autoCapture) {
      try {
        await this.memoryAgent.captureFromText(jid, envelope.text, { senderJid: envelope.senderJid });
      } catch {
        // memory capture is best effort
      }
    }

    // 4. Conversational reply.
    let reply = null;
    try {
      reply = await this.conversationAgent.handle({
        groupJid: jid,
        settings,
        envelope,
        botJids: this.#botJids(),
        botName: 'Assistant',
        groupName: group.name,
      });
    } catch (err) {
      await this.audit.record({
        groupJid: jid,
        actor: 'conversation-agent',
        action: 'conversation_error',
        outcome: 'failed',
        detail: { error: err.message },
      });
    }

    if (reply?.reply) {
      // Re-check activation immediately before sending: an emergency stop must
      // win even if it happened during the model call.
      const still = this.security.authorizeInbound({ groupJid: jid });
      if (!still.allowed) return { handled: true, reason: still.reason };

      const sent = await this.#sendVerified(transport, jid, reply.reply, 'ai_reply');
      if (sent?.verified) {
        await this.analyticsAgent.record(jid, 'aiReplies');
        await this.audit.record({
          groupJid: jid,
          actor: 'conversation-agent',
          action: 'ai_reply_sent',
          detail: { provider: reply.provider, model: reply.model, messageId: sent.id },
        });
      }
      return { handled: true, reason: 'replied', action: 'replied' };
    }

    return { handled: true, reason: reply?.reason || 'no_action' };
  }

  /**
   * @param {{ groupJid: string, action: string, participants: Array<{jid: string, name?: string}> }} event
   */
  async handleParticipantUpdate(event = {}) {
    if (!this.initialized) await this.init();
    const jid = normalizeGroupJid(event.groupJid);
    if (!jid) return { handled: false, reason: 'invalid_group_id' };

    const authorization = this.security.authorizeInbound({ groupJid: jid, timestampMs: event.timestampMs || 0 });
    if (!authorization.allowed) return { handled: false, reason: authorization.reason };

    const group = authorization.group;
    const transport = this.transports[group.transport] || this.personal;

    if (event.action === 'add') {
      for (const participant of event.participants || []) {
        await this.analyticsAgent.record(jid, 'memberJoins');
        const result = await this.administrationAgent.welcomeMember({
          groupJid: jid,
          groupName: group.name,
          memberJid: participant.jid,
          memberName: participant.name,
          settings: group.settings,
          transport,
        });
        if (result.sent) {
          await this.audit.record({
            groupJid: jid,
            actor: 'administration-agent',
            action: 'member_welcome_attempted',
            outcome: result.verified ? 'success' : 'unverified',
            detail: { memberJid: participant.jid },
          });
        }
      }
    } else {
      await this.audit.record({
        groupJid: jid,
        actor: 'transport',
        action: `participants_${event.action || 'updated'}`,
        detail: { count: (event.participants || []).length },
      });
    }
    return { handled: true, reason: 'participant_update' };
  }

  /* ------------------------------ commands ------------------------------- */

  async #handleAdminCommand({ command, groupJid, settings, envelope, transport }) {
    if (command.type === 'operation') {
      const approval = await this.administrationAgent.requestOperation({
        groupJid,
        action: command.action,
        targetJid: command.target,
        value: command.value,
        reason: `Requested in chat by ${normalizeUserJid(envelope.senderJid)}`,
        requestedBy: envelope.senderJid,
      });
      await this.#sendVerified(
        transport,
        groupJid,
        `🛡️ Request queued for human approval (${approval.approvalId}). Nothing has been changed yet.`,
        'admin_command_reply'
      );
      return { action: 'approval_requested' };
    }

    if (command.type === 'announce') {
      const result = await this.administrationAgent.requestAnnouncement({
        groupJid,
        topic: command.value,
        settings,
        requestedBy: envelope.senderJid,
      });
      if (result.status === 'pending_approval') {
        await this.#sendVerified(
          transport,
          groupJid,
          `📝 Announcement drafted and queued for human approval (${result.approvalId}). Nothing has been sent to the group yet.`,
          'admin_command_reply'
        );
      } else if (result.status === 'approved' && result.draft) {
        await this.#sendVerified(transport, groupJid, result.draft, 'announcement');
        await this.audit.record({
          groupJid,
          actor: envelope.senderJid,
          action: 'announcement_sent',
          detail: { approval: false },
        });
      }
      return { action: 'announcement' };
    }

    if (command.type === 'report') {
      const report = await this.generateReport({ groupJid, period: command.value || 'daily', send: false });
      await this.#sendVerified(transport, groupJid, report.text, 'report');
      return { action: 'report' };
    }

    if (command.type === 'summary') {
      const summary = await this.summarizeGroup({ groupJid, settings });
      if (summary?.text) {
        await this.#sendVerified(transport, groupJid, summary.text, 'summary');
      } else {
        await this.#sendVerified(transport, groupJid, 'Not enough recent conversation to summarize yet.', 'summary');
      }
      return { action: 'summary' };
    }

    return null;
  }

  /* ------------------------------- reports ------------------------------- */

  async summarizeGroup({ groupJid, settings = null, period = 'adhoc' }) {
    const jid = this.#requireJid(groupJid);
    const group = this.activation.getGroup(jid);
    const turns = this.conversations.getTurns(jid);
    if (!turns.length) return null;
    const result = await this.memoryAgent.summarize({
      groupJid: jid,
      turns,
      settings: settings || group?.settings || {},
      period,
    });
    if (result) await this.analyticsAgent.record(jid, 'summaries');
    return result;
  }

  async generateReport({ groupJid, period = 'daily', send = false } = {}) {
    const jid = this.#requireJid(groupJid);
    const group = this.activation.getGroup(jid);
    if (!group) throw new Error('Group not found');
    const report = await this.analyticsAgent.buildReport({
      groupJid: jid,
      groupName: group.name,
      period,
      settings: group.settings,
    });
    await this.analyticsAgent.record(jid, 'reports');

    if (send) {
      const transport = this.transports[group.transport] || this.personal;
      const sent = await this.#sendVerified(transport, jid, report.text, 'scheduled_report');
      if (sent?.verified) {
        await this.activation.recordReportSent(jid, period);
      }
    }
    return report;
  }

  startSchedulerLoop() {
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => {
      this.schedulerTick().catch((err) => {
        this.logger.error?.('[group-admin] Scheduler error:', err.message);
      });
    }, SCHEDULER_INTERVAL_MS);
    if (typeof this.schedulerTimer.unref === 'function') this.schedulerTimer.unref();
  }

  stopSchedulerLoop() {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
  }

  async schedulerTick(now = this.clock()) {
    if (!this.initialized || this.activation.isGloballyPaused()) return { sent: 0 };
    let sent = 0;
    for (const group of this.activation.listGroups()) {
      if (group.enabled !== true) continue;
      const settings = group.settings || {};
      const isWeeklyDay = settings.reports?.weekly && localWeekday(now, settings.reports?.timezone) === 1;
      const period = isWeeklyDay ? 'weekly' : 'daily';
      const enabled = period === 'weekly' ? settings.reports?.weekly : settings.reports?.daily;
      if (!enabled) continue;

      const lastSent = period === 'weekly' ? group.lastWeeklyReportAt : group.lastDailyReportAt;
      const due = AnalyticsAgent.isReportDue({ settings, lastSentAt: lastSent, now });
      if (!due.due) continue;

      if (settings.memory?.summarizeDaily) {
        await this.summarizeGroup({ groupJid: group.jid, settings, period: 'daily' }).catch(() => {});
      }
      const report = await this.analyticsAgent.buildReport({
        groupJid: group.jid,
        groupName: group.name,
        period,
        settings,
      });
      await this.analyticsAgent.record(group.jid, 'reports');
      if (settings.reports?.sendToGroup) {
        const transport = this.transports[group.transport] || this.personal;
        const result = await this.#sendVerified(transport, group.jid, report.text, 'scheduled_report');
        if (result?.verified) {
          sent += 1;
          await this.activation.recordReportSent(group.jid, period, new Date(now).toISOString());
        }
      } else {
        await this.activation.recordReportSent(group.jid, period, new Date(now).toISOString());
      }
    }
    return { sent };
  }

  /* ------------------------------ approvals ------------------------------ */

  async resolveApproval(approvalId, { approved, actor = 'dashboard', note = '' } = {}) {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error('Approval not found');

    const resolved = await this.approvals.resolve(approvalId, {
      approved: approved === true,
      resolvedBy: actor,
    });
    await this.security.record({
      groupJid: approval.groupJid,
      actor,
      action: approved ? 'approval_granted' : 'approval_rejected',
      detail: { approvalId, type: approval.type, note },
    });

    if (!approved) return { approval: resolved, executed: false, reason: 'rejected' };

    const group = this.activation.getGroup(approval.groupJid);
    const transport = this.transports[group?.transport] || this.personal;
    if (!transport) return { approval: resolved, executed: false, reason: 'no_transport' };

    const result = await this.administrationAgent.executeApprovedOperation({
      approval: resolved,
      transport,
      actor,
    });
    return { approval: resolved, executed: result.ok === true, result };
  }

  async resolveModerationCase(caseId, { status = 'resolved', actor = 'dashboard', note = '' } = {}) {
    const event = (this.moderationStore.list({ limit: 5000 }) || []).find((e) => e.id === caseId);
    if (!event) throw new Error('Moderation event not found');
    const resolved = await this.moderationStore.resolve(caseId, { status, resolvedBy: actor, note });
    await this.security.record({
      groupJid: event.groupJid,
      actor,
      action: 'moderation_case_resolved',
      detail: { caseId, status, note },
    });
    return resolved;
  }

  /* ------------------------------- queries ------------------------------- */

  async listGroups({ days = 1 } = {}) {
    const groups = this.activation.listGroups();
    return groups.map((group) => {
      const analytics = this.analyticsStore.getGroupSummary(group.jid, { days });
      const memory = this.memoryStore.getGroupMemory(group.jid);
      return {
        ...group,
        stats: analytics.totals,
        openModerationCases: this.moderationStore.countOpen(group.jid),
        memoryCounts: {
          rules: memory.rules.length,
          facts: memory.facts.length,
          faqs: memory.faqs.length,
          summaries: memory.summaries.length,
        },
      };
    });
  }

  async getGroupDetail(groupInput) {
    const jid = this.#requireJid(groupInput);
    const group = this.activation.getGroup(jid);
    if (!group) throw new Error('Group not found');
    return {
      group,
      analytics: this.analyticsStore.getGroupSummary(jid, { days: 7 }),
      memory: this.memoryStore.getGroupMemory(jid),
      moderation: this.moderationStore.list({ groupJid: jid, limit: 100 }),
      approvals: this.approvals.list({ groupJid: jid, limit: 50 }),
      audit: this.audit.list({ groupJid: jid, limit: 100 }),
      conversation: this.conversations.getTurns(jid).map((t) => ({
        role: t.role,
        text: t.text,
        senderJid: t.senderJid,
        at: new Date(t.at).toISOString(),
      })),
    };
  }

  getConversation(groupInput) {
    const jid = this.#requireJid(groupInput);
    return this.conversations.getTurns(jid).map((t) => ({
      role: t.role,
      text: t.text,
      senderJid: t.senderJid,
      at: new Date(t.at).toISOString(),
    }));
  }

  getModeration(groupInput, { limit = 100 } = {}) {
    return this.moderationStore.list({ groupJid: groupInput, limit });
  }

  getApprovals(groupJid = null, { status = null } = {}) {
    return this.approvals.list({ groupJid, status, limit: 200 });
  }

  getAudit({ groupJid = null, limit = 200 } = {}) {
    return this.audit.list({ groupJid, limit });
  }

  getUsage({ days = 7 } = {}) {
    return this.usageStore.getSummary({ days });
  }

  async listModels({ refresh = false, freeOnly = false } = {}) {
    return this.gateway.listAllModels({ refresh, freeOnly });
  }

  async requestAnnouncement({ groupJid, topic }) {
    const jid = this.#requireJid(groupJid);
    const group = this.activation.getGroup(jid);
    if (!group) throw new Error('Group not found');
    return this.administrationAgent.requestAnnouncement({ groupJid: jid, topic, settings: group.settings });
  }

  /**
   * Direct message sent by a human operator from the dashboard. This is an
   * explicit human action, distinct from autonomous AI output.
   */
  async sendOperatorMessage({ groupJid, text, actor = 'dashboard' }) {
    const jid = this.#requireJid(groupJid);
    const group = this.activation.getGroup(jid);
    if (!group) throw new Error('Group not found');
    if (this.activation.isGloballyPaused()) throw new Error('AI is globally paused');
    const transport = this.transports[group.transport] || this.personal;
    const result = await this.#sendVerified(transport, jid, String(text || '').slice(0, 3000), 'operator_message');
    await this.security.record({
      groupJid: jid,
      actor,
      action: 'operator_message_sent',
      outcome: result.verified ? 'success' : 'unverified',
      detail: {},
    });
    return result;
  }

  async deleteGroupData(groupInput, { actor = 'dashboard' } = {}) {
    const jid = this.#requireJid(groupInput);
    const memory = await this.memoryStore.clear(jid);
    const moderation = await this.moderationStore.clearGroup(jid);
    const analytics = await this.analyticsStore.clearGroup(jid);
    this.conversations.clear(jid);
    await this.security.record({
      groupJid: jid,
      actor,
      action: 'group_data_deleted',
      detail: { memory: memory.cleared, moderation: moderation.removed, analytics: analytics.removed },
    });
    return { memory, moderation, analytics };
  }

  status() {
    return {
      initialized: this.initialized,
      groupAdminEnabled: Boolean(this.config.GROUP_ADMIN_ENABLED),
      dataDirConfigured: Boolean(this.config.GROUP_ADMIN_DATA_DIR),
      global: this.activation ? this.activation.getGlobalState() : null,
      personal: this.personal?.getStatus ? this.personal.getStatus() : null,
      cloud: this.cloud?.getStatus ? this.cloud.getStatus() : null,
      counts: {
        groups: this.activation ? this.activation.listGroups().length : 0,
        enabledGroups: this.activation ? this.activation.listGroups().filter((g) => g.enabled).length : 0,
      },
      gateway: this.gateway ? this.gateway.describe() : null,
      schedulerRunning: Boolean(this.schedulerTimer),
    };
  }

  async shutdown() {
    this.stopSchedulerLoop();
    if (this.personal?.stop) {
      await this.personal.stop().catch(() => {});
    }
  }

  /* -------------------------------- helpers ------------------------------ */

  #requireJid(input) {
    const jid = normalizeGroupJid(input);
    if (!jid) throw new Error('Invalid group identifier');
    return jid;
  }

  #botJids() {
    if (this.personal?.botJids?.length) return this.personal.botJids;
    if (this.config.PERSONAL_WHATSAPP_PAIRING_NUMBER) {
      return [`${String(this.config.PERSONAL_WHATSAPP_PAIRING_NUMBER).replace(/\D/g, '')}@s.whatsapp.net`];
    }
    return [];
  }

  #isBotSender(senderJid) {
    const sender = normalizeUserJid(senderJid);
    if (!sender) return false;
    return this.#botJids().some((jid) => normalizeUserJid(jid) === sender);
  }

  async #sendVerified(transport, groupJid, text, kind) {
    if (!transport || typeof transport.sendText !== 'function') return { verified: false, error: 'no_transport' };
    try {
      const result = await transport.sendText(groupJid, text);
      return { ...result, verified: Boolean(result?.id || result?.messageId) };
    } catch (err) {
      await this.audit
        .record({
          groupJid,
          actor: 'orchestrator',
          action: 'outbound_message_failed',
          outcome: 'failed',
          detail: { kind, error: err.message },
        })
        .catch(() => {});
      return { verified: false, error: err.message };
    }
  }

  async #notifyAdmins(groupJid, { title, detail }) {
    const group = this.activation.getGroup(groupJid);
    const settings = group?.settings || {};
    const recipients = new Set(
      [
        ...(settings.adminJids || []),
        ...(group?.metadata?.adminJids || []),
        ...String(this.config.GROUP_ADMIN_HUMAN_ADMINS || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ].map((jid) => normalizeUserJid(jid))
    );
    if (recipients.size === 0) return;

    const transport = this.personal;
    if (!transport || typeof transport.sendDirectText !== 'function') return;
    if (transport.getStatus && transport.getStatus().state !== 'connected') return;

    const text = `🛡️ Group admin alert (${group?.name || groupJid})\n${title}\n${detail}\nOpen Mission Control → Groups for details.`;
    for (const recipient of [...recipients].slice(0, 10)) {
      try {
        await transport.sendDirectText(`${recipient}@s.whatsapp.net`, text);
      } catch {
        // best effort; the dashboard remains the source of truth
      }
    }
    await this.audit
      .record({
        groupJid,
        actor: 'system',
        action: 'admins_notified',
        detail: { count: Math.min(recipients.size, 10) },
      })
      .catch(() => {});
  }
}

/* --------------------------------- utils --------------------------------- */

/**
 * @param {string} text
 * @returns {{ type: string, action?: string, target?: string, value?: string } | null}
 */
export function parseAdminCommand(text) {
  const body = String(text || '').trim();
  if (!body.startsWith('!')) return null;

  if (/^!admin\b/i.test(body)) {
    const rest = body.replace(/^!admin\b/i, '').trim();
    const [verbRaw, ...tail] = rest.split(/\s+/);
    const verb = (verbRaw || '').toLowerCase();
    const remainder = tail.join(' ').trim();
    if (verb === 'remove' || verb === 'promote' || verb === 'demote') {
      return {
        type: 'operation',
        action: `${verb}_participant`,
        target: extractTarget(remainder),
      };
    }
    if (verb === 'subject') return { type: 'operation', action: 'set_subject', value: remainder.slice(0, 100) };
    if (verb === 'description') {
      return { type: 'operation', action: 'set_description', value: remainder.slice(0, 2000) };
    }
    return { type: 'invalid', value: 'Supported: remove, promote, demote, subject, description' };
  }

  if (/^!announce\b/i.test(body)) {
    return {
      type: 'announce',
      value: body
        .replace(/^!announce\b/i, '')
        .trim()
        .slice(0, 500),
    };
  }
  if (/^!report\b/i.test(body)) {
    const period = /\bweek(ly)?\b/i.test(body) ? 'weekly' : 'daily';
    return { type: 'report', value: period };
  }
  if (/^!summary\b/i.test(body)) return { type: 'summary' };

  return null;
}

function extractTarget(value) {
  const mention = String(value || '').match(/(\d{7,})/);
  if (mention) return mention[1];
  return '';
}

export function localWeekday(now, timezone = 'UTC') {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(new Date(now));
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
  } catch {
    return new Date(now).getUTCDay();
  }
}
