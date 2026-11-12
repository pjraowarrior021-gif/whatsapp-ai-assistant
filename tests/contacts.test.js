import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import {
  addContact,
  removeContact,
  getContact,
  listContacts,
  resolveContactRecipient,
  formatContactsList,
  setContactAiAllowed,
  isKnownContact,
  isContactAiAllowed,
  sendOutboundContactMessage,
  isPrimaryAdmin,
  maskPhoneNumber,
  isValidAlias,
  isValidPhoneNumber,
  clearContacts,
  initContacts,
  persistContacts,
} from '../src/contacts.js';

test.beforeEach(() => {
  clearContacts();
  config.NODE_ENV = 'test';
  config.ALLOWED_PHONE_NUMBERS = new Set(['919999999999']);
  delete process.env.ADMIN_PHONE_NUMBER;
});

test.afterEach(() => {
  clearContacts();
});

test('Contacts: maskPhoneNumber properly redacts phone numbers', () => {
  assert.strictEqual(maskPhoneNumber('919876543210'), '+91987 ****10');
  assert.strictEqual(maskPhoneNumber('14155552671'), '+14155 ****71');
  assert.strictEqual(maskPhoneNumber('123'), '****');
  assert.strictEqual(maskPhoneNumber(''), '');
});

test('Contacts: isValidAlias validates format and length limits', () => {
  assert.strictEqual(isValidAlias('mom'), true);
  assert.strictEqual(isValidAlias('john_doe'), true);
  assert.strictEqual(isValidAlias('client123'), true);

  assert.strictEqual(isValidAlias('a'), false); // too short (< 2)
  assert.strictEqual(isValidAlias('hello world'), false); // spaces not allowed
  assert.strictEqual(isValidAlias('mom!'), false); // special characters
  assert.strictEqual(isValidAlias(''), false);
});

test('Contacts: isValidPhoneNumber checks international length', () => {
  assert.strictEqual(isValidPhoneNumber('919876543210'), true);
  assert.strictEqual(isValidPhoneNumber('+91 98765 43210'), true);
  assert.strictEqual(isValidPhoneNumber('14155552671'), true);

  assert.strictEqual(isValidPhoneNumber('12345'), false); // too short
  assert.strictEqual(isValidPhoneNumber('abc'), false);
});

test('Contacts: isPrimaryAdmin identifies configured admin', () => {
  assert.strictEqual(isPrimaryAdmin('919999999999'), true);
  assert.strictEqual(isPrimaryAdmin('+91 99999 99999'), true);
  assert.strictEqual(isPrimaryAdmin('919888888888'), false);

  process.env.ADMIN_PHONE_NUMBER = '918888888888';
  assert.strictEqual(isPrimaryAdmin('918888888888'), true);
  delete process.env.ADMIN_PHONE_NUMBER;
});

test('Contacts: addContact registers new contact and indexes by alias & phone', () => {
  const res = addContact('mom', '919876543210', 'Mother');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.contact.alias, 'mom');
  assert.strictEqual(res.contact.phone, '919876543210');
  assert.strictEqual(res.contact.name, 'Mother');
  assert.strictEqual(res.contact.allowAiChat, false);

  // Lookup by alias
  const byAlias = getContact('mom');
  assert.ok(byAlias);
  assert.strictEqual(byAlias.phone, '919876543210');

  // Lookup by phone
  const byPhone = getContact('919876543210');
  assert.ok(byPhone);
  assert.strictEqual(byPhone.alias, 'mom');

  assert.strictEqual(isKnownContact('919876543210'), true);
  assert.strictEqual(isContactAiAllowed('919876543210'), false);
});

test('Contacts: addContact rejects admin self-number', () => {
  const res = addContact('myself', '919999999999');
  assert.strictEqual(res.ok, false);
  assert.ok(res.error.includes('administrator'));
});

test('Contacts: resolveContactRecipient resolves alias and raw phone numbers', () => {
  addContact('alex', '919123456789', 'Alex Doe');

  const resolvedAlias = resolveContactRecipient('alex');
  assert.ok(resolvedAlias);
  assert.strictEqual(resolvedAlias.phone, '919123456789');
  assert.strictEqual(resolvedAlias.name, 'Alex Doe');
  assert.strictEqual(resolvedAlias.isAlias, true);

  const resolvedRaw = resolveContactRecipient('919988776655');
  assert.ok(resolvedRaw);
  assert.strictEqual(resolvedRaw.phone, '919988776655');
  assert.strictEqual(resolvedRaw.isAlias, false);

  const invalid = resolveContactRecipient('unknown_contact');
  assert.strictEqual(invalid, null);
});

