/**
 * Security and Permission Agent.
 *
 * This agent is the single gate for every group operation:
 *  - activation is enforced at the backend, before any AI work happens,
 *  - the global emergency stop overrides everything,
 *  - messages from before a group's enable time are ignored,
 *  - administrative operations require a verified bot-admin capability and
 *    (by default) an explicit human approval.
 */
import { normalizeGroupJid, normalizeUserJid } from '../jid.js';

const HIGH_IMPACT_ACTIONS = new Set([
  'remove_participant',
  'promote_participant',
  'demote_participant',
  'set_subject',
  'set_description',
  'set_setting',
  'announcement',
  'broadcast',
]);

export class SecurityAgent {
  /**
   * @param {{ config: object, activation: object, audit: object, approvals: object }} options
   */
  constructor({ config, activation, audit, approvals }) {
    this.config = config;
    this.activation = activation;
    this.audit = audit;
    this.approvals = approvals;
  }

  /**
   * Authorization for inbound group messages. Returns a reason so callers can
   * log (without message content) why a message was ignored.
   *
   * @param {{ groupJid: string, timestampMs?: number }} input
   * @returns {{ allowed: boolean, reason: string, group?: object }}
   */
  authorizeInbound({ groupJid, timestampMs = 0 } = {}) {
    if (!this.config.GROUP_ADMIN_ENABLED) return { allowed: false, reason: 'subsystem_disabled' };
    const jid = normalizeGroupJid(groupJid);
    if (!jid) return { allowed: false, reason: 'invalid_group_id' };
    if (this.activation.isGloballyPaused()) return { allowed: false, reason: 'global_pause' };
    const group = this.activation.getGroup(jid);
    if (!group) return { allowed: false, reason: 'group_not_discovered' };
    if (group.enabled !== true) return { allowed: false, reason: 'group_disabled' };

    // Never process a backlog from before the operator enabled the group,
    // unless the group explicitly opted into history import.
    if (timestampMs && group.enabledAt && !group.settings?.processPreActivationHistory) {
      const enabledAtMs = Date.parse(group.enabledAt);
      if (Number.isFinite(enabledAtMs) && timestampMs < enabledAtMs) {
        return { allowed: false, reason: 'before_activation', group };
      }
    }
    return { allowed: true, reason: 'ok', group };
  }

  /**
   * @param {{ groupJid: string, actor: string, action: string }} input
   */
  async record({ groupJid = null, actor = 'system', action, outcome = 'success', detail = {} }) {
    return this.audit.record({ actor, action, groupJid, outcome, detail });
  }

  /**
   * Checks configured admin lists and, when available, live group admin status.
   *
   * @param {{ groupJid: string, senderJid: string, group?: object, transport?: object }} input
   * @returns {Promise<boolean>}
   */
  async isHumanAdmin({ groupJid, senderJid, group = null, transport = null } = {}) {
    const user = normalizeUserJid(senderJid);
    if (!user) return false;

    const settings = group?.settings || this.activation.getSettings(groupJid) || {};
    const configured = [
      ...(settings.adminJids || []),
      ...(group?.metadata?.adminJids || []),
      ...String(this.config.GROUP_ADMIN_HUMAN_ADMINS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ];
    if (configured.some((jid) => normalizeUserJid(jid) === user)) return true;

    if (transport && typeof transport.isGroupAdmin === 'function') {
      try {
        return Boolean(await transport.isGroupAdmin(groupJid, senderJid));
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Verifies every precondition for an administrative action.
   *
   * @param {{ groupJid: string, action: string, transport: object, approvalId?: string }} input
   * @returns {Promise<{ allowed: boolean, reason: string, verifiedBy?: string }>}
   */
  async canPerformAdminAction({ groupJid, action, transport, approvalId = '' } = {}) {
    if (!HIGH_IMPACT_ACTIONS.has(action)) return { allowed: false, reason: 'unsupported_action' };
    if (!this.config.GROUP_ADMIN_ENABLED) return { allowed: false, reason: 'subsystem_disabled' };
    if (!transport) return { allowed: false, reason: 'no_transport' };
    if (typeof transport.supportsAction === 'function' && !transport.supportsAction(action)) {
      return { allowed: false, reason: 'transport_capability_missing' };
    }

    if (action !== 'announcement') {
      if (typeof transport.isBotAdmin === 'function') {
        let botIsAdmin = false;
        try {
          botIsAdmin = Boolean(await transport.isBotAdmin(groupJid));
        } catch {
          return { allowed: false, reason: 'permission_check_failed' };
        }
        if (!botIsAdmin) return { allowed: false, reason: 'bot_not_group_admin' };
      }
    }

    if (this.config.GROUP_ADMIN_REQUIRE_APPROVAL || action === 'remove_participant') {
      if (!approvalId) return { allowed: false, reason: 'approval_required' };
      const approval = this.approvals.get(approvalId);
      if (!approval) return { allowed: false, reason: 'approval_not_found' };
      if (approval.groupJid !== normalizeGroupJid(groupJid))
        return { allowed: false, reason: 'approval_group_mismatch' };
      if (approval.status !== 'approved') return { allowed: false, reason: `approval_${approval.status}` };
      if (approval.payload?.action && approval.payload.action !== action) {
        return { allowed: false, reason: 'approval_action_mismatch' };
      }
      return { allowed: true, reason: 'approved', verifiedBy: approval.resolvedBy || 'approval' };
    }

    return { allowed: true, reason: 'human_operator' };
  }

  /**
   * Creates an approval request for a high-impact action.
   * @param {{ groupJid: string, action: string, payload: object, requestedBy: string, reason?: string }} input
   */
  async requestApproval({ groupJid, action, payload, requestedBy = 'ai', reason = '' }) {
    const approval = await this.approvals.create({
      groupJid,
      type: action,
      payload: { ...payload, action },
      requestedBy,
      reason,
    });
    await this.record({
      groupJid,
      actor: requestedBy,
      action: 'approval_requested',
      detail: { approvalId: approval.id, requestedAction: action },
    });
    return approval;
  }
}

export { HIGH_IMPACT_ACTIONS };
