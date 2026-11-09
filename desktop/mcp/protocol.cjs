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

const VALID_CAMERA_PRESETS = Object.freeze([
  'principal-inertia',
  'X',
  'Y',
  'Z',
  'a',
  'a*',
  'b',
  'b*',
  'c',
  'c*'
]);

const VALID_ROTATE_STEPS = Object.freeze([
  'left',
  'right',
  'up',
  'down'
]);

const VALID_DISPLAY_STYLES = Object.freeze([
  'ball-stick',
  'stick',
  'vdw'
]);

const ALLOWED_DISPLAY_KEYS = Object.freeze([
  'style',
  'showAtomIndices',
  'showElementLabels',
  'showBondLengths',
  'showFrozenMarks',
  'showCell',
  'showAxes'
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

function registerViewportAndVisionTools(registry, { dispatchToHost }) {
  if (typeof dispatchToHost !== 'function') {
    throw new Error('registerViewportAndVisionTools requires a dispatchToHost function');
  }

  registry.registerTool({
    name: 'ester_viewport_camera',
    description: 'Control the 3D molecular/crystal viewport camera orientation, rotation, zoom, and display overlays (atom indices, element labels, measurement marks, frozen marks, unit cell box, coordinate axes, representation style) in real time.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          description: 'Optional target document ID (or label fallback). Defaults to the active document.'
        },
        windowId: {
          type: 'integer',
          description: 'Optional target Electron window ID.'
        },
        preset: {
          type: 'string',
          enum: [...VALID_CAMERA_PRESETS],
          description: 'Orient camera to a standard Cartesian axis (X, Y, Z), principal inertia axes (principal-inertia), or crystal cell axis (a, a*, b, b*, c, c*).'
        },
        rotateStep: {
          type: 'string',
          enum: [...VALID_ROTATE_STEPS],
          description: 'Rotate camera by a 45-degree step around the structure pivot (left, right, up, or down).'
        },
        rotateDelta: {
          type: 'object',
          properties: {
            dx: {
              type: 'number',
              description: 'Horizontal rotation delta around the structure pivot.'
            },
            dy: {
              type: 'number',
              description: 'Vertical rotation delta around the structure pivot.'
            }
          },
          required: ['dx', 'dy'],
          additionalProperties: false,
          description: 'Continuous camera rotation delta (dx, dy) around the structure pivot.'
        },
        zoom: {
          type: 'number',
          description: 'Positive zoom multiplier (e.g. 1.25 to zoom in, 0.8 to zoom out).'
        },
        resetView: {
          type: 'boolean',
          description: 'When true, reset camera view to the default initial orientation centered on the structure pivot before applying other camera transforms.'
        },
        display: {
          type: 'object',
          properties: {
            style: {
              type: 'string',
              enum: [...VALID_DISPLAY_STYLES],
              description: 'Molecular representation style (ball-stick, stick, or vdw).'
            },
            showAtomIndices: {
              type: 'boolean',
              description: 'Show or hide 1-based atom serial index labels in the 3D viewport.'
            },
            showElementLabels: {
              type: 'boolean',
              description: 'Show or hide element symbol labels in the 3D viewport.'
            },
            showBondLengths: {
              type: 'boolean',
              description: 'Show or hide distance/angle/dihedral measurement marks in the 3D viewport.'
            },
            showFrozenMarks: {
              type: 'boolean',
              description: 'Show or hide snowflake indicators on frozen atoms.'
            },
            showCell: {
              type: 'boolean',
              description: 'Show or hide the periodic unit cell bounding box.'
            },
            showAxes: {
              type: 'boolean',
              description: 'Show or hide the 3D coordinate/cell axes indicator.'
            }
          },
          additionalProperties: false,
          description: 'Optional display toggles for the 3D viewport.'
        }
      },
      additionalProperties: false
    },
    async handler(args) {
      if (args.documentId !== undefined && (typeof args.documentId !== 'string' || !args.documentId.trim())) {
        throw Object.assign(
          new Error('documentId must be a non-empty string'),
          { code: 'INVALID_DOCUMENT_ID' }
        );
      }
      if (args.windowId !== undefined && (!Number.isInteger(args.windowId) || args.windowId <= 0)) {
        throw Object.assign(
          new Error('windowId must be a positive integer'),
          { code: 'INVALID_WINDOW_ID' }
        );
      }
      if (args.preset !== undefined && (typeof args.preset !== 'string' || !VALID_CAMERA_PRESETS.includes(args.preset))) {
        throw Object.assign(
          new Error(`preset must be one of: ${VALID_CAMERA_PRESETS.join(', ')}`),
          { code: 'INVALID_CAMERA_PRESET' }
        );
      }
      if (args.rotateStep !== undefined && (typeof args.rotateStep !== 'string' || !VALID_ROTATE_STEPS.includes(args.rotateStep))) {
        throw Object.assign(
          new Error(`rotateStep must be one of: ${VALID_ROTATE_STEPS.join(', ')}`),
          { code: 'INVALID_ROTATE_STEP' }
        );
      }
      if (args.rotateDelta !== undefined) {
        if (
          !isPlainObject(args.rotateDelta) ||
          typeof args.rotateDelta.dx !== 'number' ||
          !Number.isFinite(args.rotateDelta.dx) ||
          typeof args.rotateDelta.dy !== 'number' ||
          !Number.isFinite(args.rotateDelta.dy) ||
          Object.keys(args.rotateDelta).some(key => key !== 'dx' && key !== 'dy')
        ) {
          throw Object.assign(
            new Error('rotateDelta must be an object with finite numeric dx and dy fields'),
            { code: 'INVALID_ROTATE_DELTA' }
          );
        }
      }
      if (args.zoom !== undefined && (typeof args.zoom !== 'number' || !Number.isFinite(args.zoom) || args.zoom <= 0 || args.zoom > 100)) {
        throw Object.assign(
          new Error('zoom must be a finite positive number (0 < zoom <= 100)'),
          { code: 'INVALID_CAMERA_ZOOM' }
        );
      }
      if (args.resetView !== undefined && typeof args.resetView !== 'boolean') {
        throw Object.assign(
          new Error('resetView must be a boolean'),
          { code: 'INVALID_RESET_VIEW_FLAG' }
        );
      }

      let normalizedDisplay;
      if (args.display !== undefined) {
        if (!isPlainObject(args.display)) {
          throw Object.assign(
            new Error('display must be an object'),
            { code: 'INVALID_DISPLAY_OPTIONS' }
          );
        }
        const displayKeys = Object.keys(args.display);
        for (const key of displayKeys) {
          if (!ALLOWED_DISPLAY_KEYS.includes(key)) {
            throw Object.assign(
              new Error(`Unsupported display option "${key}". Allowed: ${ALLOWED_DISPLAY_KEYS.join(', ')}`),
              { code: 'INVALID_DISPLAY_OPTIONS' }
            );
          }
          if (key === 'style') {
            if (typeof args.display.style !== 'string' || !VALID_DISPLAY_STYLES.includes(args.display.style)) {
              throw Object.assign(
                new Error(`display.style must be one of: ${VALID_DISPLAY_STYLES.join(', ')}`),
                { code: 'INVALID_DISPLAY_OPTIONS' }
              );
            }
          } else if (typeof args.display[key] !== 'boolean') {
            throw Object.assign(
              new Error(`display.${key} must be a boolean`),
              { code: 'INVALID_DISPLAY_OPTIONS' }
            );
          }
        }
        if (displayKeys.length > 0) {
          normalizedDisplay = { ...args.display };
        }
      }

      const hasCameraOp =
        args.preset !== undefined ||
        args.rotateStep !== undefined ||
        args.rotateDelta !== undefined ||
        args.zoom !== undefined ||
        args.resetView === true ||
        normalizedDisplay !== undefined;

      if (!hasCameraOp) {
        throw Object.assign(
          new Error('ester_viewport_camera requires at least one camera or display operation (preset, rotateStep, rotateDelta, zoom, resetView: true, or display)'),
          { code: 'EMPTY_CAMERA_OPERATION' }
        );
      }

      const result = await dispatchToHost('viewport-camera', {
        ...(args.documentId !== undefined ? { documentId: args.documentId.trim() } : {}),
        ...(args.windowId !== undefined ? { windowId: args.windowId } : {}),
        ...(args.preset !== undefined ? { preset: args.preset } : {}),
        ...(args.rotateStep !== undefined ? { rotateStep: args.rotateStep } : {}),
        ...(args.rotateDelta !== undefined ? { rotateDelta: { dx: args.rotateDelta.dx, dy: args.rotateDelta.dy } } : {}),
        ...(args.zoom !== undefined ? { zoom: args.zoom } : {}),
        ...(args.resetView !== undefined ? { resetView: args.resetView } : {}),
        ...(normalizedDisplay !== undefined ? { display: normalizedDisplay } : {})
      });
      return {
        ok: true,
        ...result
      };
    }
  });

  registry.registerTool({
    name: 'ester_viewport_screenshot',
    description: 'Capture a PNG screenshot of the 3D molecular/crystal viewport (with optional atom index/element/measurement annotations and optional local file output) and return a multimodal MCP image block for AI visual inspection.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          description: 'Optional target document ID (or label fallback). Defaults to the active document.'
        },
        windowId: {
          type: 'integer',
          description: 'Optional target Electron window ID.'
        },
        width: {
          type: 'integer',
          description: 'Output image width in pixels (160..4096, default: 1200).'
        },
        height: {
          type: 'integer',
          description: 'Output image height in pixels (120..4096, default: 900).'
        },
        transparent: {
          type: 'boolean',
          description: 'Render with transparent background instead of studio background (default: false).'
        },
        includeAnnotations: {
          type: 'boolean',
          description: 'Overlay atom indices, element symbols, frozen atom marks, measurements, legend, and coordinate axes (default: true).'
        },
        savePath: {
          type: 'string',
          description: 'Optional local file path to save the rendered PNG screenshot.'
        }
      },
      additionalProperties: false
    },
    async handler(args) {
      if (args.documentId !== undefined && (typeof args.documentId !== 'string' || !args.documentId.trim())) {
        throw Object.assign(
          new Error('documentId must be a non-empty string'),
          { code: 'INVALID_DOCUMENT_ID' }
        );
      }
      if (args.windowId !== undefined && (!Number.isInteger(args.windowId) || args.windowId <= 0)) {
        throw Object.assign(
          new Error('windowId must be a positive integer'),
          { code: 'INVALID_WINDOW_ID' }
        );
      }
      if (args.width !== undefined && (!Number.isInteger(args.width) || args.width < 160 || args.width > 4096)) {
        throw Object.assign(
          new Error('width must be an integer between 160 and 4096'),
          { code: 'INVALID_SCREENSHOT_DIMENSIONS' }
        );
      }
      if (args.height !== undefined && (!Number.isInteger(args.height) || args.height < 120 || args.height > 4096)) {
        throw Object.assign(
          new Error('height must be an integer between 120 and 4096'),
          { code: 'INVALID_SCREENSHOT_DIMENSIONS' }
        );
      }
      if (args.transparent !== undefined && typeof args.transparent !== 'boolean') {
        throw Object.assign(
          new Error('transparent must be a boolean'),
          { code: 'INVALID_TRANSPARENT_FLAG' }
        );
      }
      if (args.includeAnnotations !== undefined && typeof args.includeAnnotations !== 'boolean') {
        throw Object.assign(
          new Error('includeAnnotations must be a boolean'),
          { code: 'INVALID_ANNOTATIONS_FLAG' }
        );
      }
      if (args.savePath !== undefined && (typeof args.savePath !== 'string' || !args.savePath.trim())) {
        throw Object.assign(
          new Error('savePath must be a non-empty string'),
          { code: 'INVALID_SAVE_PATH' }
        );
      }

      const result = await dispatchToHost('viewport-screenshot', {
        ...(args.documentId !== undefined ? { documentId: args.documentId.trim() } : {}),
        ...(args.windowId !== undefined ? { windowId: args.windowId } : {}),
        width: args.width ?? 1200,
        height: args.height ?? 900,
        transparent: args.transparent === true,
        includeAnnotations: args.includeAnnotations !== false,
        ...(args.savePath !== undefined ? { savePath: args.savePath.trim() } : {})
      });

      const { base64Png, ...metadata } = isPlainObject(result) ? result : {};
      const mimeType = typeof metadata.mimeType === 'string' ? metadata.mimeType : 'image/png';
      const summaryPayload = {
        ok: true,
        ...metadata,
        mimeType
      };
      const imageBlocks = typeof base64Png === 'string' && base64Png.length > 0
        ? [{ data: base64Png, mimeType }]
        : [];

      return formatToolResult(summaryPayload, { imageBlocks });
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
  VALID_CAMERA_PRESETS,
  VALID_ROTATE_STEPS,
  VALID_DISPLAY_STYLES,
  isPlainObject,
  formatToolResult,
  jsonRpcSuccess,
  jsonRpcError,
  createMcpToolRegistry,
  registerFoundationTools,
  registerWindowAndFileTools,
  registerViewportAndVisionTools,
  createMcpProtocolProcessor
};
