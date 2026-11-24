'use strict';

const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  '2025-06-18',
  '2025-03-26',
  '2024-11-05'
]);
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function formatToolResult(payload, { isError = false, imageBlocks = [] } = {}) {
  const content = [];
  if (typeof payload === 'string') {
    content.push({ type: 'text', text: payload });
  } else {
    content.push({
      type: 'text',
      text: JSON.stringify(payload, null, 2)
    });
  }
  for (const img of imageBlocks) {
    if (img && typeof img.data === 'string' && typeof img.mimeType === 'string') {
      content.push({
        type: 'image',
        data: img.data,
        mimeType: img.mimeType
      });
    }
  }
  return {
    content,
    ...(isPlainObject(payload) ? { structuredContent: payload } : {}),
    ...(isError ? { isError: true } : {})
  };
}

function formatToolErrorResult(name, error) {
  return formatToolResult(
    {
      ok: false,
      tool: name,
      error: {
        code: error?.code ?? 'MCP_TOOL_ERROR',
        message: error instanceof Error ? error.message : String(error),
        ...(error?.data !== undefined ? { data: error.data } : {})
      }
    },
    { isError: true }
  );
}

function jsonRpcSuccess(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result
  };
}

function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code,
      message: String(message || 'MCP request failed'),
      ...(data !== undefined ? { data } : {})
    }
  };
}

function createMcpToolRegistry() {
  const tools = new Map();

  function registerTool(definition) {
    if (!isPlainObject(definition) || typeof definition.name !== 'string' || !/^[a-z0-9_]{1,64}$/.test(definition.name)) {
      throw new Error('Invalid MCP tool name');
    }
    if (typeof definition.description !== 'string' || !definition.description.trim()) {
      throw new Error(`MCP tool "${definition.name}" requires a description`);
    }
    if (!isPlainObject(definition.inputSchema) || definition.inputSchema.type !== 'object') {
      throw new Error(`MCP tool "${definition.name}" requires an object inputSchema`);
    }
    if (typeof definition.handler !== 'function') {
      throw new Error(`MCP tool "${definition.name}" requires a handler function`);
    }
    tools.set(definition.name, {
      name: definition.name,
      description: definition.description,
      inputSchema: JSON.parse(JSON.stringify(definition.inputSchema)),
      handler: definition.handler
    });
  }

  function listTools() {
    return [...tools.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema: JSON.parse(JSON.stringify(inputSchema))
    }));
  }

  async function callTool(name, args = {}, context = {}) {
    const entry = tools.get(name);
    if (!entry) {
      throw Object.assign(new Error(`Unknown MCP tool: ${name}`), { code: -32602 });
    }
    if (args !== undefined && !isPlainObject(args)) {
      throw Object.assign(new Error(`Invalid arguments for MCP tool "${name}": expected object`), { code: -32602 });
    }
    try {
      const outcome = await entry.handler(args ?? {}, context);
      if (isPlainObject(outcome) && Array.isArray(outcome.content)) {
        return outcome;
      }
      return formatToolResult(outcome);
    } catch (error) {
      return formatToolErrorResult(name, error);
    }
  }

  return Object.freeze({
    registerTool,
    listTools,
    callTool,
    hasTool: name => tools.has(name)
  });
}

function registerFoundationTools(registry, { dispatchToHost, serverVersion = '2.1.3' }) {
  if (typeof dispatchToHost !== 'function') {
    throw new Error('registerFoundationTools requires a dispatchToHost function');
  }

  registry.registerTool({
    name: 'ester_ping',
    description: 'Check live connectivity across the MCP Server, Lactone Studio Electron main process, and the active React workbench window.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Optional echo message to verify round-trip transport.'
        }
      },
      additionalProperties: false
    },
    async handler(args) {
      if (args.message !== undefined && (typeof args.message !== 'string' || args.message.length > 1024)) {
        throw Object.assign(new Error('message must be a string up to 1024 characters'), { code: 'INVALID_PING_MESSAGE' });
      }
      const startedAt = Date.now();
      const hostResponse = await dispatchToHost('ping', {
        ...(args.message !== undefined ? { message: args.message } : {})
      });
      return {
        ok: true,
        mcpServer: {
          status: 'online',
          version: serverVersion
        },
        roundTripMs: Math.max(0, Date.now() - startedAt),
        ...(args.message !== undefined ? { echo: args.message } : {}),
        host: hostResponse
      };
    }
  });
}

function registerAllMcpTools(registry, { dispatchToHost, serverVersion = '2.1.3', registerExtraTools } = {}) {
  registerFoundationTools(registry, { dispatchToHost, serverVersion });
  if (typeof registerExtraTools === 'function') {
    registerExtraTools(registry, { dispatchToHost, serverVersion });
  }
  return registry;
}

