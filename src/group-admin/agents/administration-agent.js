/**
 * Group Administration Agent.
 *
 * Any structural or destructive action is proposed, approved by a human, then
 * executed through the transport. Execution is only reported as successful if
 * the transport verifies the resulting group state.
 */
export class AdministrationAgent {
  /**
   * @param {{ gateway: object, approvals: object, audit: object, memoryAgent: object, security: object, config: object }} options
   */
  constructor({ gateway, approvals, audit, memoryAgent, security, config }) {
    this.gateway = gateway;
    this.approvals = approvals;
    this.audit = audit;
    this.memoryAgent = memoryAgent;
    this.security = security;
    this.config = config;
  }

  /**
   * Sends a welcome message when the group opted in. Returns the transport
   * result so the caller can log whether delivery was verified.
   */
  async welcomeMember({ groupJid, groupName, memberJid, memberName, settings, transport }) {
    if (!settings.welcomeNewMembers) return { sent: false, reason: 'disabled' };
    if (!transport || typeof transport.sendText !== 'function') return { sent: false, reason: 'no_transport' };

    const template =
      settings.welcomeMessage || 'Welcome to {{group}}, {{name}}! Please read the group rules and introduce yourself.';
    const text = template
      .replace(/\{\{\s*group\s*\}\}/gi, groupName || 'the group')
      .replace(/\{\{\s*name\s*\}\}/gi, memberName || 'there')
      .slice(0, 1000);

    try {
      const result = await transport.sendText(groupJid, text, { kind: 'welcome' });
      const verified = Boolean(result && (result.id || result.messageId));
      await this.audit.record({
        groupJid,
        actor: 'administration-agent',
        action: 'welcome_member',
        outcome: verified ? 'success' : 'unverified',
        detail: { memberJid, verified },
      });
      return { sent: true, verified, text };
    } catch (err) {
      await this.audit.record({
        groupJid,
        actor: 'administration-agent',
        action: 'welcome_member',
        outcome: 'failed',
        detail: { memberJid, error: err.message },
      });
      return { sent: false, reason: 'transport_error', error: err.message };
    }
  }

  /**
   * Drafts an announcement in the group's voice. Never sends anything.
   */
  async draftAnnouncement({ groupJid, topic, settings }) {
    const memory = this.memoryAgent.getContext(groupJid);
    const system = [
      'You write short WhatsApp group announcements.',
      'Return only the announcement text, 2-6 sentences, no headings, no markdown tables.',
      'Do not invent dates, links or policies. If the topic lacks details, phrase it generally.',
      memory ? `Group context:\n${memory}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const result = await this.gateway.complete({
      task: 'report',
      groupJid,
      system,
      messages: [{ role: 'user', content: `Write an announcement about: ${String(topic || '').slice(0, 500)}` }],
      model: settings.models?.report || '',
      taskModels: settings.models || {},
      maxTokens: 500,
      temperature: 0.4,
    });
    return {
      text: String(result.text || '')
        .trim()
        .slice(0, 1400),
      provider: result.provider,
      model: result.model,
    };
  }

  /**
   * AI-initiated announcement. Requires approval unless the group explicitly
   * turned that requirement off.
   */
  async requestAnnouncement({ groupJid, topic, settings, requestedBy = 'ai' }) {
    const draft = await this.draftAnnouncement({ groupJid, topic, settings });
    if (!draft.text) return { status: 'empty' };

    if (settings.requireAnnouncementApproval !== false) {
      const approval = await this.approvals.create({
        groupJid,
        type: 'announcement',
        payload: { action: 'announcement', text: draft.text, topic },
        requestedBy,
        reason: 'Group announcement requires approval',
      });
      return { status: 'pending_approval', approvalId: approval.id, draft: draft.text };
    }

    return { status: 'approved', draft: draft.text };
  }

  /**
   * Executes a previously approved administrative action and verifies it.
   * @param {{ approval: object, transport: object, actor?: string }} input
   */
  async executeApprovedOperation({ approval, transport, actor = 'dashboard' }) {
    if (!approval) throw new Error('Approval is required');
    if (approval.status !== 'approved') throw new Error(`Approval is ${approval.status}`);

    const action = approval.payload?.action || approval.type;
    const permission = await this.security.canPerformAdminAction({
      groupJid: approval.groupJid,
      action,
      transport,
      approvalId: approval.id,
    });
    if (!permission.allowed) {
      await this.audit.record({
        groupJid: approval.groupJid,
        actor,
        action: 'admin_action_blocked',
        outcome: 'denied',
        detail: { approvalId: approval.id, requestedAction: action, reason: permission.reason },
      });
      return { ok: false, verified: false, reason: permission.reason };
    }

    try {
      const result = await transport.executeAdminAction({
        action,
        groupJid: approval.groupJid,
        targetJid: approval.payload?.targetJid || '',
        participantJid: approval.payload?.participantJid || approval.payload?.targetJid || '',
        text: approval.payload?.text || '',
        topic: approval.payload?.topic || '',
        value: approval.payload?.value || '',
      });

      const verified = Boolean(result?.verified);
      await this.audit.record({
        groupJid: approval.groupJid,
        actor,
        action: `admin_${action}`,
        outcome: verified ? 'success' : 'unverified',
        detail: {
          approvalId: approval.id,
          targetJid: approval.payload?.targetJid || null,
          verified,
          detail: result?.detail || null,
        },
      });
      return { ...result, ok: verified, verified, approvalId: approval.id };
    } catch (err) {
      await this.audit.record({
        groupJid: approval.groupJid,
        actor,
        action: `admin_${action}`,
        outcome: 'failed',
        detail: { approvalId: approval.id, error: err.message },
      });
      return { ok: false, verified: false, error: err.message };
    }
  }

  /**
   * AI-initiated high-impact request. Always queued for human approval.
   */
  async requestOperation({ groupJid, action, targetJid = '', value = '', reason = '', requestedBy = 'ai' }) {
    const allowedActions = new Set([
      'remove_participant',
      'promote_participant',
      'demote_participant',
      'set_subject',
      'set_description',
      'set_setting',
    ]);
    if (!allowedActions.has(action)) throw new Error('Unsupported administrative action');

    const approval = await this.approvals.create({
      groupJid,
      type: action,
      payload: { action, targetJid, participantJid: targetJid, value },
      requestedBy,
      reason: reason || 'High-impact group action requires human approval',
    });
    await this.audit.record({
      groupJid,
      actor: requestedBy,
      action: 'admin_action_proposed',
      detail: { approvalId: approval.id, requestedAction: action, targetJid },
    });
    return { status: 'pending_approval', approvalId: approval.id };
  }
}