test('Contacts: removeContact deletes contact and reverse indexes', () => {
  addContact('shreya', '919876543211', 'Shreya');
  assert.strictEqual(isKnownContact('919876543211'), true);

  const removeRes = removeContact('shreya');
  assert.strictEqual(removeRes.ok, true);
  assert.strictEqual(removeRes.removed.alias, 'shreya');

  assert.strictEqual(getContact('shreya'), null);
  assert.strictEqual(isKnownContact('919876543211'), false);
});

test('Contacts: setContactAiAllowed updates AI access flag', () => {
  addContact('rahul', '919876543212', 'Rahul');
  assert.strictEqual(isContactAiAllowed('919876543212'), false);

  const updateRes = setContactAiAllowed('rahul', true);
  assert.strictEqual(updateRes.ok, true);
  assert.strictEqual(isContactAiAllowed('919876543212'), true);

  setContactAiAllowed('rahul', false);
  assert.strictEqual(isContactAiAllowed('919876543212'), false);
});

test('Contacts: formatContactsList returns masked formatted directory', () => {
  addContact('doctor', '919876543213', 'Dr. Smith');
  addContact('chef', '919876543214', 'Chef Mario', { allowAiChat: true });

  const contacts = listContacts();
  assert.strictEqual(contacts.length, 2);

  const text = formatContactsList();
  assert.ok(text.includes('WhatsApp Contacts Book (2)'));
  assert.ok(text.includes('Dr. Smith'));
  assert.ok(text.includes('`@doctor`'));
  assert.ok(text.includes('Chef Mario'));
  assert.ok(text.includes('`@chef`'));
  assert.ok(text.includes('🤖 Full AI & Relay'));
  assert.ok(text.includes('📨 Relay Only'));
});

test('Contacts: sendOutboundContactMessage blocks unauthorized non-admin senders', async () => {
  addContact('mom', '919876543210', 'Mother');

  // Attempt sending from unauthorized non-admin phone
  const res = await sendOutboundContactMessage('919888888888', 'mom', 'Hello mom');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'unauthorized');
  assert.ok(res.message.includes('Access Denied'));
});

test('Contacts: sendOutboundContactMessage delivers to alias and raw phone for Admin', async () => {
  addContact('mom', '919876543210', 'Mother');

  // Admin sending to alias
  const resAlias = await sendOutboundContactMessage('919999999999', 'mom', 'Dinner is ready!');
  assert.strictEqual(resAlias.ok, true);
  assert.strictEqual(resAlias.recipient.phone, '919876543210');
  assert.ok(resAlias.message.includes('Delivered'));

  // Admin sending to direct raw phone number
  const resRaw = await sendOutboundContactMessage('919999999999', '919876543215', 'Direct text message');
  assert.strictEqual(resRaw.ok, true);
  assert.strictEqual(resRaw.recipient.phone, '919876543215');
});

test('Contacts: sendOutboundContactMessage enforces rate limiting', async () => {
  addContact('friend', '919876543216', 'Friend');

  // Dispatch 20 messages up to the limit
  for (let i = 0; i < 20; i++) {
    const r = await sendOutboundContactMessage('919999999999', 'friend', `Msg #${i}`);
    assert.strictEqual(r.ok, true);
  }

  // 21st dispatch should be rate-limited
  const blocked = await sendOutboundContactMessage('919999999999', 'friend', 'Exceeded msg');
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.error, 'rate_limit_exceeded');
  assert.ok(blocked.message.includes('Outbound Limit Reached'));
});

test('Contacts: initContacts and persistContacts save and restore from disk', () => {
  const prevPersist = config.REMINDERS_PERSIST;
  const prevDataDir = config.DATA_DIR;
  const tempDir = path.resolve('.tmp-contacts-test');

  try {
    config.REMINDERS_PERSIST = true;
    config.DATA_DIR = tempDir;

    addContact('colleague', '919876543217', 'Colleague');
    assert.strictEqual(isKnownContact('919876543217'), true);
    persistContacts();

    const filePath = path.join(tempDir, 'contacts.json');
    assert.strictEqual(fs.existsSync(filePath), true);

    // Clear RAM and reload from disk
    clearContacts();
    assert.strictEqual(isKnownContact('919876543217'), false);

    initContacts();
    assert.strictEqual(isKnownContact('919876543217'), true);
    const restored = getContact('colleague');
    assert.strictEqual(restored.name, 'Colleague');
    assert.strictEqual(restored.phone, '919876543217');
  } finally {
    config.REMINDERS_PERSIST = prevPersist;
    config.DATA_DIR = prevDataDir;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});