function createMcpProtocolProcessor({
  registry,
  serverName = 'lactone-studio-mcp',
  serverVersion = '2.1.3',
  listDynamicTools,
  callDynamicTool,
  listChanged = false
}) {
  if (!registry || typeof registry.listTools !== 'function' || typeof registry.callTool !== 'function') {
    throw new Error('createMcpProtocolProcessor requires a valid tool registry');
  }

  async function handleMessage(message, context = {}) {
    if (!isPlainObject(message) || message.jsonrpc !== '2.0') {
      return jsonRpcError(message?.id ?? null, -32600, 'Invalid JSON-RPC 2.0 request');
    }
    const { id, method, params } = message;
    const isNotification = id === undefined;

    if (typeof method !== 'string' || !method) {
      return isNotification ? null : jsonRpcError(id, -32600, 'Missing JSON-RPC method');
    }

    if (method.startsWith('notifications/')) {
      return null;
    }

    if (isNotification) {
      return null;
    }

    try {
      if (method === 'initialize') {
        const requestedVersion = isPlainObject(params) && typeof params.protocolVersion === 'string'
          ? params.protocolVersion
          : DEFAULT_PROTOCOL_VERSION;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
          ? requestedVersion
          : DEFAULT_PROTOCOL_VERSION;
        return jsonRpcSuccess(id, {
          protocolVersion,
          capabilities: {
            tools: {
              listChanged: Boolean(listChanged || typeof listDynamicTools === 'function')
            }
          },
          serverInfo: {
            name: serverName,
            version: serverVersion
          }
        });
      }

      if (method === 'ping') {
        return jsonRpcSuccess(id, {});
      }

      if (method === 'tools/list') {
        const baseTools = registry.listTools();
        const dynamicTools = typeof listDynamicTools === 'function'
          ? await listDynamicTools(context)
          : [];
        const seen = new Set(baseTools.map(tool => tool.name));
        const merged = [...baseTools];
        if (Array.isArray(dynamicTools)) {
          for (const tool of dynamicTools) {
            if (!isPlainObject(tool) || typeof tool.name !== 'string' || seen.has(tool.name)) continue;
            seen.add(tool.name);
            merged.push({
              name: tool.name,
              description: tool.description,
              inputSchema: JSON.parse(JSON.stringify(tool.inputSchema))
            });
          }
        }
        return jsonRpcSuccess(id, {
          tools: merged
        });
      }

      if (method === 'tools/call') {
        if (!isPlainObject(params) || typeof params.name !== 'string' || !params.name) {
          return jsonRpcError(id, -32602, 'tools/call requires params.name');
        }
        if (registry.hasTool(params.name)) {
          const toolResult = await registry.callTool(params.name, params.arguments ?? {}, context);
          return jsonRpcSuccess(id, toolResult);
        }
        if (typeof callDynamicTool === 'function') {
          const args = params.arguments ?? {};
          if (!isPlainObject(args)) {
            return jsonRpcError(id, -32602, `Invalid arguments for MCP tool "${params.name}": expected object`);
          }
          try {
            const outcome = await callDynamicTool(params.name, args, context);
            if (isPlainObject(outcome) && Array.isArray(outcome.content)) {
              return jsonRpcSuccess(id, outcome);
            }
            return jsonRpcSuccess(id, formatToolResult(outcome));
          } catch (error) {
            if (error?.code === -32602 || error?.code === 'unknown_tool') {
              return jsonRpcError(id, -32602, error instanceof Error ? error.message : String(error));
            }
            return jsonRpcSuccess(id, formatToolErrorResult(params.name, error));
          }
        }
        const toolResult = await registry.callTool(params.name, params.arguments ?? {}, context);
        return jsonRpcSuccess(id, toolResult);
      }

      return jsonRpcError(id, -32601, `Method not found: ${method}`);
    } catch (error) {
      const code = typeof error?.code === 'number' ? error.code : -32603;
      return jsonRpcError(id, code, error instanceof Error ? error.message : String(error));
    }
  }

  return Object.freeze({
    handleMessage
  });
}

module.exports = {
  SUPPORTED_PROTOCOL_VERSIONS,
  DEFAULT_PROTOCOL_VERSION,
  isPlainObject,
  formatToolResult,
  formatToolErrorResult,
  jsonRpcSuccess,
  jsonRpcError,
  createMcpToolRegistry,
  registerFoundationTools,
  registerAllMcpTools,
  createMcpProtocolProcessor
};
