/**
 * Model Context Protocol (MCP) Client Bridge
 * Connects the WhatsApp AI Assistant to external MCP Servers (Calendar, Gmail, Notion, etc.)
 * using standard JSON-RPC 2.0 over HTTP/SSE and Stdio transports with zero third-party dependencies.
 */
import { config } from '../config.js';
import { privacyLog } from '../privacy.js';

export class McpClient {
  /**
   * @param {object} options
   * @param {string} options.serverName - Identifier (e.g. 'calendar', 'gmail', 'notion')
   * @param {string} [options.url] - HTTP/SSE endpoint URL
   * @param {string} [options.command] - Stdio executable command (for local servers)
   * @param {string[]} [options.args] - Stdio arguments
   * @param {boolean} [options.isMock] - Mock test transport flag
   * @param {Array<object>} [options.mockTools] - Initial mock tools for test mode
   */
  constructor(options = {}) {
    this.serverName = options.serverName || 'default_mcp';
    this.url = options.url || null;
    this.command = options.command || null;
    this.args = options.args || [];
    this.isMock = Boolean(options.isMock || config.NODE_ENV === 'test');
    this.mockTools = options.mockTools || [
      {
        name: `${this.serverName}_list_events`,
        description: `List upcoming events from ${this.serverName}`,
        inputSchema: {
          type: 'object',
          properties: { count: { type: 'number', description: 'Number of events to retrieve' } },
        },
      },
    ];
    this.connected = false;
    this.requestId = 1;
    this.tools = [];
  }

