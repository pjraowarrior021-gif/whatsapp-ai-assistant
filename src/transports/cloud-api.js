/**
 * Cloud API transport adapter.
 *
 * Meta's Groups API lets a business phone number create and manage its own
 * invite-only groups. The business number is always the group creator and the
 * only administrator; participants join through an invite link (there is no
 * API to add the number to somebody else's consumer group).
 *
 * Cloud group ids are opaque strings, so they are carried through the pipeline
 * as canonical `cloud_<hex>@g.us` identifiers (see group-admin/jid.js).
 *
 * Docs: https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/reference
 */
import { config as defaultConfig } from '../config.js';
import { splitMessageIntoChunks } from '../whatsapp.js';
import { cloudGroupIdToJid, jidToCloudGroupId, normalizeGroupJid } from '../group-admin/jid.js';

const GRAPH_BASE = 'https://graph.facebook.com';

export const CLOUD_GROUP_WEBHOOK_FIELDS = Object.freeze([
  'group_lifecycle_update',
  'group_participants_update',
  'group_settings_update',
  'group_status_update',
]);

export class CloudGroupTransport {
  /**
   * @param {{ config?: object, logger?: object, fetchImpl?: Function, clock?: () => number }} [options]
   */
  constructor({ config = defaultConfig, logger = console, fetchImpl = null, clock = () => Date.now() } = {}) {
    this.id = 'cloud';
    this.config = config;
    this.logger = logger;
    this.clock = clock;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.capabilities = Object.freeze({
      text: true,
      groupDiscovery: true,
      groupMetadata: true,
      adminOps: true,
      participants: true,
      presence: false,
      createGroup: true,
      inviteLinks: true,
      joinRequests: true,
      // Cloud API has no promote/demote: the business number is the sole admin.
      roles: false,
    });
  }

  get enabled() {
    return Boolean(this.config.WHATSAPP_TOKEN && this.config.WHATSAPP_PHONE_NUMBER_ID);
  }

  /**
   * Only actions the Cloud Groups API can actually perform are advertised.
   * @param {string} action
   * @returns {boolean}
   */
  supportsAction(action) {
    return new Set(['remove_participant', 'set_subject', 'set_description', 'announcement', 'broadcast']).has(
      String(action || '')
    );
  }

  /* -------------------------------- groups -------------------------------- */

  /**
   * Creates a business-owned group. Participants can only join via the
   * invite link returned by the lifecycle webhook / invite-link endpoint.
   * @param {{ subject: string, description?: string, joinApprovalMode?: string }} input
   */
  async createGroup({ subject, description = '', joinApprovalMode = '' } = {}) {
    const cleanSubject = String(subject || '')
      .trim()
      .slice(0, 128);
    if (!cleanSubject) throw new Error('Group subject is required');
    const body = { messaging_product: 'whatsapp', subject: cleanSubject };
    if (description) body.description = String(description).slice(0, 2048);
    if (joinApprovalMode === 'approval_required' || joinApprovalMode === 'auto_approve') {
      body.join_approval_mode = joinApprovalMode;
    }

    const data = await this.#request('POST', `/${this.#phoneNumberId()}/groups`, { body });
    const groupId = String(data?.id || data?.group_id || '');
    const groupJid = groupId ? cloudGroupIdToJid(groupId) : null;
    return {
      groupId,
      groupJid,
      inviteLink: typeof data?.invite_link === 'string' ? data.invite_link : '',
      raw: data,
      // Group creation is confirmed asynchronously by group_lifecycle_update.
      pendingConfirmation: !groupId,
    };
  }

  /**
   * Lists active groups owned by this business number.
   * @returns {Promise<Array<{ jid: string, name: string, groupId: string, createdAt: string }>>}
   */
  async listGroups() {
    const groups = [];
    let path = `/${this.#phoneNumberId()}/groups?limit=100`;
    for (let page = 0; page < 10 && path; page += 1) {
      const data = await this.#request('GET', path);
      const pageGroups = Array.isArray(data?.data?.groups)
        ? data.data.groups
        : Array.isArray(data?.data)
          ? data.data
          : [];
      for (const group of pageGroups) {
        const jid = cloudGroupIdToJid(group?.id);
        if (!jid) continue;
        groups.push({
          jid,
          groupId: String(group.id),
          name: String(group.subject || '').slice(0, 120),
          createdAt: group.created_at ? String(group.created_at) : '',
        });
      }
      const next = data?.paging?.next;
      path =
        typeof next === 'string' && next.startsWith('https://graph.facebook.com/') ? next.slice(GRAPH_BASE.length) : '';
    }
    return groups;
  }

