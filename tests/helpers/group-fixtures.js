/**
 * Shared fixtures for group-administrator tests. No network access.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GroupOrchestrator } from '../../src/group-admin/orchestrator.js';

export const GROUP_A = '120363000000000001@g.us';
export const GROUP_B = '120363000000000002@g.us';
export const ADMIN_JID = '919999999999@s.whatsapp.net';
export const MEMBER_JID = '918888888888@s.whatsapp.net';

export function makeConfig(overrides = {}) {
  return {
    NODE_ENV: 'test',
    DATA_DIR: '',
    GROUP_ADMIN_ENABLED: true,
    GROUP_ADMIN_DATA_DIR: '',
    GROUP_ADMIN_IMPORT_LEGACY: false,
    GROUP_ADMIN_CONTEXT_MESSAGES: 24,
    GROUP_ADMIN_HISTORY_TTL_MINUTES: 360,
    GROUP_ADMIN_MAX_REPLIES_PER_HOUR: 30,
    GROUP_ADMIN_REPLY_COOLDOWN_MS: 0,
    GROUP_ADMIN_AUDIT_MAX_ENTRIES: 500,
    GROUP_ADMIN_MAX_FACTS: 200,
    GROUP_ADMIN_BOT_ALIASES: 'ai,assistant,bot',
    GROUP_ADMIN_HUMAN_ADMINS: ADMIN_JID,
    GROUP_ADMIN_REQUIRE_APPROVAL: true,
    GROUP_ADMIN_DEFAULT_PERSONA: 'professional',
    ALLOWED_GROUP_IDS: new Set(),
    AI_PROVIDER_ORDER: 'gemini',
    AI_FREE_ONLY: false,
    AI_RATE_LIMIT_PER_MINUTE: 60,
    AI_REQUEST_TIMEOUT_MS: 5000,
    AI_MAX_FALLBACKS: 2,
    AI_USAGE_RETENTION_DAYS: 90,
    AI_MODEL_CHAT: '',
    AI_MODEL_MODERATION: '',
    AI_MODEL_SUMMARY: '',
    AI_MODEL_REPORT: '',
    AI_MODEL_MEMORY: '',
    GEMINI_API_KEY: 'test-gemini-key-not-real',
    GEMINI_MODEL: 'gemini-test',
    GEMINI_API_BASE_URL: 'https://gemini.test/v1beta',
    OPENROUTER_API_KEY: '',
    OPENROUTER_BASE_URL: 'https://openrouter.test/api/v1',
    OPENROUTER_APP_NAME: 'test',
    QWEN_API_KEY: '',
    QWEN_BASE_URL: 'https://qwen.test/v1',
    OPENAI_COMPAT_API_KEY: '',
    OPENAI_COMPAT_BASE_URL: 'https://openai.test/v1',
    PERSONAL_WHATSAPP_ENABLED: false,
    PERSONAL_WHATSAPP_AUTH_DIR: '',
    PERSONAL_WHATSAPP_PAIRING_NUMBER: '',
    PERSONAL_WHATSAPP_PRIVATE_CHATS: false,
    PERSONAL_WHATSAPP_RECONNECT_MAX_MS: 60000,
    ...overrides,
  };
}

export async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wa-group-admin-'));
}

export async function cleanupDir(dir) {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

export function makeFakeTransport({ connected = true } = {}) {
  const sent = [];
  const direct = [];
  const adminActions = [];
  return {
    id: 'personal',
    sent,
    direct,
    adminActions,
    capabilities: { text: true, adminOps: true, groupDiscovery: true },
    supportsAction: () => true,
    async sendText(jid, text) {
      sent.push({ jid, text });
      return { id: `msg_${sent.length}`, verified: true, timestamp: Date.now() };
    },
    async sendDirectText(jid, text) {
      direct.push({ jid, text });
      return { id: 'dm_1', verified: true };
    },
    async getGroupMetadata() {
      return { jid: GROUP_A, name: 'Test Group', participants: [], adminJids: [ADMIN_JID] };
    },
    async isGroupAdmin(_jid, jid) {
      return String(jid).includes('9999999999');
    },
    async isBotAdmin() {
      return true;
    },
    async executeAdminAction(payload) {
      adminActions.push(payload);
      return { verified: true, detail: { ok: true } };
    },
    async refreshGroups() {
      return [];
    },
    getStatus() {
      return { transport: 'personal', state: connected ? 'connected' : 'disabled', connected };
    },
  };
}

export function makeFakeGateway({ reply = 'Here is the answer.', fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async complete(input) {
      calls.push(input);
      if (fail) throw new Error('gateway unavailable');
      return {
        text: reply,
        provider: 'fake',
        model: 'fake-model',
        usage: { promptTokens: 10, completionTokens: 5 },
        costMicroUsd: 0,
      };
    },
    describe() {
      return { providerOrder: ['fake'], freeOnly: false, providers: [] };
    },
    async listAllModels() {
      return { providers: [] };
    },
  };
}

export async function makeOrchestrator({ config = {}, gateway = null, transport = null, dir: reuseDir = null } = {}) {
  const dir = reuseDir || (await makeTempDir());
  const cfg = makeConfig({ GROUP_ADMIN_DATA_DIR: dir, DATA_DIR: dir, ...config });
  const orchestrator = new GroupOrchestrator({
    config: cfg,
    dataDir: dir,
    startTransports: false,
    startScheduler: false,
    personalTransport: transport || makeFakeTransport(),
    clock: () => Date.now(),
  });
  await orchestrator.init();

  if (gateway) {
    orchestrator.gateway = gateway;
    orchestrator.conversationAgent.gateway = gateway;
    orchestrator.memoryAgent.gateway = gateway;
    orchestrator.administrationAgent.gateway = gateway;
    orchestrator.analyticsAgent.gateway = gateway;
  }

  return {
    orchestrator,
    config: cfg,
    dir,
    transport: transport || orchestrator.personal,
    async cleanup() {
      await orchestrator.shutdown();
      await cleanupDir(dir);
    },
  };
}

export function makeEnvelope({
  jid = GROUP_A,
  text = '@ai hello',
  senderJid = MEMBER_JID,
  messageId = `msg_${Math.random().toString(36).slice(2)}`,
  timestampMs = Date.now(),
  mentions = [],
  ...overrides
} = {}) {
  return {
    transport: 'personal',
    isGroup: true,
    groupJid: jid,
    groupName: 'Test Group',
    messageId,
    senderJid,
    senderName: 'Member',
    text,
    mentions,
    mentionCount: mentions.length,
    timestampMs,
    isReplyToBot: false,
    ...overrides,
  };
}
