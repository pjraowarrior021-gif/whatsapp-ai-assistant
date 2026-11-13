import { test } from 'node:test';
import assert from 'node:assert';
import { McpClient, mcpManager } from '../src/tools/mcp-client.js';

test('MCP Client: connects and discovers tools in mock mode', async () => {
  const client = new McpClient({
    serverName: 'calendar',
    isMock: true,
    mockTools: [
      {
        name: 'calendar_list_events',
        description: 'Lists Google Calendar events',
        inputSchema: {
          type: 'object',
          properties: { days: { type: 'number' } },
        },
      },
    ],
  });

  await client.connect();
  assert.strictEqual(client.connected, true);

  const tools = await client.listTools();
  assert.strictEqual(tools.length, 1);
  assert.strictEqual(tools[0].name, 'calendar_list_events');
});

test('MCP Client: callTool executes tool and returns structured content', async () => {
  const client = new McpClient({
    serverName: 'notion',
    isMock: true,
  });

  const res = await client.callTool('notion_create_page', { title: 'Project Roadmap' });
  assert.strictEqual(res.status, 'success');
  assert.ok(res.result.content[0].text.includes('Project Roadmap'));
});

test('MCP Manager: registers clients and dispatches tool calls by name', async () => {
  const gClient = new McpClient({ serverName: 'gmail', isMock: true });
  await gClient.connect();

  mcpManager.registerClient('gmail', gClient);

  assert.strictEqual(mcpManager.getClient('gmail'), gClient);

  const handler = mcpManager.findToolHandler('gmail_send_message');
  assert.ok(handler);
  assert.strictEqual(handler.serverName, 'gmail');

  const missing = mcpManager.findToolHandler('unknown_external_tool');
  assert.strictEqual(missing, null);
});

test('MCP Manager: getGeminiDeclarations transforms schemas into valid Gemini format', async () => {
  const decls = mcpManager.getGeminiDeclarations();
  assert.ok(Array.isArray(decls));
  assert.ok(decls.length > 0);

  const sample = decls[0];
  assert.ok(sample.name);
  assert.ok(sample.description);
  assert.strictEqual(sample.parameters.type, 'OBJECT');
});

test('MCP Manager: initFromConfig parses string and object configurations', async () => {
  const count = await mcpManager.initFromConfig('analytics=http://localhost:4000/sse');
  assert.strictEqual(typeof count, 'number');
});
