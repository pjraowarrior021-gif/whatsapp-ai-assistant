import test from 'node:test';
import assert from 'node:assert/strict';
import {
  exportUserData,
  generateCalendarEventIcs,
  sendCalendarInvite,
  generateContactCardVcf,
  sendContactCard,
} from '../src/export.js';
import { addTodo } from '../src/todos.js';
import { addMemoryFact } from '../src/memory.js';

test('Export: compiles sanitized JSON structure and handles delivery', async () => {
  const testPhone = '910000000000';
  const anonId = 'u_export_test_user';

  // Seed user data
  addTodo(anonId, 'Sample todo task for export');
  await addMemoryFact(anonId, 'Likes green tea');

  const result = await exportUserData(testPhone, anonId);
  assert.strictEqual(result.success, true);
  assert.ok(result.message);
});

test('Export: generateCalendarEventIcs generates valid RFC 5545 iCalendar payload', () => {
  const icsBuffer = generateCalendarEventIcs({
    title: 'Product Review Meeting',
    description: 'Quarterly roadmap review with leadership',
    location: 'Meeting Room 4B',
    startTime: '2026-11-20T10:00:00Z',
    durationMinutes: 45,
  });

  assert.ok(Buffer.isBuffer(icsBuffer));
  const icsText = icsBuffer.toString('utf-8');

  assert.ok(icsText.includes('BEGIN:VCALENDAR'));
  assert.ok(icsText.includes('VERSION:2.0'));
  assert.ok(icsText.includes('BEGIN:VEVENT'));
  assert.ok(icsText.includes('SUMMARY:Product Review Meeting'));
  assert.ok(icsText.includes('LOCATION:Meeting Room 4B'));
  assert.ok(icsText.includes('DESCRIPTION:Quarterly roadmap review with leadership'));
  assert.ok(icsText.includes('END:VEVENT'));
  assert.ok(icsText.includes('END:VCALENDAR'));
});

test('Export: sendCalendarInvite dispatches .ics document via WhatsApp', async () => {
  const testPhone = '910000000000';
  const res = await sendCalendarInvite(testPhone, {
    title: 'Doctor Appointment',
    startTime: '2026-11-22T15:00:00Z',
    durationMinutes: 30,
  });

  assert.strictEqual(res.success, true);
  assert.ok(res.messageId);
});

test('Export: generateContactCardVcf generates valid vCard 3.0 payload', () => {
  const vcfBuffer = generateContactCardVcf({
    name: 'Rahul Sharma',
    phone: '+919876543210',
    email: 'rahul.sharma@example.com',
    organization: 'Acme Corp',
    title: 'Lead Architect',
    note: 'Met at Bangalore Tech Summit',
  });

  assert.ok(Buffer.isBuffer(vcfBuffer));
  const vcfText = vcfBuffer.toString('utf-8');

  assert.ok(vcfText.includes('BEGIN:VCARD'));
  assert.ok(vcfText.includes('VERSION:3.0'));
  assert.ok(vcfText.includes('FN:Rahul Sharma'));
  assert.ok(vcfText.includes('TEL;TYPE=CELL,VOICE:+919876543210'));
  assert.ok(vcfText.includes('EMAIL;TYPE=INTERNET:rahul.sharma@example.com'));
  assert.ok(vcfText.includes('ORG:Acme Corp'));
  assert.ok(vcfText.includes('TITLE:Lead Architect'));
  assert.ok(vcfText.includes('END:VCARD'));
});

test('Export: sendContactCard dispatches .vcf document via WhatsApp', async () => {
  const testPhone = '910000000000';
  const res = await sendContactCard(testPhone, {
    name: 'Priya Patel',
    phone: '+919123456780',
    email: 'priya@startup.io',
  });

  assert.strictEqual(res.success, true);
  assert.ok(res.messageId);
});