  /** Alias used by the orchestrator's discovery flow. */
  async refreshGroups() {
    return this.listGroups();
  }

  /**
   * @param {string} groupJid
   */
  async getGroupMetadata(groupJid) {
    const groupId = this.#groupId(groupJid);
    const fields =
      'subject,description,participants,join_approval_mode,suspended,creation_timestamp,total_participant_count';
    const data = await this.#request('GET', `/${encodeURIComponent(groupId)}?fields=${fields}`);
    const jid = cloudGroupIdToJid(data?.id || groupId);
    const participants = Array.isArray(data?.participants)
      ? data.participants.map((p) => ({
          jid: String(p?.wa_id || p?.user_id || p?.username || ''),
          name: String(p?.username || ''),
        }))
      : [];
    return {
      jid,
      id: String(data?.id || groupId),
      name: String(data?.subject || ''),
      description: String(data?.description || ''),
      participants,
      participantCount: Number(data?.total_participant_count) || participants.length,
      // The business number is the creator and sole admin of Cloud groups.
      adminJids: [],
      botIsAdmin: data?.suspended !== true,
      suspended: data?.suspended === true,
      joinApprovalMode: String(data?.join_approval_mode || ''),
      createdAt: data?.creation_timestamp ? String(data.creation_timestamp) : '',
    };
  }

  /**
   * @param {string} groupJid
   * @returns {Promise<{ verified: boolean, inviteLink: string }>}
   */
  async getInviteLink(groupJid) {
    const data = await this.#request('GET', `/${this.#groupId(groupJid)}/invite_link`);
    const inviteLink = String(data?.invite_link || '');
    return { verified: inviteLink.startsWith('https://chat.whatsapp.com/'), inviteLink };
  }

