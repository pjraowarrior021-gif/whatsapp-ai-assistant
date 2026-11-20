/**
 * Personal WhatsApp transport (Baileys) tests.
 *
 * A fake socket and fake auth state are injected, so these tests never open a
 * real WhatsApp connection and never touch the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonalWhatsAppTransport } from '../src/transports/personal-whatsapp.js';
import { makeConfig, GROUP_A, ADMIN_JID, MEMBER_JID } from './helpers/group-fixtures.js';

const CLOCK = 1_700_000_000_000;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function createFakeSocket({ metadata = null, groupFetch = null } = {}) {
  const handlers = new Map();
  const sent = [];
  const calls = [];
  const socket = {
    ev: {
      on(name, cb) {
        if (!handlers.has(name)) handlers.set(name, []);
        handlers.get(name).push(cb);
      },
    },
    user: { id: '911111111111:1@s.whatsapp.net' },
    async sendMessage(jid, payload) {
      sent.push({ jid, payload });
      return { key: { id: `msg_${sent.length}` }, messageTimestamp: 1_700_000_000 };
    },
    groupFetchAllParticipating: async () => (groupFetch ? groupFetch() : {}),
    groupMetadata: async (jid) => (metadata ? metadata(jid) : { id: jid, subject: 'Group', participants: [] }),
    async groupParticipantsUpdate(jid, participants, op) {
      calls.push({ kind: 'participants', jid, participants, op });
      return [{ status: '200' }];
    },
    async groupUpdateSubject(jid, value) {
      calls.push({ kind: 'subject', jid, value });
    },
    async groupUpdateDescription(jid, value) {
      calls.push({ kind: 'description', jid, value });
    },
    async groupSettingUpdate(jid, value) {
      calls.push({ kind: 'setting', jid, value });
    },
    async logout() {
      calls.push({ kind: 'logout' });
    },
    end() {
      calls.push({ kind: 'end' });
    },
  };
  return { socket, handlers, sent, calls };
}

function makeTransport({
  enabled = true,
  privateChats = false,
  metadata = null,
  groupFetch = null,
  onMessage = null,
  onPrivateMessage = null,
  onGroups = null,
  onParticipants = null,
} = {}) {
  const fake = createFakeSocket({ metadata, groupFetch });
  const transport = new PersonalWhatsAppTransport({
    config: makeConfig({
      PERSONAL_WHATSAPP_ENABLED: enabled,
      PERSONAL_WHATSAPP_PRIVATE_CHATS: privateChats,
      PERSONAL_WHATSAPP_AUTH_DIR: 'C:/fake-auth-dir',
    }),
    socketFactory: () => fake.socket,
    authStateFactory: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
    onMessage,
    onPrivateMessage,
    onGroups,
    onParticipants,
    clock: () => CLOCK,
  });
  return { transport, fake };
}

function emit(fake, name, payload) {
  for (const handler of fake.handlers.get(name) || []) handler(payload);
}

test('the transport is fully disabled unless explicitly enabled', async () => {
  let factoryCalls = 0;
  const transport = new PersonalWhatsAppTransport({
    config: makeConfig({ PERSONAL_WHATSAPP_ENABLED: false }),
    socketFactory: () => {
      factoryCalls += 1;
      throw new Error('must not be called');
    },
    authStateFactory: async () => ({ state: {} }),
  });

  const status = await transport.start();
  assert.equal(status.state, 'disabled');
  assert.equal(status.enabled, false);
  assert.equal(factoryCalls, 0);
});

test('connect, capture identity and discover groups', async () => {
  const seen = [];
  const { transport, fake } = makeTransport({
    onGroups: (groups) => seen.push(...groups),
    groupFetch: () => ({
      [GROUP_A]: {
        id: GROUP_A,
        subject: 'Discovered Group',
        participants: [{ id: ADMIN_JID, admin: 'admin' }],
      },
    }),
  });

  await transport.start();
  assert.equal(transport.state, 'connecting');

  emit(fake, 'connection.update', { connection: 'open' });
  await flush();

  assert.equal(transport.state, 'connected');
  assert.equal(transport.getStatus().connected, true);
  assert.equal(transport.botJids.length > 0, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].jid, GROUP_A);
  assert.equal(seen[0].name, 'Discovered Group');
  assert.deepEqual(seen[0].adminJids, [ADMIN_JID]);
});

test('a dropped connection reconnects with backoff; logout stops', async () => {
  const { transport, fake } = makeTransport();
  await transport.start();
  emit(fake, 'connection.update', { connection: 'open' });
  await flush();

  emit(fake, 'connection.update', {
    connection: 'close',
    lastDisconnect: { error: { message: 'socket went away', output: { statusCode: 503 } } },
  });

  assert.equal(transport.state, 'reconnecting');
  assert.equal(transport.reconnectAttempts, 1);
  assert.equal(transport.getStatus().nextRetryAt !== null, true);

  await transport.stop();
  assert.equal(transport.state, 'stopped');
  assert.equal(transport.sock, null);
});

test('a 401 logs out and never retries', async () => {
  const { transport, fake } = makeTransport();
  await transport.start();
  emit(fake, 'connection.update', { connection: 'open' });
  await flush();

  emit(fake, 'connection.update', {
    connection: 'close',
    lastDisconnect: { error: { message: 'logged out', output: { statusCode: 401 } } },
  });

  assert.equal(transport.state, 'logged_out');
  assert.equal(transport.reconnectAttempts, 0);
  await transport.stop();
});

test('a 440 marks the session as replaced', async () => {
  const { transport, fake } = makeTransport();
  await transport.start();
  emit(fake, 'connection.update', { connection: 'open' });
  await flush();

  emit(fake, 'connection.update', {
    connection: 'close',
    lastDisconnect: { error: { message: 'conflict', output: { statusCode: 440 } } },
  });

  assert.equal(transport.state, 'replaced');
  await transport.stop();
});

test('a QR update is surfaced for pairing', async () => {
  const { transport, fake } = makeTransport();
  await transport.start();
  emit(fake, 'connection.update', { qr: 'qr-payload-value' });

  assert.equal(transport.getQr(), 'qr-payload-value');
  assert.equal(transport.getStatus().state, 'qr');
  assert.equal(transport.getStatus().qrAvailable, true);
});

test('private chats are ignored by default', async () => {
  let groupMessages = 0;
  let privateMessages = 0;
  const { transport, fake } = makeTransport({
    onMessage: () => {
      groupMessages += 1;
    },
    onPrivateMessage: () => {
      privateMessages += 1;
    },
  });
  await transport.start();
  emit(fake, 'connection.update', { connection: 'open' });
  await flush();

  emit(fake, 'messages.upsert', {
    type: 'notify',
    messages: [
      { key: { remoteJid: '919222222222@s.whatsapp.net', id: 'p1', fromMe: false }, message: { conversation: 'hi' } },
    ],
  });
  await flush();

  assert.equal(privateMessages, 0);
  assert.equal(groupMessages, 0);
});

test('private chats are delivered only when explicitly configured', async () => {
  let privateMessages = 0;
  const { transport, fake } = makeTransport({
    privateChats: true,
    onPrivateMessage: () => {
      privateMessages += 1;
    },
  });
  await transport.start();
  emit(fake, 'connection.update', { connection: 'open' });
  await flush();

  emit(fake, 'messages.upsert', {
    type: 'notify',
    messages: [
      { key: { remoteJid: '919222222222@s.whatsapp.net', id: 'p2', fromMe: false }, message: { conversation: 'hi' } },
    ],
  });
  await flush();

  assert.equal(privateMessages, 1);
});

test('group messages are mapped into a transport-neutral envelope', async () => {
  const received = [];
  const { transport, fake } = makeTransport({ onMessage: (envelope) => received.push(envelope) });
  await transport.start();
  emit(fake, 'connection.update', { connection: 'open' });
  await flush();

  emit(fake, 'messages.upsert', {
    type: 'notify',
    messages: [
      {
        key: { remoteJid: GROUP_A, id: 'g1', participant: MEMBER_JID, fromMe: false },
        pushName: 'Alice',
        message: { conversation: 'hello everyone' },
        messageTimestamp: 1_700_000_000,
      },
    ],
  });
  await flush();

  assert.equal(received.length, 1);
  const envelope = received[0];
  assert.equal(envelope.transport, 'personal');
  assert.equal(envelope.isGroup, true);
  assert.equal(envelope.groupJid, GROUP_A);
  assert.equal(envelope.senderJid, MEMBER_JID);
  assert.equal(envelope.text, 'hello everyone');
  assert.equal(envelope.timestampMs, 1_700_000_000_000);
});

test('history sync and self-sent messages are skipped', async () => {
  let count = 0;
  const { transport, fake } = makeTransport({ onMessage: () => (count += 1) });
  await transport.start();
  emit(fake, 'connection.update', { connection: 'open' });
  await flush();

  emit(fake, 'messages.upsert', {
    type: 'append',
    messages: [
      {
        key: { remoteJid: GROUP_A, id: 'h1', participant: MEMBER_JID, fromMe: false },
        message: { conversation: 'old' },
      },
    ],
  });
  emit(fake, 'messages.upsert', {
    type: 'notify',
    messages: [
      {
        key: { remoteJid: GROUP_A, id: 'h2', participant: '911111111111@s.whatsapp.net', fromMe: true },
        message: { conversation: 'mine' },
      },
    ],
  });
  await flush();

  assert.equal(count, 0);
});

test('sendText requires a connected session and returns a verified id', async () => {
  const { transport, fake } = makeTransport();
  await assert.rejects(() => transport.sendText(GROUP_A, 'hello'), /not connected/);

  await transport.start();
  emit(fake, 'connection.update', { connection: 'open' });
  await flush();

  const result = await transport.sendText(GROUP_A, 'hello group');
  assert.equal(result.verified, true);
  assert.equal(result.id, 'msg_1');
  assert.equal(fake.sent[0].jid, GROUP_A);
  assert.equal(fake.sent[0].payload.text, 'hello group');

  await assert.rejects(() => transport.sendText(GROUP_A, '   '), /empty message/);
});

test('sendDirectText normalizes a phone number recipient', async () => {
  const { transport, fake } = makeTransport();
  await transport.start();
  emit(fake, 'connection.update', { connection: 'open' });
  await flush();

  const result = await transport.sendDirectText('919999999999', 'admin alert');
  assert.equal(result.verified, true);
  assert.equal(fake.sent.at(-1).jid, '919999999999@s.whatsapp.net');
});

test('remove is verified against fresh metadata', async () => {
  let participants = [{ id: ADMIN_JID, admin: 'admin' }];
  const { transport } = makeTransport({
    metadata: (jid) => ({ id: jid, subject: 'Group', participants }),
  });
  await transport.start();

  const result = await transport.executeAdminAction({
    action: 'remove_participant',
    groupJid: GROUP_A,
    participantJid: '918888888888',
  });
  assert.equal(result.verified, true);

  participants = [
    { id: ADMIN_JID, admin: 'admin' },
    { id: '918888888888@s.whatsapp.net', admin: null },
  ];
  const unverified = await transport.executeAdminAction({
    action: 'remove_participant',
    groupJid: GROUP_A,
    participantJid: '918888888888',
  });
  assert.equal(unverified.verified, false);
});

test('promote and demote are verified by the resulting admin flag', async () => {
  let participants = [{ id: '918888888888@s.whatsapp.net', admin: null }];
  const { transport } = makeTransport({
    metadata: (jid) => ({ id: jid, subject: 'Group', participants }),
  });
  await transport.start();

  const promoted = await transport.executeAdminAction({
    action: 'promote_participant',
    groupJid: GROUP_A,
    participantJid: '918888888888',
  });
  assert.equal(promoted.verified, false);

  participants = [{ id: '918888888888@s.whatsapp.net', admin: 'admin' }];
  const promotedAgain = await transport.executeAdminAction({
    action: 'promote_participant',
    groupJid: GROUP_A,
    participantJid: '918888888888',
  });
  assert.equal(promotedAgain.verified, true);
});

test('set_subject is verified by reading the new subject back', async () => {
  const { transport } = makeTransport({
    metadata: (jid) => ({ id: jid, subject: 'New Subject', participants: [] }),
  });
  await transport.start();

  const result = await transport.executeAdminAction({
    action: 'set_subject',
    groupJid: GROUP_A,
    value: 'New Subject',
  });
  assert.equal(result.verified, true);
});

test('cloud-only administration is explicitly unsupported', async () => {
  const { transport } = makeTransport();
  await transport.start();
  await assert.rejects(
    () => transport.executeAdminAction({ action: 'delete_group', groupJid: GROUP_A, participantJid: '918888888888' }),
    /Unsupported/
  );
});
