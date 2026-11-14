import test from 'node:test';
import assert from 'node:assert/strict';
import { toolDeclarations, executeToolCall } from '../src/tools/index.js';
import { getCurrentTime } from '../src/tools/time.js';
import { getWeather } from '../src/tools/weather.js';

test('Tools: registry exposes expected function schemas', () => {
  assert.ok(Array.isArray(toolDeclarations));
  assert.strictEqual(toolDeclarations.length, 9);

  const toolNames = toolDeclarations.map((t) => t.name);
  assert.ok(toolNames.includes('get_current_time'));
  assert.ok(toolNames.includes('get_current_weather'));
  assert.ok(toolNames.includes('schedule_reminder'));
  assert.ok(toolNames.includes('add_todo_task'));
  assert.ok(toolNames.includes('search_nearby'));
  assert.ok(toolNames.includes('log_expense'));
  assert.ok(toolNames.includes('get_monthly_expenses'));
  assert.ok(toolNames.includes('create_calendar_invite'));
  assert.ok(toolNames.includes('share_contact_card'));
});

test('Tools: getCurrentTime returns valid formatted time payload', async () => {
  const res = await getCurrentTime({ timezone: 'Asia/Kolkata' });
  assert.strictEqual(res.status, 'success');
  assert.ok(res.current_time);
  assert.strictEqual(res.timezone, 'Asia/Kolkata');

  // Fallback for invalid timezone
  const invalidTz = await getCurrentTime({ timezone: 'Invalid/Zone' });
  assert.strictEqual(invalidTz.status, 'success');
  assert.ok(invalidTz.note);
});

test('Tools: getWeather validates input and handles errors gracefully', async () => {
  // Empty location
  const emptyRes = await getWeather({ location: '' });
  assert.strictEqual(emptyRes.status, 'error');
  assert.ok(emptyRes.message.includes('Missing location'));
});

test('Tools: executeToolCall executes schedule_reminder and add_todo_task', async () => {
  const context = { from: '910000000000', anonId: 'u_tool_test_user' };

  // 1. Add todo task via tool
  const todoRes = await executeToolCall('add_todo_task', { task: 'Buy almond milk' }, context);
  assert.strictEqual(todoRes.status, 'success');
  assert.ok(todoRes.task_id);

  // 2. Schedule reminder via tool
  const remRes = await executeToolCall(
    'schedule_reminder',
    { when: '30m', description: 'Check washing machine' },
    context
  );
  assert.strictEqual(remRes.status, 'success');
  assert.ok(remRes.reminder_id);

  // 3. Unknown tool
  const unknownRes = await executeToolCall('launch_rocket', {}, context);
  assert.strictEqual(unknownRes.status, 'error');
});