  /**
   * Invalidates all previous invite links for the group.
   * @param {string} groupJid
   */
  async resetInviteLink(groupJid) {
    const data = await this.#request('POST', `/${this.#groupId(groupJid)}/invite_link`, {
      body: { messaging_product: 'whatsapp' },
    });
    const inviteLink = String(data?.invite_link || '');
    return { verified: inviteLink.startsWith('https://chat.whatsapp.com/'), inviteLink };
  }

  /* ----------------------------- join requests ---------------------------- */

  /**
   * @param {string} groupJid
   */
  async listJoinRequests(groupJid) {
    const data = await this.#request('GET', `/${this.#groupId(groupJid)}/join_requests`);
    return Array.isArray(data?.data)
      ? data.data.map((request) => ({
          joinRequestId: String(request?.join_request_id || ''),
          waId: String(request?.wa_id || ''),
          userId: String(request?.user_id || ''),
          username: String(request?.username || ''),
          createdAt: request?.creation_timestamp ? String(request.creation_timestamp) : '',
        }))
      : [];
  }

  /**
   * @param {string} groupJid
   * @param {string[]} joinRequestIds
   */
  async approveJoinRequests(groupJid, joinRequestIds = []) {
    const ids = (Array.isArray(joinRequestIds) ? joinRequestIds : []).map(String).filter(Boolean).slice(0, 8);
    if (!ids.length) throw new Error('At least one join request id is required');
    const data = await this.#request('POST', `/${this.#groupId(groupJid)}/join_requests`, {
      body: { messaging_product: 'whatsapp', join_requests: ids },
    });
    return {
      approved: (data?.approved_join_requests || []).map(String),
      failed: Array.isArray(data?.failed_join_requests) ? data.failed_join_requests : [],
    };
  }

  /**
   * @param {string} groupJid
   * @param {string[]} joinRequestIds
   */
  async rejectJoinRequests(groupJid, joinRequestIds = []) {
    const ids = (Array.isArray(joinRequestIds) ? joinRequestIds : []).map(String).filter(Boolean).slice(0, 8);
    if (!ids.length) throw new Error('At least one join request id is required');
    const data = await this.#request('DELETE', `/${this.#groupId(groupJid)}/join_requests`, {
      body: { messaging_product: 'whatsapp', join_requests: ids },
    });
    return {
      rejected: (data?.rejected_join_requests || []).map(String),
      failed: Array.isArray(data?.failed_join_requests) ? data.failed_join_requests : [],
    };
  }

  /* ------------------------------- messaging ------------------------------ */

  /**
   * Sends text to a Cloud group. Returns the last accepted message id; the
   * caller treats a message id as delivery *acceptance*, not proof of a
   * human having read it.
   * @param {string} groupJid
   * @param {string} text
   */
  async sendText(groupJid, text) {
    const groupId = this.#groupId(groupJid);
    const body = String(text || '').trim();
    if (!body) throw new Error('Message text is required');

    const chunks = splitMessageIntoChunks(body);
    let lastId = '';
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n\n${chunks[i]}` : chunks[i];
      const data = await this.#request('POST', `/${this.#phoneNumberId()}/messages`, {
        body: {
          messaging_product: 'whatsapp',
          recipient_type: 'group',
          to: groupId,
          type: 'text',
          text: { preview_url: false, body: chunk },
        },
      });
      lastId = String(data?.messages?.[0]?.id || '');
      if (!lastId) throw new Error('Cloud API did not accept the group message');
    }
    return { id: lastId, messageId: lastId, timestamp: this.clock(), verified: Boolean(lastId) };
  }

  /* ----------------------------- administration --------------------------- */

  async isBotAdmin(groupJid) {
    if (!this.enabled) return false;
    try {
      const metadata = await this.getGroupMetadata(groupJid);
      return metadata.suspended !== true;
    } catch {
      return false;
    }
  }

  /**
   * Cloud group participants cannot be admins; only the business number can.
   * Configured human admins are still honoured by SecurityAgent.
   */
  async isGroupAdmin() {
    return false;
  }

  /**
   * Executes an approved action and verifies it against fresh group metadata.
   * @param {{ action: string, groupJid: string, participantJid?: string, value?: string }} input
   */
  async executeAdminAction({ action, groupJid, participantJid = '', value = '' } = {}) {
    const groupId = this.#groupId(groupJid);

    if (action === 'announcement' || action === 'broadcast') {
      const result = await this.sendText(groupJid, value);
      return { verified: Boolean(result.id), detail: { messageId: result.id } };
    }

    if (action === 'remove_participant') {
      const participant = String(participantJid || '').trim();
      if (!participant) throw new Error('Participant is required');
      await this.#request('DELETE', `/${groupId}/participants`, {
        body: {
          messaging_product: 'whatsapp',
          participants: [participant.includes('.') ? { user_id: participant } : { user: participant }],
        },
      });
      const metadata = await this.getGroupMetadata(groupJid);
      const stillPresent = metadata.participants.some((p) => sameParticipant(p.jid, participant));
      return {
        verified: !stillPresent,
        detail: { participant, stillPresent, participantCount: metadata.participantCount },
      };
    }

    if (action === 'set_subject' || action === 'set_description') {
      const text = String(value || '').trim();
      if (!text) throw new Error('New value is required');
      const field = action === 'set_subject' ? 'subject' : 'description';
      await this.#request('POST', `/${groupId}`, {
        body: { messaging_product: 'whatsapp', [field]: text.slice(0, field === 'subject' ? 128 : 2048) },
      });
      const metadata = await this.getGroupMetadata(groupJid);
      const actual = field === 'subject' ? metadata.name : metadata.description;
      return { verified: actual === text, detail: { field, requested: text, actual } };
    }

    throw new Error(`Unsupported Cloud API group action: ${action}`);
  }

  getStatus() {
    return {
      transport: 'cloud',
      connected: this.enabled,
      state: this.enabled ? 'configured' : 'unconfigured',
      phoneNumberId: this.config.WHATSAPP_PHONE_NUMBER_ID ? String(this.config.WHATSAPP_PHONE_NUMBER_ID) : '',
      apiVersion: this.#apiVersion(),
      capabilities: this.capabilities,
      limitations: {
        inviteOnly: true,
        maxParticipants: 8,
        businessOwnedOnly: true,
        roles: false,
      },
    };
  }

  /* -------------------------------- helpers ------------------------------- */

  #apiVersion() {
    return this.config.CLOUD_GROUPS_API_VERSION || this.config.WHATSAPP_API_VERSION || 'v21.0';
  }

  #phoneNumberId() {
    const id = String(this.config.WHATSAPP_PHONE_NUMBER_ID || '').trim();
    if (!this.config.WHATSAPP_TOKEN || !id) {
      throw new Error('Cloud API credentials are not configured (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)');
    }
    return encodeURIComponent(id);
  }

  #groupId(groupJid) {
    const id = jidToCloudGroupId(groupJid);
    if (!id) throw new Error('Invalid Cloud group identifier');
    return encodeURIComponent(id);
  }

  async #request(method, path, { body } = {}) {
    if (!this.config.WHATSAPP_TOKEN) {
      throw new Error('Cloud API credentials are not configured (WHATSAPP_TOKEN)');
    }
    const url = path.startsWith('http') ? path : `${GRAPH_BASE}/${this.#apiVersion()}${path}`;
    const init = {
      method,
      headers: {
        Authorization: `Bearer ${this.config.WHATSAPP_TOKEN}`,
        Accept: 'application/json',
      },
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      throw new Error(`Cloud API request failed: ${err.message}`);
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok || data?.error) {
      const graphError = data?.error;
      const message = graphError
        ? `${graphError.title || 'Cloud API error'}: ${graphError.message || ''}`.trim()
        : `Cloud API request failed with status ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.code = graphError?.code;
      throw error;
    }
    return data || {};
  }
}

/**
 * Maps a Graph API group webhook change into a transport-neutral event.
 * @param {{ field?: string, value?: object }} change
 * @returns {{ field: string, groups: Array<object> }|null}
 */
export function cloudGroupEventFromChange(change = {}) {
  const field = String(change?.field || '');
  if (!CLOUD_GROUP_WEBHOOK_FIELDS.includes(field)) return null;
  const groups = Array.isArray(change?.value?.groups) ? change.value.groups : [];
  if (!groups.length) return null;
  return { field, groups };
}

/**
 * Builds a transport-neutral envelope from a Cloud API message object.
 *
 * Group messages carry `group_id`; `from`/`from_user_id` identify the
 * participant, not the group. `contacts` is optional and only used for display.
 * @param {object} message
 * @param {Array<object>} [contacts]
 * @returns {object|null}
 */
export function envelopeFromCloudMessage(message, contacts = []) {
  if (!message || typeof message !== 'object') return null;

  const groupId = String(message.group_id || '');
  let groupJid = '';
  let senderJid = '';
  if (groupId) {
    groupJid = cloudGroupIdToJid(groupId) || '';
    senderJid = String(message.from_user_id || message.from || '');
  } else {
    const from = String(message.from || '');
    if (!from.includes('@g.us')) return null;
    groupJid = normalizeGroupJid(from) || '';
    senderJid = String(message.author || from || '');
  }
  if (!groupJid) return null;

  const text =
    message.text?.body ||
    message.image?.caption ||
    message.video?.caption ||
    message.document?.caption ||
    message.button?.text ||
    message.interactive?.button_reply?.title ||
    message.interactive?.list_reply?.title ||
    '';
  if (!text) return null;

  const contact = Array.isArray(contacts)
    ? contacts.find((c) => c?.wa_id && (c.wa_id === message.from || c.user_id === message.from_user_id))
    : null;

  return {
    transport: 'cloud',
    isGroup: true,
    groupJid,
    groupName: '',
    cloudGroupId: groupId,
    messageId: String(message.id || ''),
    senderJid,
    senderName: String(contact?.profile?.name || contact?.username || '').slice(0, 120),
    text: String(text).slice(0, 8000),
    mentions: [],
    timestampMs: Number(message.timestamp) ? Number(message.timestamp) * 1000 : Date.now(),
    isReplyToBot: false,
  };
}

function sameParticipant(a, b) {
  const left = String(a || '')
    .trim()
    .toLowerCase()
    .replace(/^\+/, '');
  const right = String(b || '')
    .trim()
    .toLowerCase()
    .replace(/^\+/, '');
  if (!left || !right) return false;
  if (left === right) return true;
  return left.split('@')[0].replace(/\D/g, '') === right.split('@')[0].replace(/\D/g, '');
}
