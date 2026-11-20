/**
 * Personal WhatsApp transport (unofficial, opt-in) built on Baileys.
 *
 * Security and safety properties:
 *  - completely inactive unless PERSONAL_WHATSAPP_ENABLED=true,
 *  - ignores private chats and status broadcasts,
 *  - never enables a discovered group,
 *  - reconnects with bounded exponential backoff and stops after logout,
 *  - verifies administrative actions against fresh group metadata.
 *
 * This uses an unofficial WhatsApp Web multi-device session. It is not endorsed
 * by WhatsApp and carries an account-restriction risk; see docs/GROUP-ADMIN.md.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const GROUP_SUFFIX = '@g.us';
const USER_SUFFIX = '@s.whatsapp.net';
const METADATA_TTL_MS = 5 * 60 * 1000;

export class PersonalWhatsAppTransport {
  /**
   * @param {{
   *   config: object,
   *   logger?: object,
   *   socketFactory?: Function,
   *   authStateFactory?: Function,
   *   onMessage?: Function,
   *   onGroups?: Function,
   *   onParticipants?: Function,
   *   onPrivateMessage?: Function,
   *   onStatus?: Function,
   *   clock?: () => number
   * }} options
   */
  constructor({
    config,
    logger = console,
    socketFactory = null,
    authStateFactory = null,
    onMessage = null,
    onGroups = null,
    onParticipants = null,
    onPrivateMessage = null,
    onStatus = null,
    clock = () => Date.now(),
  }) {
    this.config = config;
    this.logger = logger;
    this.socketFactory = socketFactory;
    this.authStateFactory = authStateFactory;
    this.onMessage = onMessage;
    this.onGroups = onGroups;
    this.onParticipants = onParticipants;
    this.onPrivateMessage = onPrivateMessage;
    this.onStatus = onStatus;
    this.clock = clock;

    this.id = 'personal';
    this.sock = null;
    this.state = config.PERSONAL_WHATSAPP_ENABLED ? 'idle' : 'disabled';
    this.lastError = '';
    this.qr = '';
    this.qrUpdatedAt = 0;
    this.pairingCode = '';
    this.connectedAt = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.nextRetryAt = 0;
    this.started = false;
    this.stopping = false;
    this.botJids = [];
    this.groupCache = new Map();
    this.authDir =
      config.PERSONAL_WHATSAPP_AUTH_DIR ||
      path.join(config.DATA_DIR || path.resolve('.data'), 'personal-whatsapp-auth');
  }

  get enabled() {
    return Boolean(this.config.PERSONAL_WHATSAPP_ENABLED);
  }

  get capabilities() {
    return {
      text: true,
      groupDiscovery: true,
      groupMetadata: true,
      adminOps: true,
      participants: true,
      presence: true,
    };
  }

  supportsAction(action) {
    return Boolean(this.sock) && GROUP_ACTIONS.has(action);
  }

  /**
   * Starts the socket. Safe to call multiple times.
   */
  async start() {
    if (!this.enabled) {
      this.state = 'disabled';
      return this.getStatus();
    }
    if (this.started && this.state !== 'stopped' && this.state !== 'logged_out') return this.getStatus();
    this.started = true;
    this.stopping = false;
    try {
      await this.#createSocket();
    } catch (err) {
      this.#setState('error', err.message);
    }
    return this.getStatus();
  }

  async stop({ logout = false } = {}) {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      if (this.sock) {
        if (logout && typeof this.sock.logout === 'function') {
          await this.sock.logout();
        } else if (typeof this.sock.end === 'function') {
          this.sock.end(undefined);
        }
      }
    } catch {
      // best effort
    }
    this.sock = null;
    this.started = false;
    this.qr = '';
    this.pairingCode = '';
    this.connectedAt = null;
    this.botJids = [];
    this.#setState(logout ? 'logged_out' : 'stopped');
    return this.getStatus();
  }

  async #createSocket() {
    let baileys = null;
    if (!this.socketFactory || !this.authStateFactory) {
      baileys = await import('@whiskeysockets/baileys');
    }

    let authState;
    if (this.authStateFactory) {
      authState = await this.authStateFactory(baileys);
    } else {
      await fs.mkdir(this.authDir, { recursive: true });
      authState = await baileys.useMultiFileAuthState(this.authDir);
    }

    if (!authState || !authState.state) {
      throw new Error('WhatsApp auth state is unavailable');
    }

    let version;
    if (baileys?.fetchLatestBaileysVersion) {
      try {
        const latest = await baileys.fetchLatestBaileysVersion();
        version = latest?.version;
      } catch {
        version = undefined;
      }
    }

    const logger =
      baileys?.makeCacheableSignalKeyStore && typeof this.socketFactory !== 'function'
        ? await createSilentLogger()
        : undefined;

    const makeSocket =
      this.socketFactory ||
      ((cfg) => {
        const state = {
          creds: authState.state.creds,
          keys:
            baileys.makeCacheableSignalKeyStore && logger
              ? baileys.makeCacheableSignalKeyStore(authState.state.keys, logger)
              : authState.state.keys,
        };
        return baileys.makeWASocket({ ...cfg, auth: state });
      });

    const socket = makeSocket({
      version,
      logger,
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      browser: baileys?.Browsers?.ubuntu ? baileys.Browsers.ubuntu('Chrome') : undefined,
    });
    this.sock = socket;

    if (authState.saveCreds) {
      socket.ev?.on?.('creds.update', authState.saveCreds);
    }
    socket.ev?.on?.('connection.update', (update) => this.#onConnectionUpdate(update));
    socket.ev?.on?.('messages.upsert', (event) => this.#onMessagesUpsert(event));
    socket.ev?.on?.('groups.upsert', (groups) => this.#onGroupsUpsert(groups));
    socket.ev?.on?.('groups.update', (groups) => this.#onGroupsUpdate(groups));
    socket.ev?.on?.('group-participants.update', (event) => this.#onParticipantsUpdate(event));

    this.#setState('connecting');

    if (this.config.PERSONAL_WHATSAPP_PAIRING_NUMBER && typeof socket.requestPairingCode === 'function') {
      try {
        const code = await socket.requestPairingCode(this.config.PERSONAL_WHATSAPP_PAIRING_NUMBER);
        this.pairingCode = String(code || '');
        this.#emitStatus();
      } catch (err) {
        this.lastError = err.message;
        this.#emitStatus();
      }
    }
  }

  #setState(state, error = '') {
    this.state = state;
    if (error) this.lastError = String(error).slice(0, 300);
    if (state === 'connected') this.connectedAt = new Date(this.clock()).toISOString();
    this.#emitStatus();
  }

  #emitStatus() {
    if (typeof this.onStatus === 'function') {
      try {
        this.onStatus(this.getStatus());
      } catch {
        // never let a status listener break the socket
      }
    }
  }

  #onConnectionUpdate(update = {}) {
    if (update.qr) {
      this.qr = update.qr;
      this.qrUpdatedAt = this.clock();
      this.#setState('qr');
    }

    if (update.connection === 'open') {
      this.reconnectAttempts = 0;
      this.qr = '';
      this.pairingCode = '';
      this.#captureIdentity();
      this.#setState('connected');
      void this.#loadGroups();
      return;
    }

    if (update.connection === 'close') {
      const statusCode = update.lastDisconnect?.error?.output?.statusCode;
      const reason = update.lastDisconnect?.error?.message || 'connection closed';
      this.lastError = String(reason).slice(0, 300);
      this.connectedAt = null;
      this.botJids = [];

      if (statusCode === 401) {
        this.#setState('logged_out', 'WhatsApp session was logged out');
        return;
      }
      if (statusCode === 440) {
        this.#setState('replaced', 'Session replaced by another WhatsApp Web login');
        return;
      }
      if (this.stopping) {
        this.#setState('stopped');
        return;
      }
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect() {
    if (this.reconnectTimer || this.stopping) return;
    this.reconnectAttempts += 1;
    const base = 1000;
    const max = Math.max(5000, Number(this.config.PERSONAL_WHATSAPP_RECONNECT_MAX_MS) || 60000);
    const delay = Math.min(base * 2 ** Math.min(this.reconnectAttempts, 6), max);
    const jitter = Math.floor(Math.random() * 500);
    this.nextRetryAt = this.clock() + delay + jitter;
    this.#setState('reconnecting', this.lastError);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopping) return;
      this.#createSocket().catch((err) => {
        this.lastError = err.message;
        this.#scheduleReconnect();
      });
    }, delay + jitter);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  #captureIdentity() {
    const user = this.sock?.user;
    const ids = new Set();
    if (user?.id) {
      ids.add(String(user.id));
      const bare = String(user.id).split(':')[0];
      ids.add(`${bare}${USER_SUFFIX}`);
      ids.add(`${bare}${GROUP_SUFFIX}`);
    }
    if (user?.lid) ids.add(String(user.lid));
    this.botJids = [...ids].filter(Boolean);
  }

  async #loadGroups() {
    if (!this.sock || typeof this.sock.groupFetchAllParticipating !== 'function') return;
    try {
      const all = await this.sock.groupFetchAllParticipating();
      const groups = Object.values(all || {}).map((g) => this.#mapGroupMetadata(g));
      for (const group of groups) {
        this.groupCache.set(group.jid, { at: this.clock(), value: group });
      }
      if (typeof this.onGroups === 'function') {
        this.onGroups(groups);
      }
    } catch (err) {
      this.lastError = `Group discovery failed: ${err.message}`.slice(0, 300);
    }
  }

  #onGroupsUpsert(groups) {
    const list = (Array.isArray(groups) ? groups : [groups]).map((g) => this.#mapGroupMetadata(g)).filter(Boolean);
    for (const group of list) this.groupCache.set(group.jid, { at: this.clock(), value: group });
    if (list.length > 0 && typeof this.onGroups === 'function') this.onGroups(list);
  }

  #onGroupsUpdate(groups) {
    const list = [];
    for (const update of Array.isArray(groups) ? groups : [groups]) {
      if (!update?.id) continue;
      const cached = this.groupCache.get(update.id)?.value;
      const merged = {
        jid: update.id,
        name: update.subject || cached?.name || '',
        participantCount: cached?.participantCount || 0,
        adminJids: cached?.adminJids || [],
        owner: cached?.owner || '',
      };
      this.groupCache.set(update.id, { at: this.clock(), value: merged });
      list.push(merged);
    }
    if (list.length > 0 && typeof this.onGroups === 'function') this.onGroups(list);
  }

  #onParticipantsUpdate(event = {}) {
    if (!event.id || !this.onParticipants) return;
    const participants = Array.isArray(event.participants) ? event.participants : [];
    this.groupCache.delete(event.id);
    this.onParticipants({
      groupJid: event.id,
      action: event.action,
      participants: participants.map((p) => {
        const jid = typeof p === 'string' ? p : p.id || p.jid;
        return { jid, name: typeof p === 'object' ? p.name || '' : '' };
      }),
      timestampMs: this.clock(),
    });
  }

  #onMessagesUpsert(event = {}) {
    if (event.type && event.type !== 'notify') return; // ignore history sync / appends
    for (const message of event.messages || []) {
      const envelope = this.#mapMessage(message);
      if (!envelope) continue;
      if (envelope.isGroup) {
        if (typeof this.onMessage === 'function') {
          Promise.resolve(this.onMessage(envelope)).catch(() => {});
        }
      } else if (this.config.PERSONAL_WHATSAPP_PRIVATE_CHATS && typeof this.onPrivateMessage === 'function') {
        Promise.resolve(this.onPrivateMessage(envelope)).catch(() => {});
      }
      // Private chats are ignored unless separately configured by the operator.
    }
  }

  #mapMessage(message) {
    const key = message?.key;
    if (!key?.remoteJid) return null;
    if (key.fromMe) return null;
    if (key.remoteJid === 'status@broadcast' || key.remoteJid.endsWith('@broadcast')) return null;

    const isGroup = key.remoteJid.endsWith(GROUP_SUFFIX);
    const content = unwrapMessage(message.message);
    const text = extractText(content);
    if (!text) return null;

    const context = extractContextInfo(content);
    const senderJid = key.participant || key.remoteJid;
    const mentionCount = Array.isArray(context?.mentionedJid) ? context.mentionedJid.length : 0;
    const isReplyToBot =
      Boolean(context?.participant) &&
      this.botJids.some((jid) => normalizeUser(jid) === normalizeUser(context.participant));

    return {
      transport: 'personal',
      isGroup,
      groupJid: isGroup ? key.remoteJid : '',
      groupName: isGroup ? this.groupCache.get(key.remoteJid)?.value?.name || '' : '',
      messageId: String(key.id || crypto.randomUUID()),
      senderJid,
      senderName: String(message.pushName || '').slice(0, 80),
      text: String(text).slice(0, 8000),
      mentions: Array.isArray(context?.mentionedJid) ? context.mentionedJid.slice(0, 50) : [],
      mentionCount,
      quotedMessageId: context?.stanzaId || '',
      isReplyToBot,
      timestampMs: toMillis(message.messageTimestamp),
    };
  }

  #mapGroupMetadata(raw) {
    if (!raw?.id) return null;
    const participants = Array.isArray(raw.participants) ? raw.participants : [];
    const adminJids = participants
      .filter((p) => p.admin === 'admin' || p.admin === 'superadmin')
      .map((p) => p.id)
      .filter(Boolean);
    return {
      jid: raw.id,
      name: String(raw.subject || '').slice(0, 120),
      participantCount: participants.length,
      adminJids: adminJids.slice(0, 100),
      participants: participants
        .map((p) => ({ id: String(p.id || ''), admin: p.admin || null }))
        .filter((p) => p.id)
        .slice(0, 500),
      owner: raw.owner || '',
    };
  }

  /* ------------------------------- outbound ------------------------------- */

  async sendText(groupJid, text, _options = {}) {
    if (!this.sock) throw new Error('WhatsApp session is not connected');
    const jid = normalizeGroupJid(groupJid);
    if (!jid) throw new Error('Invalid group identifier');
    const body = String(text || '').trim();
    if (!body) throw new Error('Refusing to send an empty message');

    const sent = await this.sock.sendMessage(jid, { text: body });
    const id = sent?.key?.id || '';
    if (!id) throw new Error('WhatsApp did not return a message id');
    return {
      id,
      timestamp: toMillis(sent?.messageTimestamp) || this.clock(),
      verified: true,
    };
  }

  /**
   * Sends a direct message to a human administrator. Used only for security
   * escalations; group content is never forwarded.
   */
  async sendDirectText(userJid, text) {
    if (!this.sock) throw new Error('WhatsApp session is not connected');
    const target = normalizeParticipantJid(userJid);
    if (!target) throw new Error('Invalid recipient');
    const body = String(text || '').trim();
    if (!body) throw new Error('Refusing to send an empty message');
    const sent = await this.sock.sendMessage(target, { text: body.slice(0, 1000) });
    return { id: sent?.key?.id || '', verified: Boolean(sent?.key?.id) };
  }

  async getGroupMetadata(groupJid, { refresh = false } = {}) {
    const jid = normalizeGroupJid(groupJid);
    if (!jid) return null;
    const cached = this.groupCache.get(jid);
    if (!refresh && cached && this.clock() - cached.at < METADATA_TTL_MS) return structuredClone(cached.value);

    if (!this.sock || typeof this.sock.groupMetadata !== 'function') return cached?.value || null;
    try {
      const raw = await this.sock.groupMetadata(jid);
      const mapped = this.#mapGroupMetadata(raw);
      if (mapped) this.groupCache.set(jid, { at: this.clock(), value: mapped });
      return mapped ? structuredClone(mapped) : null;
    } catch (err) {
      this.lastError = `Group metadata failed: ${err.message}`.slice(0, 300);
      return cached?.value || null;
    }
  }

  async isGroupAdmin(groupJid, userJid) {
    const metadata = await this.getGroupMetadata(groupJid);
    if (!metadata) return false;
    const user = normalizeUser(userJid);
    return (metadata.adminJids || []).some((jid) => normalizeUser(jid) === user);
  }

  async isBotAdmin(groupJid) {
    if (!this.botJids.length) this.#captureIdentity();
    for (const botJid of this.botJids) {
      if (await this.isGroupAdmin(groupJid, botJid)) return true;
    }
    return false;
  }

  async executeAdminAction({ action, groupJid, participantJid = '', value = '', text = '' } = {}) {
    if (!this.sock) throw new Error('WhatsApp session is not connected');
    const jid = normalizeGroupJid(groupJid);
    if (!jid) throw new Error('Invalid group identifier');

    if (action === 'announcement') {
      const sent = await this.sendText(jid, text);
      return { verified: true, detail: { messageId: sent.id } };
    }

    if (action === 'remove_participant' || action === 'promote_participant' || action === 'demote_participant') {
      const target = normalizeParticipantJid(participantJid);
      if (!target) throw new Error('A participant identifier is required');
      const operation =
        action === 'remove_participant' ? 'remove' : action === 'promote_participant' ? 'promote' : 'demote';
      const result = await this.sock.groupParticipantsUpdate(jid, [target], operation);
      const metadata = await this.getGroupMetadata(jid, { refresh: true });
      const found = metadata?.participants?.find((p) => normalizeUser(p.id) === normalizeUser(target));

      let verified = false;
      if (operation === 'remove') verified = !found;
      else if (operation === 'promote') verified = Boolean(found && found.admin);
      else verified = Boolean(found && !found.admin);

      return {
        verified,
        detail: {
          operation,
          resultStatus: Array.isArray(result) ? result.map((r) => r?.status).join(',') : '',
          participantFound: Boolean(found),
        },
      };
    }

    if (action === 'set_subject') {
      await this.sock.groupUpdateSubject(jid, String(value || '').slice(0, 100));
      const metadata = await this.getGroupMetadata(jid, { refresh: true });
      return { verified: metadata?.name === String(value || '').slice(0, 100), detail: { subject: metadata?.name } };
    }

    if (action === 'set_description') {
      await this.sock.groupUpdateDescription(jid, String(value || '').slice(0, 2000));
      const metadata = await this.getGroupMetadata(jid, { refresh: true });
      return { verified: Boolean(metadata), detail: { subject: metadata?.name } };
    }

    if (action === 'set_setting') {
      await this.sock.groupSettingUpdate(jid, String(value || ''));
      const metadata = await this.getGroupMetadata(jid, { refresh: true });
      return { verified: Boolean(metadata), detail: { setting: value } };
    }

    throw new Error(`Unsupported administrative action: ${action}`);
  }

  getStatus() {
    return {
      transport: 'personal',
      enabled: this.enabled,
      state: this.state,
      connected: this.state === 'connected',
      lastError: this.lastError,
      qrAvailable: Boolean(this.qr),
      qrUpdatedAt: this.qrUpdatedAt ? new Date(this.qrUpdatedAt).toISOString() : null,
      pairingCode: this.pairingCode ? 'requested' : '',
      connectedAt: this.connectedAt,
      reconnectAttempts: this.reconnectAttempts,
      nextRetryAt: this.nextRetryAt ? new Date(this.nextRetryAt).toISOString() : null,
      botJids: this.botJids.map((jid) => jid.split('@')[0]),
      groupCount: this.groupCache.size,
      capabilities: this.capabilities,
      privateChatsEnabled: Boolean(this.config.PERSONAL_WHATSAPP_PRIVATE_CHATS),
      authDirConfigured: Boolean(this.config.PERSONAL_WHATSAPP_AUTH_DIR),
    };
  }

  getQr() {
    return this.qr;
  }

  getGroups() {
    return [...this.groupCache.values()].map((entry) => structuredClone(entry.value));
  }

  async refreshGroups() {
    await this.#loadGroups();
    return this.getGroups();
  }
}