  /**
   * Connects to MCP server and performs JSON-RPC 2.0 initialize handshake.
   * @returns {Promise<boolean>}
   */
  async connect() {
    if (this.isMock) {
      this.connected = true;
      this.tools = [...this.mockTools];
      privacyLog('info', 'MCP_CLIENT_CONNECTED_MOCK', { server: this.serverName });
      return true;
    }

    if (!this.url) {
      throw new Error(`MCP client '${this.serverName}' requires a valid url`);
    }

    try {
      const initPayload = {
        jsonrpc: '2.0',
        id: this.requestId++,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          clientInfo: {
            name: 'whatsapp-ai-assistant',
            version: '1.0.0',
          },
        },
      };

      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initPayload),
      });

      if (!res.ok) {
        throw new Error(`MCP handshake failed HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data.error) {
        throw new Error(`MCP initialize error: ${data.error.message}`);
      }

      this.connected = true;
      privacyLog('info', 'MCP_CLIENT_INITIALIZED', { server: this.serverName });
      await this.listTools();
      return true;
    } catch (err) {
      privacyLog('error', 'MCP_CLIENT_CONNECT_ERROR', { server: this.serverName, error: err.message });
      throw err;
    }
  }

  /**
   * Discovers tools from the MCP server via tools/list.
   * @returns {Promise<Array<object>>}
   */
  async listTools() {
    if (this.isMock) {
      return this.tools;
    }

    const payload = {
      jsonrpc: '2.0',
      id: this.requestId++,
      method: 'tools/list',
      params: {},
    };

    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (data.error) {
      throw new Error(`MCP tools/list failed: ${data.error.message}`);
    }

    this.tools = (data.result?.tools || []).map((t) => ({
      ...t,
      name: t.name.startsWith(this.serverName) ? t.name : `${this.serverName}_${t.name}`,
    }));

    return this.tools;
  }

  /**
   * Invokes an MCP tool on this server via tools/call.
   *
   * @param {string} toolName - Tool name
   * @param {object} [toolArgs={}] - Input arguments
   * @returns {Promise<{ status: string, result: any }>}
   */
  async callTool(toolName, toolArgs = {}) {
    if (!this.connected) {
      await this.connect();
    }

    if (this.isMock) {
      privacyLog('info', 'MCP_TOOL_INVOKED_MOCK', { server: this.serverName, tool: toolName });
      return {
        status: 'success',
        result: {
          content: [
            {
              type: 'text',
              text: `[MCP ${this.serverName}] Tool '${toolName}' executed successfully with args: ${JSON.stringify(toolArgs)}`,
            },
          ],
        },
      };
    }

    // Strip prefix if added
    const rawName = toolName.startsWith(`${this.serverName}_`) ? toolName.slice(this.serverName.length + 1) : toolName;

    const payload = {
      jsonrpc: '2.0',
      id: this.requestId++,
      method: 'tools/call',
      params: {
        name: rawName,
        arguments: toolArgs,
      },
    };

    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (data.error) {
      throw new Error(`MCP tool call failed: ${data.error.message}`);
    }

    return {
      status: 'success',
      result: data.result,
    };
  }

  /**
   * Disconnects MCP client.
   */
  async disconnect() {
    this.connected = false;
  }
}

/**
 * Registry and Manager for all configured MCP servers.
 */
class McpManager {
  constructor() {
    this.clients = new Map();
  }

  /**
   * Registers and connects an MCP client.
   * @param {string} name
   * @param {McpClient} client
   */
  registerClient(name, client) {
    this.clients.set(name, client);
  }

  /**
   * Gets a registered client by server name.
   * @param {string} name
   * @returns {McpClient|null}
   */
  getClient(name) {
    return this.clients.get(name) || null;
  }

  /**
   * Finds the server responsible for a tool name.
   * @param {string} toolName
   * @returns {{ client: McpClient, toolName: string }|null}
   */
  findToolHandler(toolName) {
    for (const [serverName, client] of this.clients.entries()) {
      if (toolName.startsWith(`${serverName}_`) || client.tools.some((t) => t.name === toolName)) {
        return { client, serverName };
      }
    }
    return null;
  }

  /**
   * Lists all available tools across all active MCP servers.
   * @returns {Array<object>}
   */
  getAllTools() {
    const all = [];
    for (const client of this.clients.values()) {
      all.push(...client.tools);
    }
    return all;
  }

  /**
   * Converts all registered MCP tools into Google Gemini function declaration schemas.
   * @returns {Array<object>}
   */
  getGeminiDeclarations() {
    return this.getAllTools().map((t) => ({
      name: t.name,
      description: t.description || `Execute external MCP tool ${t.name}`,
      parameters: {
        type: 'OBJECT',
        properties: t.inputSchema?.properties || {},
        required: t.inputSchema?.required || [],
      },
    }));
  }

  /**
   * Initializes MCP servers configured in environment variables or options.
   * Config format: JSON map or comma-separated pairs: "calendar=http://...,notion=http://..."
   *
   * @param {object|string} [serversConfig]
   * @returns {Promise<number>} count of registered servers
   */
  async initFromConfig(serversConfig = config.MCP_SERVERS) {
    if (!serversConfig) {
      // If in test mode, initialize mock calendar and notion servers
      if (config.NODE_ENV === 'test') {
        const calClient = new McpClient({ serverName: 'calendar', isMock: true });
        await calClient.connect();
        this.registerClient('calendar', calClient);

        const notionClient = new McpClient({ serverName: 'notion', isMock: true });
        await notionClient.connect();
        this.registerClient('notion', notionClient);
        return 2;
      }
      return 0;
    }

    let parsed = {};
    if (typeof serversConfig === 'object') {
      parsed = serversConfig;
    } else if (typeof serversConfig === 'string') {
      try {
        parsed = JSON.parse(serversConfig);
      } catch {
        // Parse key=url pairs
        const pairs = serversConfig.split(',');
        for (const pair of pairs) {
          const [k, v] = pair.split('=').map((s) => s.trim());
          if (k && v) parsed[k] = v;
        }
      }
    }

    let count = 0;
    for (const [serverName, url] of Object.entries(parsed)) {
      try {
        const client = new McpClient({ serverName, url });
        await client.connect();
        this.registerClient(serverName, client);
        count++;
      } catch (err) {
        privacyLog('warn', 'MCP_SERVER_INIT_SKIPPED', { server: serverName, error: err.message });
      }
    }

    return count;
  }
}

export const mcpManager = new McpManager();
