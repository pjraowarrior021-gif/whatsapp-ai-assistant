import { test } from 'node:test';
import assert from 'node:assert';
import {
  buildQuickReplyButtons,
  buildListMenu,
  buildFlowMessage,
  sendWhatsAppInteractive,
} from '../src/interactive.js';
import { buildInteractiveMenuOptions, detectInteractiveIntent } from '../src/conversation-adapter.js';

test('Interactive: buildQuickReplyButtons builds valid button payload', () => {
  const payload = buildQuickReplyButtons(
    'Select an option:',
    [
      { id: 'btn_1', title: 'Option 1' },
      { id: 'btn_2', title: 'Very long button label that exceeds limit' },
    ],
    {
      header: 'Quick Menu',
      footer: 'Powered by WhatsApp Assistant',
    }
  );

  assert.strictEqual(payload.type, 'button');
  assert.strictEqual(payload.body.text, 'Select an option:');
  assert.strictEqual(payload.header.text, 'Quick Menu');
  assert.strictEqual(payload.footer.text, 'Powered by WhatsApp Assistant');
  assert.strictEqual(payload.action.buttons.length, 2);
  assert.strictEqual(payload.action.buttons[0].reply.id, 'btn_1');
  assert.strictEqual(payload.action.buttons[0].reply.title, 'Option 1');
  // Title truncated to 20 chars
  assert.strictEqual(payload.action.buttons[1].reply.title.length, 20);
});

test('Interactive: buildQuickReplyButtons validates button constraints', () => {
  assert.throws(() => buildQuickReplyButtons('', [{ id: '1', title: 'A' }]), /bodyText/);
  assert.throws(() => buildQuickReplyButtons('Hello', []), /at least 1 button/);
  assert.throws(
    () =>
      buildQuickReplyButtons('Hello', [
        { id: '1', title: 'A' },
        { id: '2', title: 'B' },
        { id: '3', title: 'C' },
        { id: '4', title: 'D' },
      ]),
    /maximum of 3 buttons/
  );
});

test('Interactive: buildListMenu builds valid sections and row payload', () => {
  const payload = buildListMenu(
    'Choose a category:',
    'View Menu',
    [
      {
        title: 'Tools',
        rows: [
          { id: 'reminders', title: 'Reminders', description: 'Manage your active reminders' },
          { id: 'todos', title: 'To-Do List', description: 'View and check off pending tasks' },
        ],
      },
      {
        title: 'Media',
        rows: [{ id: 'generate_image', title: 'AI Image', description: 'Create photorealistic art' }],
      },
    ],
    {
      footer: 'Tap to select an item',
    }
  );

  assert.strictEqual(payload.type, 'list');
  assert.strictEqual(payload.action.button, 'View Menu');
  assert.strictEqual(payload.action.sections.length, 2);
  assert.strictEqual(payload.action.sections[0].rows.length, 2);
  assert.strictEqual(payload.action.sections[1].rows.length, 1);
  assert.strictEqual(payload.footer.text, 'Tap to select an item');
});

test('Interactive: buildListMenu enforces row limits (max 10 rows total)', () => {
  const elevenRows = Array.from({ length: 11 }, (_, i) => ({
    id: `r_${i}`,
    title: `Row ${i}`,
  }));

  assert.throws(
    () => buildListMenu('Menu', 'Open', [{ title: 'Big Section', rows: elevenRows }]),
    /maximum of 10 rows/
  );

  assert.throws(() => buildListMenu('Menu', 'Open', [{ title: 'Empty', rows: [] }]), /at least 1 row/);
});

test('Interactive: buildFlowMessage constructs valid WhatsApp Flow payload', () => {
  const flow = buildFlowMessage(
    'Book an appointment with us:',
    {
      flowId: '123456789012345',
      flowCta: 'Book Now',
      flowToken: 'token_abc',
      initialScreen: 'DETAILS',
      initialData: { defaultService: 'Consulting' },
    },
    {
      header: 'Appointments',
    }
  );

  assert.strictEqual(flow.type, 'flow');
  assert.strictEqual(flow.action.name, 'flow');
  assert.strictEqual(flow.action.parameters.flow_id, '123456789012345');
  assert.strictEqual(flow.action.parameters.flow_cta, 'Book Now');
  assert.strictEqual(flow.action.parameters.flow_action_payload.screen, 'DETAILS');
});

test('Interactive: sendWhatsAppInteractive succeeds in test mode', async () => {
  const testPhone = '910000000000';
  const payload = buildQuickReplyButtons('Click below:', [{ id: 'test_btn', title: 'Test' }]);
  const res = await sendWhatsAppInteractive(testPhone, payload);

  assert.strictEqual(res.success, true);
  assert.ok(res.messageId.startsWith('sim_test_int_'));
});

test('Interactive: sendWhatsAppInteractive rejects invalid payload', async () => {
  const res = await sendWhatsAppInteractive('910000000000', null);
  assert.strictEqual(res.success, false);
  assert.ok(res.error);
});

test('Interactive Adapter: buildInteractiveMenuOptions switches between buttons and list menu', () => {
  // 3 or fewer items -> Quick-Reply Buttons
  const btnMenu = buildInteractiveMenuOptions('Quick Choices:', [
    { id: '1', title: 'Action 1' },
    { id: '2', title: 'Action 2' },
  ]);
  assert.strictEqual(btnMenu.type, 'button');
  assert.strictEqual(btnMenu.action.buttons.length, 2);

  // More than 3 items -> List Menu
  const listMenu = buildInteractiveMenuOptions('Browse Categories:', [
    { id: '1', title: 'Weather', description: 'Forecast' },
    { id: '2', title: 'News', description: 'Headlines' },
    { id: '3', title: 'Reminders', description: 'Tasks' },
    { id: '4', title: 'Finance', description: 'Expenses' },
  ]);
  assert.strictEqual(listMenu.type, 'list');
  assert.strictEqual(listMenu.action.sections[0].rows.length, 4);

  // Null on empty
  assert.strictEqual(buildInteractiveMenuOptions('Empty', []), null);
});

test('Interactive Adapter: detectInteractiveIntent identifies user choice requests', () => {
  assert.strictEqual(detectInteractiveIntent('What can you do?'), true);
  assert.strictEqual(detectInteractiveIntent('Show me menu'), true);
  assert.strictEqual(detectInteractiveIntent('help menu'), true);
  assert.strictEqual(detectInteractiveIntent('What are the quick actions available?'), true);
  assert.strictEqual(detectInteractiveIntent('How is the weather today in Tokyo?'), false);
});
