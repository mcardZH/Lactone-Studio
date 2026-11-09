'use strict';

const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
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
      return formatToolResult(
        {
          ok: false,
          tool: name,
          error: {
            code: error?.code ?? 'MCP_TOOL_ERROR',
            message: error instanceof Error ? error.message : String(error)
          }
        },
        { isError: true }
      );
    }
  }

  return Object.freeze({
    registerTool,
    listTools,
    callTool,
    hasTool: name => tools.has(name)
  });
}

function registerFoundationTools(registry, { dispatchToHost, serverVersion = '2.0.2' }) {
  if (typeof dispatchToHost !== 'function') {
    throw new Error('registerFoundationTools requires a dispatchToHost function');
  }

  registry.registerTool({
    name: 'ester_ping',
    description: 'Check live connectivity across the MCP Server, Ester Studio Electron main process, and the active React workbench window.',
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

  registry.registerTool({
    name: 'ester_status',
    description: 'Get the current live status of Ester Studio, including platform info, active workbench module (modeling/advanced/input/analysis), task center visibility, and open structure/result documents.',
    inputSchema: {
      type: 'object',
      properties: {
        includeDocuments: {
          type: 'boolean',
          description: 'Whether to include the summary list of currently open documents in the workbench (default: true).'
        }
      },
      additionalProperties: false
    },
    async handler(args) {
      if (args.includeDocuments !== undefined && typeof args.includeDocuments !== 'boolean') {
        throw Object.assign(new Error('includeDocuments must be a boolean'), { code: 'INVALID_STATUS_OPTIONS' });
      }
      const includeDocuments = args.includeDocuments !== false;
      const status = await dispatchToHost('status', { includeDocuments });
      return {
        ok: true,
        mcpServerVersion: serverVersion,
        ...status
      };
    }
  });
}

const VALID_WORKSPACE_MODULES = Object.freeze([
  'modeling',
  'advanced-modeling',
  'input',
  'advanced',
  'analysis'
]);

const VALID_WINDOW_MANAGE_ACTIONS = Object.freeze([
  'list',
  'switch-module',
  'activate-document',
  'create-document',
  'close-document',
  'open-task-center',
  'close-task-center',
  'set-layout',
  'focus-window'
]);

const VALID_LAYOUT_MODES = Object.freeze([
  'single',
  'tiled',
  'free'
]);

const VALID_OPEN_FILE_TARGETS = Object.freeze([
  'auto',
  'modeling',
  'analysis'
]);

function registerWindowAndFileTools(registry, { dispatchToHost }) {
  if (typeof dispatchToHost !== 'function') {
    throw new Error('registerWindowAndFileTools requires a dispatchToHost function');
  }

  registry.registerTool({
    name: 'ester_window_manage',
    description: 'Manage Ester Studio workbench windows, modules, document tabs, Task Center visibility, and multi-document viewport layouts in real time.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...VALID_WINDOW_MANAGE_ACTIONS],
          description: 'Window/workbench management operation to perform.'
        },
        module: {
          type: 'string',
          enum: [...VALID_WORKSPACE_MODULES],
          description: 'Target workbench module (required for switch-module; optional for create-document or activate-document).'
        },
        documentId: {
          type: 'string',
          description: 'Target document ID (or label fallback) for activate-document / close-document.'
        },
        label: {
          type: 'string',
          description: 'Custom tab label when creating a document, or target tab label when activating/closing a document.'
        },
        discardUnsaved: {
          type: 'boolean',
          description: 'When closing a document with unsaved modifications, set true to force discard changes (default: false).'
        },
        layout: {
          type: 'string',
          enum: [...VALID_LAYOUT_MODES],
          description: 'Viewport deck layout mode when action is set-layout (single, tiled, or free).'
        },
        arrange: {
          type: 'boolean',
          description: 'When action is set-layout, set true to re-arrange multi-document viewports.'
        },
        windowId: {
          type: 'integer',
          description: 'Optional target Electron window ID when action is focus-window.'
        }
      },
      required: ['action'],
      additionalProperties: false
    },
    async handler(args) {
      if (typeof args.action !== 'string' || !VALID_WINDOW_MANAGE_ACTIONS.includes(args.action)) {
        throw Object.assign(
          new Error(`action must be one of: ${VALID_WINDOW_MANAGE_ACTIONS.join(', ')}`),
          { code: 'INVALID_WINDOW_ACTION' }
        );
      }
      if (args.module !== undefined && (typeof args.module !== 'string' || !VALID_WORKSPACE_MODULES.includes(args.module))) {
        throw Object.assign(
          new Error(`module must be one of: ${VALID_WORKSPACE_MODULES.join(', ')}`),
          { code: 'INVALID_MODULE' }
        );
      }
      if (args.action === 'switch-module' && !args.module) {
        throw Object.assign(
          new Error('module is required when action is "switch-module"'),
          { code: 'MISSING_MODULE' }
        );
      }
      if (args.documentId !== undefined && (typeof args.documentId !== 'string' || !args.documentId.trim())) {
        throw Object.assign(
          new Error('documentId must be a non-empty string'),
          { code: 'INVALID_DOCUMENT_ID' }
        );
      }
      if (args.label !== undefined && (typeof args.label !== 'string' || !args.label.trim() || args.label.length > 120)) {
        throw Object.assign(
          new Error('label must be a non-empty string up to 120 characters'),
          { code: 'INVALID_DOCUMENT_LABEL' }
        );
      }
      if (args.action === 'activate-document' && !args.documentId && !args.label) {
        throw Object.assign(
          new Error('documentId or label is required when action is "activate-document"'),
          { code: 'MISSING_DOCUMENT_ID' }
        );
      }
      if (args.discardUnsaved !== undefined && typeof args.discardUnsaved !== 'boolean') {
        throw Object.assign(
          new Error('discardUnsaved must be a boolean'),
          { code: 'INVALID_DISCARD_FLAG' }
        );
      }
      if (args.layout !== undefined && (typeof args.layout !== 'string' || !VALID_LAYOUT_MODES.includes(args.layout))) {
        throw Object.assign(
          new Error(`layout must be one of: ${VALID_LAYOUT_MODES.join(', ')}`),
          { code: 'INVALID_LAYOUT_MODE' }
        );
      }
      if (args.arrange !== undefined && typeof args.arrange !== 'boolean') {
        throw Object.assign(
          new Error('arrange must be a boolean'),
          { code: 'INVALID_ARRANGE_FLAG' }
        );
      }
      if (args.action === 'set-layout' && args.layout === undefined && args.arrange !== true) {
        throw Object.assign(
          new Error('set-layout requires layout ("single" | "tiled" | "free") or arrange: true'),
          { code: 'INVALID_LAYOUT_OPTIONS' }
        );
      }
      if (args.windowId !== undefined && (!Number.isInteger(args.windowId) || args.windowId <= 0)) {
        throw Object.assign(
          new Error('windowId must be a positive integer'),
          { code: 'INVALID_WINDOW_ID' }
        );
      }

      const result = await dispatchToHost('window-manage', {
        action: args.action,
        ...(args.module !== undefined ? { module: args.module } : {}),
        ...(args.documentId !== undefined ? { documentId: args.documentId.trim() } : {}),
        ...(args.label !== undefined ? { label: args.label.trim() } : {}),
        ...(args.discardUnsaved !== undefined ? { discardUnsaved: args.discardUnsaved } : {}),
        ...(args.layout !== undefined ? { layout: args.layout } : {}),
        ...(args.arrange !== undefined ? { arrange: args.arrange } : {}),
        ...(args.windowId !== undefined ? { windowId: args.windowId } : {})
      });
      return {
        ok: true,
        ...result
      };
    }
  });

  registry.registerTool({
    name: 'ester_open_file',
    description: 'Import a local molecular/crystal structure or quantum calculation output file (.xyz, .pdb, .mol, .sdf, .cif, .poscar, .gjf, .inp, .fchk, .molden, .log, .out) into the active Ester Studio workbench without blocking on modal dialogs.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the local file to import into Ester Studio.'
        },
        target: {
          type: 'string',
          enum: [...VALID_OPEN_FILE_TARGETS],
          description: 'Where to open the file: "modeling" (editable structure), "analysis" (postprocess output/wavefunction), or "auto" (default, automatically routes by file type).'
        },
        label: {
          type: 'string',
          description: 'Optional custom tab label for the imported document.'
        }
      },
      required: ['path'],
      additionalProperties: false
    },
    async handler(args) {
      if (typeof args.path !== 'string' || !args.path.trim()) {
        throw Object.assign(
          new Error('path must be a non-empty string'),
          { code: 'INVALID_FILE_PATH' }
        );
      }
      if (args.target !== undefined && (typeof args.target !== 'string' || !VALID_OPEN_FILE_TARGETS.includes(args.target))) {
        throw Object.assign(
          new Error(`target must be one of: ${VALID_OPEN_FILE_TARGETS.join(', ')}`),
          { code: 'INVALID_OPEN_TARGET' }
        );
      }
      if (args.label !== undefined && (typeof args.label !== 'string' || !args.label.trim() || args.label.length > 120)) {
        throw Object.assign(
          new Error('label must be a non-empty string up to 120 characters'),
          { code: 'INVALID_DOCUMENT_LABEL' }
        );
      }

      const result = await dispatchToHost('open-file', {
        path: args.path.trim(),
        target: args.target ?? 'auto',
        ...(args.label !== undefined ? { label: args.label.trim() } : {})
      });
      return {
        ok: true,
        ...result
      };
    }
  });
}

function createMcpProtocolProcessor({ registry, serverName = 'ester-studio-mcp', serverVersion = '2.0.2' }) {
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
              listChanged: false
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
        return jsonRpcSuccess(id, {
          tools: registry.listTools()
        });
      }

      if (method === 'tools/call') {
        if (!isPlainObject(params) || typeof params.name !== 'string' || !params.name) {
          return jsonRpcError(id, -32602, 'tools/call requires params.name');
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
  VALID_WORKSPACE_MODULES,
  VALID_WINDOW_MANAGE_ACTIONS,
  VALID_LAYOUT_MODES,
  VALID_OPEN_FILE_TARGETS,
  isPlainObject,
  formatToolResult,
  jsonRpcSuccess,
  jsonRpcError,
  createMcpToolRegistry,
  registerFoundationTools,
  registerWindowAndFileTools,
  createMcpProtocolProcessor
};