const GROUP_ACTIONS = new Set([
  'announcement',
  'remove_participant',
  'promote_participant',
  'demote_participant',
  'set_subject',
  'set_description',
  'set_setting',
]);

function unwrapMessage(message) {
  if (!message) return null;
  return (
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.documentWithCaptionMessage?.message ||
    message.editedMessage?.message ||
    message
  );
}

function extractText(content) {
  if (!content) return '';
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    ''
  );
}

function extractContextInfo(content) {
  if (!content) return null;
  return (
    content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo ||
    content.documentMessage?.contextInfo ||
    null
  );
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  if (typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber() * 1000;
  return Number(value) || 0;
}

function normalizeUser(jid) {
  return String(jid || '')
    .split('@')[0]
    .split(':')[0]
    .replace(/\D/g, '');
}

function normalizeGroupJid(input) {
  const value = String(input || '').trim();
  if (!value.endsWith(GROUP_SUFFIX)) return null;
  return value;
}

function normalizeParticipantJid(input) {
  const value = String(input || '').trim();
  if (!value) return null;
  if (value.includes('@')) return value;
  const digits = value.replace(/\D/g, '');
  return digits ? `${digits}${USER_SUFFIX}` : null;
}

async function createSilentLogger() {
  try {
    const pinoModule = await import('pino');
    const pino = pinoModule.default || pinoModule;
    return pino({ level: 'silent' });
  } catch {
    return undefined;
  }
}
