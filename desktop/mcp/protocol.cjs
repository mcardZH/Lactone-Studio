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

const VALID_COORDINATE_TYPES = Object.freeze(['B', 'A', 'D']);

const VALID_EDIT_STRUCTURE_OPERATIONS = Object.freeze([
  'set-electronic-state',
  'select-atoms',
  'set-geometry',
  'change-element',
  'add-atom',
  'delete-atoms',
  'add-single-hydrogen',
  'set-bond-order',
  'delete-bond',
  'translate',
  'rotate',
  'center',
  'supercell',
  'vacuum',
  'wrap',
  'undo',
  'redo'
]);

const VALID_CONSTRAINT_MODES = Object.freeze(['replace', 'append', 'remove']);

const VALID_COORDINATE_ACTIONS = Object.freeze(['freeze', 'scan']);

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

function validateOneBasedAtomIndexArray(value, fieldName, { minLength = 1, maxLength = 10000, distinct = false } = {}) {
  if (!Array.isArray(value) || value.length < minLength || value.length > maxLength) {
    throw Object.assign(
      new Error(`${fieldName} must be an array of ${minLength}..${maxLength} positive 1-based atom indices`),
      { code: 'INVALID_ATOM_INDICES' }
    );
  }
  for (const item of value) {
    if (!Number.isInteger(item) || item < 1) {
      throw Object.assign(
        new Error(`${fieldName} must contain only positive 1-based integer atom indices (1..N)`),
        { code: 'INVALID_ATOM_INDICES' }
      );
    }
  }
  if (distinct && new Set(value).size !== value.length) {
    throw Object.assign(
      new Error(`${fieldName} must not contain duplicate atom indices`),
      { code: 'INVALID_ATOM_INDICES' }
    );
  }
}

function validateIntegerVector3(value, fieldName) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some(component => !Number.isInteger(component))
  ) {
    throw Object.assign(
      new Error(`${fieldName} must be an array of 3 integers [ix, iy, iz]`),
      { code: 'INVALID_VECTOR3' }
    );
  }
}

function validateFiniteVector3(value, fieldName) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some(component => typeof component !== 'number' || !Number.isFinite(component))
  ) {
    throw Object.assign(
      new Error(`${fieldName} must be an array of 3 finite numbers [x, y, z]`),
      { code: 'INVALID_VECTOR3' }
    );
  }
}

function registerStructureAndGeometryTools(registry, { dispatchToHost }) {
  if (typeof dispatchToHost !== 'function') {
    throw new Error('registerStructureAndGeometryTools requires a dispatchToHost function');
  }

  registry.registerTool({
    name: 'ester_get_structure_info',
    description: 'Inspect the complete molecular/crystal topology and geometry of a document in Ester Studio: 1-based atom table (element, Cartesian/fractional coordinates, neighbors, selection, freeze state), bond table with bond lengths (Angstrom) and bond orders, unit cell parameters, active constraints, and optional rotatable dihedral torsions.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          description: 'Target document ID or tab label (defaults to the active document).'
        },
        windowId: {
          type: 'integer',
          description: 'Optional target Electron window ID.'
        },
        includeAtoms: {
          type: 'boolean',
          description: 'Whether to include the per-atom table (default: true).'
        },
        includeBonds: {
          type: 'boolean',
          description: 'Whether to include the bond table with bond lengths (default: true).'
        },
        includeRotatableTorsions: {
          type: 'boolean',
          description: 'Whether to discover and return rotatable single-bond dihedral torsions (default: false).'
        },
        selectedOnly: {
          type: 'boolean',
          description: 'When true, filter the returned atoms and bonds to the user/AI active selection in the viewport (default: false).'
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
      for (const boolKey of ['includeAtoms', 'includeBonds', 'includeRotatableTorsions', 'selectedOnly']) {
        if (args[boolKey] !== undefined && typeof args[boolKey] !== 'boolean') {
          throw Object.assign(
            new Error(`${boolKey} must be a boolean`),
            { code: 'INVALID_STRUCTURE_INFO_OPTION' }
          );
        }
      }

      const result = await dispatchToHost('structure-info', {
        ...(args.documentId !== undefined ? { documentId: args.documentId.trim() } : {}),
        ...(args.windowId !== undefined ? { windowId: args.windowId } : {}),
        includeAtoms: args.includeAtoms !== false,
        includeBonds: args.includeBonds !== false,
        includeRotatableTorsions: args.includeRotatableTorsions === true,
        selectedOnly: args.selectedOnly === true
      });
      return {
        ok: true,
        ...result
      };
    }
  });

  registry.registerTool({
    name: 'ester_measure_geometry',
    description: 'Compute exact interatomic distances/bond lengths (B, Angstrom), 3-atom bond angles (A, degrees), 4-atom dihedral torsions (D, degrees), or inspect the local coordination shell around a center atom within a cutoff radius. Optionally selects the measured atoms in the live 3D viewport.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          description: 'Target document ID or tab label (defaults to the active document).'
        },
        windowId: {
          type: 'integer',
          description: 'Optional target Electron window ID.'
        },
        measurements: {
          type: 'array',
          description: 'List of internal coordinates to measure using 1-based atom indices (B: 2 atoms, A: 3 atoms, D: 4 atoms).',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: [...VALID_COORDINATE_TYPES],
                description: 'Coordinate type: "B" (distance/bond, 2 atoms), "A" (angle, 3 atoms), or "D" (dihedral, 4 atoms).'
              },
              atoms: {
                type: 'array',
                items: { type: 'integer' },
                description: 'Ordered 1-based atom indices (e.g. [1, 2] for B, [1, 2, 3] for A, [1, 2, 3, 4] for D).'
              }
            },
            required: ['type', 'atoms'],
            additionalProperties: false
          }
        },
        neighborShell: {
          type: 'object',
          description: 'Query all neighboring atoms within cutoffAngstrom around centerAtom (1-based) and optionally compute coordination angles.',
          properties: {
            centerAtom: {
              type: 'integer',
              description: '1-based index of the central atom.'
            },
            cutoffAngstrom: {
              type: 'number',
              description: 'Cutoff distance in Angstrom (0 < cutoff <= 20, default: 3.0).'
            },
            includeAngles: {
              type: 'boolean',
              description: 'Whether to compute neighbor-center-neighbor angles (default: true).'
            }
          },
          required: ['centerAtom'],
          additionalProperties: false
        },
        selectMeasuredAtoms: {
          type: 'boolean',
          description: 'When true, highlights/selects the measured atoms in the frontend 3D viewport (default: false).'
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
      if (args.selectMeasuredAtoms !== undefined && typeof args.selectMeasuredAtoms !== 'boolean') {
        throw Object.assign(
          new Error('selectMeasuredAtoms must be a boolean'),
          { code: 'INVALID_MEASURE_OPTION' }
        );
      }

      const hasMeasurements = Array.isArray(args.measurements) && args.measurements.length > 0;
      const hasNeighborShell = args.neighborShell !== undefined;
      if (!hasMeasurements && !hasNeighborShell) {
        throw Object.assign(
          new Error('ester_measure_geometry requires a non-empty measurements array or neighborShell object'),
          { code: 'MISSING_MEASUREMENT_QUERY' }
        );
      }

      if (args.measurements !== undefined) {
        if (!Array.isArray(args.measurements) || args.measurements.length > 500) {
          throw Object.assign(
            new Error('measurements must be an array of up to 500 items'),
            { code: 'INVALID_MEASUREMENT_SPEC' }
          );
        }
        for (const item of args.measurements) {
          if (!isPlainObject(item) || typeof item.type !== 'string' || !VALID_COORDINATE_TYPES.includes(item.type)) {
            throw Object.assign(
              new Error('Each measurement requires type ("B", "A", or "D")'),
              { code: 'INVALID_MEASUREMENT_SPEC' }
            );
          }
          const expectedCount = item.type === 'B' ? 2 : item.type === 'A' ? 3 : 4;
          validateOneBasedAtomIndexArray(item.atoms, `measurements[${item.type}].atoms`, {
            minLength: expectedCount,
            maxLength: expectedCount
          });
          if (new Set(item.atoms).size !== expectedCount) {
            throw Object.assign(
              new Error(`Measurement ${item.type} requires ${expectedCount} distinct 1-based atom indices`),
              { code: 'INVALID_MEASUREMENT_SPEC' }
            );
          }
        }
      }

      if (args.neighborShell !== undefined) {
        if (!isPlainObject(args.neighborShell)) {
          throw Object.assign(
            new Error('neighborShell must be an object'),
            { code: 'INVALID_NEIGHBOR_SHELL' }
          );
        }
        if (!Number.isInteger(args.neighborShell.centerAtom) || args.neighborShell.centerAtom < 1) {
          throw Object.assign(
            new Error('neighborShell.centerAtom must be a positive 1-based integer'),
            { code: 'INVALID_NEIGHBOR_SHELL' }
          );
        }
        if (
          args.neighborShell.cutoffAngstrom !== undefined &&
          (typeof args.neighborShell.cutoffAngstrom !== 'number' ||
            !Number.isFinite(args.neighborShell.cutoffAngstrom) ||
            args.neighborShell.cutoffAngstrom <= 0 ||
            args.neighborShell.cutoffAngstrom > 20)
        ) {
          throw Object.assign(
            new Error('neighborShell.cutoffAngstrom must be a finite number in (0, 20]'),
            { code: 'INVALID_NEIGHBOR_SHELL' }
          );
        }
        if (args.neighborShell.includeAngles !== undefined && typeof args.neighborShell.includeAngles !== 'boolean') {
          throw Object.assign(
            new Error('neighborShell.includeAngles must be a boolean'),
            { code: 'INVALID_NEIGHBOR_SHELL' }
          );
        }
      }

      const result = await dispatchToHost('measure-geometry', {
        ...(args.documentId !== undefined ? { documentId: args.documentId.trim() } : {}),
        ...(args.windowId !== undefined ? { windowId: args.windowId } : {}),
        ...(hasMeasurements ? { measurements: args.measurements } : {}),
        ...(hasNeighborShell ? { neighborShell: args.neighborShell } : {}),
        selectMeasuredAtoms: args.selectMeasuredAtoms === true
      });
      return {
        ok: true,
        ...result
      };
    }
  });

  registry.registerTool({
    name: 'ester_edit_structure',
    description: 'Edit the molecular or periodic crystal structure in the live Ester Studio workbench (set charge/multiplicity, select atoms, adjust bond length/angle/dihedral, change element, add/delete atoms or hydrogens, modify bond order, translate/rotate/center, build supercell/vacuum/wrap, or undo/redo) with full Undo/Redo history synchronization.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          description: 'Target document ID or tab label (defaults to the active document).'
        },
        windowId: {
          type: 'integer',
          description: 'Optional target Electron window ID.'
        },
        operation: {
          type: 'string',
          enum: [...VALID_EDIT_STRUCTURE_OPERATIONS],
          description: 'Structure editing operation to execute.'
        },
        charge: {
          type: 'integer',
          description: 'Total charge (for set-electronic-state).'
        },
        multiplicity: {
          type: 'integer',
          description: 'Spin multiplicity >= 1 (for set-electronic-state).'
        },
        confirmed: {
          type: 'boolean',
          description: 'Whether the electronic state is confirmed (for set-electronic-state, default: true).'
        },
        atoms: {
          type: 'array',
          items: { type: 'integer' },
          description: '1-based atom indices targeted by select-atoms, set-geometry, change-element, delete-atoms, add-single-hydrogen, set-bond-order, delete-bond, translate, rotate, or center.'
        },
        coordinate: {
          type: 'string',
          enum: [...VALID_COORDINATE_TYPES],
          description: 'Internal coordinate kind ("B", "A", or "D") when operation is "set-geometry".'
        },
        value: {
          type: 'number',
          description: 'Target internal coordinate value (Angstrom for B, degrees for A/D) when operation is "set-geometry".'
        },
        fixedSide: {
          type: 'string',
          enum: ['first', 'last'],
          description: 'Which end of the internal coordinate stays fixed during "set-geometry" (default: "first").'
        },
        moving: {
          type: 'string',
          enum: ['branch', 'selected', 'atom'],
          description: 'Which atoms move during "set-geometry" ("branch", "selected", or "atom"; default: "branch").'
        },
        movingAtoms: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Explicit 1-based moving atom indices when moving is "selected" during "set-geometry".'
        },
        element: {
          type: 'string',
          description: 'Chemical element symbol (e.g. "C", "N", "O", "Fe") for change-element or add-atom.'
        },
        position: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description: 'Cartesian coordinates [x, y, z] in Angstrom for add-atom.'
        },
        anchorAtom: {
          type: 'integer',
          description: 'Optional 1-based anchor atom index to bond the newly added atom to in add-atom.'
        },
        order: {
          type: 'number',
          enum: [0.5, 1, 1.5, 2, 3],
          description: 'Bond order (0.5, 1, 1.5, 2, or 3) for set-bond-order.'
        },
        image: {
          type: 'array',
          items: { type: 'integer' },
          minItems: 3,
          maxItems: 3,
          description: 'Optional periodic lattice image translation [ix, iy, iz] for cross-cell bonds in set-bond-order or delete-bond.'
        },
        delta: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description: 'Translation vector [dx, dy, dz] in Angstrom for translate.'
        },
        axis: {
          description: 'Rotation axis ("x", "y", "z" or [ux, uy, uz]) for rotate, or crystal axis (0, 1, 2 or "a", "b", "c") for vacuum.'
        },
        degrees: {
          type: 'number',
          description: 'Rotation angle in degrees for rotate.'
        },
        pivot: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description: 'Optional rotation pivot [x, y, z] in Angstrom for rotate.'
        },
        centerMode: {
          type: 'string',
          enum: ['geometry', 'mass'],
          description: 'Centering mode ("geometry" or "mass", default: "geometry") for center.'
        },
        target: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description: 'Optional target Cartesian center [x, y, z] for center (default: [0, 0, 0]).'
        },
        repeat: {
          type: 'array',
          items: { type: 'integer' },
          minItems: 3,
          maxItems: 3,
          description: 'Supercell repetition counts [na, nb, nc] (positive integers) for supercell.'
        },
        vacuumAngstrom: {
          type: 'number',
          description: 'Vacuum thickness in Angstrom (>= 0) for vacuum.'
        },
        centerSlab: {
          type: 'boolean',
          description: 'Whether to center the slab along the vacuum axis (default: true) for vacuum.'
        }
      },
      required: ['operation'],
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
      if (typeof args.operation !== 'string' || !VALID_EDIT_STRUCTURE_OPERATIONS.includes(args.operation)) {
        throw Object.assign(
          new Error(`operation must be one of: ${VALID_EDIT_STRUCTURE_OPERATIONS.join(', ')}`),
          { code: 'INVALID_EDIT_OPERATION' }
        );
      }

      const op = args.operation;
      if (op === 'set-electronic-state') {
        if (!Number.isInteger(args.charge) || !Number.isInteger(args.multiplicity) || args.multiplicity < 1) {
          throw Object.assign(
            new Error('set-electronic-state requires integer charge and integer multiplicity >= 1'),
            { code: 'INVALID_ELECTRONIC_STATE' }
          );
        }
        if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') {
          throw Object.assign(
            new Error('confirmed must be a boolean'),
            { code: 'INVALID_ELECTRONIC_STATE' }
          );
        }
      } else if (op === 'select-atoms') {
        validateOneBasedAtomIndexArray(args.atoms, 'atoms', { minLength: 0, distinct: true });
      } else if (op === 'set-geometry') {
        const coord = args.coordinate ?? (Array.isArray(args.atoms) ? ({ 2: 'B', 3: 'A', 4: 'D' }[args.atoms.length]) : undefined);
        if (typeof coord !== 'string' || !VALID_COORDINATE_TYPES.includes(coord)) {
          throw Object.assign(
            new Error('set-geometry requires coordinate ("B", "A", or "D") and matching atoms array'),
            { code: 'INVALID_GEOMETRY_EDIT' }
          );
        }
        const expectedCount = coord === 'B' ? 2 : coord === 'A' ? 3 : 4;
        validateOneBasedAtomIndexArray(args.atoms, 'atoms', { minLength: expectedCount, maxLength: expectedCount });
        if (new Set(args.atoms).size !== expectedCount) {
          throw Object.assign(
            new Error(`set-geometry (${coord}) requires ${expectedCount} distinct 1-based atom indices`),
            { code: 'INVALID_GEOMETRY_EDIT' }
          );
        }
        if (typeof args.value !== 'number' || !Number.isFinite(args.value)) {
          throw Object.assign(
            new Error('set-geometry requires a finite numeric value'),
            { code: 'INVALID_GEOMETRY_EDIT' }
          );
        }
        if (coord === 'B' && args.value <= 0) {
          throw Object.assign(
            new Error('Bond length (B) value must be > 0 Angstrom'),
            { code: 'INVALID_GEOMETRY_EDIT' }
          );
        }
        if (coord === 'A' && (args.value <= 0 || args.value >= 180)) {
          throw Object.assign(
            new Error('Bond angle (A) value must be strictly between 0 and 180 degrees'),
            { code: 'INVALID_GEOMETRY_EDIT' }
          );
        }
        if (args.fixedSide !== undefined && args.fixedSide !== 'first' && args.fixedSide !== 'last') {
          throw Object.assign(
            new Error('fixedSide must be "first" or "last"'),
            { code: 'INVALID_GEOMETRY_EDIT' }
          );
        }
        if (args.moving !== undefined && !['branch', 'selected', 'atom'].includes(args.moving)) {
          throw Object.assign(
            new Error('moving must be "branch", "selected", or "atom"'),
            { code: 'INVALID_GEOMETRY_EDIT' }
          );
        }
        if (args.movingAtoms !== undefined) {
          validateOneBasedAtomIndexArray(args.movingAtoms, 'movingAtoms', { minLength: 1, distinct: true });
        }
      } else if (op === 'change-element') {
        validateOneBasedAtomIndexArray(args.atoms, 'atoms', { minLength: 1, distinct: true });
        if (typeof args.element !== 'string' || !args.element.trim()) {
          throw Object.assign(
            new Error('change-element requires a non-empty element symbol'),
            { code: 'INVALID_ELEMENT' }
          );
        }
      } else if (op === 'add-atom') {
        if (typeof args.element !== 'string' || !args.element.trim()) {
          throw Object.assign(
            new Error('add-atom requires a non-empty element symbol'),
            { code: 'INVALID_ELEMENT' }
          );
        }
        validateFiniteVector3(args.position, 'position');
        if (args.anchorAtom !== undefined && (!Number.isInteger(args.anchorAtom) || args.anchorAtom < 1)) {
          throw Object.assign(
            new Error('anchorAtom must be a positive 1-based atom index'),
            { code: 'INVALID_ATOM_INDICES' }
          );
        }
      } else if (op === 'delete-atoms' || op === 'add-single-hydrogen') {
        validateOneBasedAtomIndexArray(args.atoms, 'atoms', { minLength: 1, distinct: true });
      } else if (op === 'set-bond-order') {
        validateOneBasedAtomIndexArray(args.atoms, 'atoms', { minLength: 2, maxLength: 2 });
        if (args.image !== undefined) {
          validateIntegerVector3(args.image, 'image');
        }
        if (args.atoms[0] === args.atoms[1] && (!args.image || args.image.every(v => v === 0))) {
          throw Object.assign(
            new Error('set-bond-order requires 2 distinct atom indices unless a non-zero periodic image is provided'),
            { code: 'INVALID_ATOM_INDICES' }
          );
        }
        if (![0.5, 1, 1.5, 2, 3].includes(args.order)) {
          throw Object.assign(
            new Error('set-bond-order requires order to be one of: 0.5, 1, 1.5, 2, 3'),
            { code: 'INVALID_BOND_ORDER' }
          );
        }
      } else if (op === 'delete-bond') {
        validateOneBasedAtomIndexArray(args.atoms, 'atoms', { minLength: 2, maxLength: 2 });
        if (args.image !== undefined) {
          validateIntegerVector3(args.image, 'image');
        }
        if (args.atoms[0] === args.atoms[1] && (!args.image || args.image.every(v => v === 0))) {
          throw Object.assign(
            new Error('delete-bond requires 2 distinct atom indices unless a non-zero periodic image is provided'),
            { code: 'INVALID_ATOM_INDICES' }
          );
        }
      } else if (op === 'translate') {
        validateFiniteVector3(args.delta, 'delta');
        if (args.atoms !== undefined) {
          validateOneBasedAtomIndexArray(args.atoms, 'atoms', { minLength: 1, distinct: true });
        }
      } else if (op === 'rotate') {
        if (typeof args.degrees !== 'number' || !Number.isFinite(args.degrees)) {
          throw Object.assign(
            new Error('rotate requires a finite numeric degrees angle'),
            { code: 'INVALID_ROTATION_OPTIONS' }
          );
        }
        if (
          args.axis !== 'x' &&
          args.axis !== 'y' &&
          args.axis !== 'z' &&
          !(Array.isArray(args.axis) && args.axis.length === 3 && args.axis.every(v => typeof v === 'number' && Number.isFinite(v)))
        ) {
          throw Object.assign(
            new Error('rotate requires axis to be "x", "y", "z", or a 3-number vector [ux, uy, uz]'),
            { code: 'INVALID_ROTATION_OPTIONS' }
          );
        }
        if (Array.isArray(args.axis) && Math.hypot(args.axis[0], args.axis[1], args.axis[2]) < 1e-12) {
          throw Object.assign(
            new Error('rotate axis vector cannot be the zero vector [0, 0, 0]'),
            { code: 'INVALID_ROTATION_OPTIONS' }
          );
        }
        if (args.pivot !== undefined) {
          validateFiniteVector3(args.pivot, 'pivot');
        }
        if (args.atoms !== undefined) {
          validateOneBasedAtomIndexArray(args.atoms, 'atoms', { minLength: 1, distinct: true });
        }
      } else if (op === 'center') {
        if (args.centerMode !== undefined && args.centerMode !== 'geometry' && args.centerMode !== 'mass') {
          throw Object.assign(
            new Error('centerMode must be "geometry" or "mass"'),
            { code: 'INVALID_CENTER_OPTIONS' }
          );
        }
        if (args.target !== undefined) {
          validateFiniteVector3(args.target, 'target');
        }
        if (args.atoms !== undefined) {
          validateOneBasedAtomIndexArray(args.atoms, 'atoms', { minLength: 1, distinct: true });
        }
      } else if (op === 'supercell') {
        if (
          !Array.isArray(args.repeat) ||
          args.repeat.length !== 3 ||
          args.repeat.some(n => !Number.isInteger(n) || n < 1 || n > 20)
        ) {
          throw Object.assign(
            new Error('supercell requires repeat: [na, nb, nc] with integers in 1..20'),
            { code: 'INVALID_SUPERCELL_REPEAT' }
          );
        }
      } else if (op === 'vacuum') {
        if (
          typeof args.vacuumAngstrom !== 'number' ||
          !Number.isFinite(args.vacuumAngstrom) ||
          args.vacuumAngstrom < 0 ||
          args.vacuumAngstrom > 500
        ) {
          throw Object.assign(
            new Error('vacuum requires vacuumAngstrom in [0, 500]'),
            { code: 'INVALID_VACUUM_OPTIONS' }
          );
        }
        if (
          args.axis !== undefined &&
          ![0, 1, 2, 'a', 'b', 'c', 'x', 'y', 'z'].includes(args.axis)
        ) {
          throw Object.assign(
            new Error('vacuum axis must be 0, 1, 2 or "a", "b", "c"'),
            { code: 'INVALID_VACUUM_OPTIONS' }
          );
        }
      }

      const { windowId, documentId, ...editParams } = args;
      const result = await dispatchToHost('edit-structure', {
        ...(documentId !== undefined ? { documentId: documentId.trim() } : {}),
        ...(windowId !== undefined ? { windowId } : {}),
        ...editParams
      });
      return {
        ok: true,
        ...result
      };
    }
  });

  registry.registerTool({
    name: 'ester_set_constraints',
    description: 'Configure or clear frozen Cartesian atoms and frozen/scanned redundant internal coordinates (bond lengths B, bond angles A, dihedral angles D) on a document in Ester Studio, synchronizing immediately with the 3D viewport and calculation input forms.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          description: 'Target document ID or tab label (defaults to the active document).'
        },
        windowId: {
          type: 'integer',
          description: 'Optional target Electron window ID.'
        },
        frozenAtoms: {
          type: 'array',
          items: { type: 'integer' },
          description: '1-based atom indices to freeze (or unfreeze when mode is "remove").'
        },
        freezeSelected: {
          type: 'boolean',
          description: 'When true, includes the atoms currently selected in the 3D viewport in the freeze update.'
        },
        mode: {
          type: 'string',
          enum: [...VALID_CONSTRAINT_MODES],
          description: 'How to apply frozenAtoms/freezeSelected: "replace" (default), "append", or "remove".'
        },
        clearFrozenAtoms: {
          type: 'boolean',
          description: 'When true, unfreezes all Cartesian frozen atoms.'
        },
        enabled: {
          type: 'boolean',
          description: 'Master switch for shared document freezes (default: true).'
        },
        coordinates: {
          type: 'array',
          description: 'Internal coordinate constraints (freeze) or relaxed potential energy surface scans (scan).',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: [...VALID_COORDINATE_TYPES],
                description: 'Coordinate type: "B" (2 atoms), "A" (3 atoms), or "D" (4 atoms).'
              },
              atoms: {
                type: 'array',
                items: { type: 'integer' },
                description: 'Ordered 1-based atom indices.'
              },
              action: {
                type: 'string',
                enum: [...VALID_COORDINATE_ACTIONS],
                description: '"freeze" to hold the coordinate fixed, or "scan" for a relaxed PES scan.'
              },
              steps: {
                type: 'integer',
                description: 'Number of scan steps (>= 1, required when action is "scan").'
              },
              increment: {
                type: 'number',
                description: 'Step size per scan step in Angstrom (B) or degrees (A/D) (non-zero, required when action is "scan").'
              },
              value: {
                type: 'number',
                description: 'Optional explicit target value for ORCA internal coordinate freeze.'
              }
            },
            required: ['type', 'atoms', 'action'],
            additionalProperties: false
          }
        },
        coordinateMode: {
          type: 'string',
          enum: ['replace', 'append'],
          description: 'How to apply coordinates: "replace" (default) or "append".'
        },
        clearCoordinates: {
          type: 'boolean',
          description: 'When true, clears all internal coordinate freezes and scan definitions.'
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
      if (args.frozenAtoms !== undefined) {
        validateOneBasedAtomIndexArray(args.frozenAtoms, 'frozenAtoms', { minLength: 0, distinct: true });
      }
      if (args.freezeSelected !== undefined && typeof args.freezeSelected !== 'boolean') {
        throw Object.assign(
          new Error('freezeSelected must be a boolean'),
          { code: 'INVALID_CONSTRAINT_OPTION' }
        );
      }
      if (args.mode !== undefined && !VALID_CONSTRAINT_MODES.includes(args.mode)) {
        throw Object.assign(
          new Error(`mode must be one of: ${VALID_CONSTRAINT_MODES.join(', ')}`),
          { code: 'INVALID_CONSTRAINT_OPTION' }
        );
      }
      if (args.clearFrozenAtoms !== undefined && typeof args.clearFrozenAtoms !== 'boolean') {
        throw Object.assign(
          new Error('clearFrozenAtoms must be a boolean'),
          { code: 'INVALID_CONSTRAINT_OPTION' }
        );
      }
      if (args.enabled !== undefined && typeof args.enabled !== 'boolean') {
        throw Object.assign(
          new Error('enabled must be a boolean'),
          { code: 'INVALID_CONSTRAINT_OPTION' }
        );
      }
      if (args.coordinateMode !== undefined && args.coordinateMode !== 'replace' && args.coordinateMode !== 'append') {
        throw Object.assign(
          new Error('coordinateMode must be "replace" or "append"'),
          { code: 'INVALID_CONSTRAINT_OPTION' }
        );
      }
      if (args.clearCoordinates !== undefined && typeof args.clearCoordinates !== 'boolean') {
        throw Object.assign(
          new Error('clearCoordinates must be a boolean'),
          { code: 'INVALID_CONSTRAINT_OPTION' }
        );
      }

      if (args.coordinates !== undefined) {
        if (!Array.isArray(args.coordinates) || args.coordinates.length > 200) {
          throw Object.assign(
            new Error('coordinates must be an array of up to 200 items'),
            { code: 'INVALID_COORDINATE_CONSTRAINT' }
          );
        }
        for (const item of args.coordinates) {
          if (!isPlainObject(item) || typeof item.type !== 'string' || !VALID_COORDINATE_TYPES.includes(item.type)) {
            throw Object.assign(
              new Error('Each coordinate constraint requires type ("B", "A", or "D")'),
              { code: 'INVALID_COORDINATE_CONSTRAINT' }
            );
          }
          const expectedCount = item.type === 'B' ? 2 : item.type === 'A' ? 3 : 4;
          validateOneBasedAtomIndexArray(item.atoms, `coordinates[${item.type}].atoms`, {
            minLength: expectedCount,
            maxLength: expectedCount
          });
          if (new Set(item.atoms).size !== expectedCount) {
            throw Object.assign(
              new Error(`Coordinate ${item.type} requires ${expectedCount} distinct 1-based atom indices`),
              { code: 'INVALID_COORDINATE_CONSTRAINT' }
            );
          }
          if (typeof item.action !== 'string' || !VALID_COORDINATE_ACTIONS.includes(item.action)) {
            throw Object.assign(
              new Error('Coordinate action must be "freeze" or "scan"'),
              { code: 'INVALID_COORDINATE_CONSTRAINT' }
            );
          }
          if (item.action === 'scan') {
            if (!Number.isInteger(item.steps) || item.steps < 1 || item.steps > 10000) {
              throw Object.assign(
                new Error('Scan coordinate requires integer steps in 1..10000'),
                { code: 'INVALID_COORDINATE_CONSTRAINT' }
              );
            }
            if (typeof item.increment !== 'number' || !Number.isFinite(item.increment) || item.increment === 0) {
              throw Object.assign(
                new Error('Scan coordinate requires a non-zero finite increment'),
                { code: 'INVALID_COORDINATE_CONSTRAINT' }
              );
            }
          } else if (item.value !== undefined) {
            if (typeof item.value !== 'number' || !Number.isFinite(item.value)) {
              throw Object.assign(
                new Error('Freeze coordinate target value must be a finite number'),
                { code: 'INVALID_COORDINATE_CONSTRAINT' }
              );
            }
            if (item.type === 'B' && item.value <= 0) {
              throw Object.assign(
                new Error('Freeze bond length target value must be > 0'),
                { code: 'INVALID_COORDINATE_CONSTRAINT' }
              );
            }
            if (item.type === 'A' && (item.value <= 0 || item.value >= 180)) {
              throw Object.assign(
                new Error('Freeze bond angle target value must be in (0, 180)'),
                { code: 'INVALID_COORDINATE_CONSTRAINT' }
              );
            }
          }
        }
      }

      const { windowId, documentId, ...constraintParams } = args;
      const result = await dispatchToHost('set-constraints', {
        ...(documentId !== undefined ? { documentId: documentId.trim() } : {}),
        ...(windowId !== undefined ? { windowId } : {}),
        ...constraintParams
      });
      return {
        ok: true,
        ...result
      };
    }
  });
}

const VALID_CALCULATION_ENGINES = Object.freeze(['gaussian', 'orca']);
const VALID_RECOMMEND_ENGINES = Object.freeze(['gaussian', 'orca', 'both']);
const VALID_CALCULATION_TASKS = Object.freeze([
  'sp',
  'opt',
  'freq',
  'optfreq',
  'scan',
  'constrained',
  'ts',
  'irc',
  'td',
  'tdopt',
  't1opt',
  'nmr',
  'stable',
  'bsse',
  'neb',
  'esd',
  'md'
]);

function registerInputConfigTools(registry, { dispatchToHost }) {
  if (typeof dispatchToHost !== 'function') {
    throw new Error('registerInputConfigTools requires a dispatchToHost(action, payload) function');
  }

  registry.registerTool({
    name: 'ester_recommend_method',
    description:
      'Recommend verified quantum chemistry methods, dispersion corrections, basis sets, and built-in solvent entries for a molecular document based on its elemental composition, charge/multiplicity parity, periodicity, and target calculation task (Gaussian and/or ORCA). Automatically checks heavy-element ECP requirements and basis element coverage.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          description: 'Target document ID or label. Defaults to the currently active document.'
        },
        engine: {
          type: 'string',
          enum: VALID_RECOMMEND_ENGINES,
          description: 'Target quantum chemistry engine ("gaussian", "orca", or "both"). Defaults to "gaussian".'
        },
        task: {
          type: 'string',
          enum: VALID_CALCULATION_TASKS,
          description: 'Target calculation task (e.g. "sp", "opt", "freq", "optfreq", "scan", "ts", "irc", "td", "tdopt", "nmr", "stable", "bsse", "neb", "esd", "md"). Defaults to "optfreq".'
        },
        solvent: {
          type: 'string',
          description: 'Optional solvent name or alias (e.g. "water", "acetonitrile", "dmso", "thf", "dichloromethane", "水") to resolve against verified built-in solvent catalogs.'
        },
        windowId: {
          type: 'integer',
          description: 'Optional Electron BrowserWindow ID override.'
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
      const engine = args.engine ?? 'gaussian';
      if (typeof engine !== 'string' || !VALID_RECOMMEND_ENGINES.includes(engine)) {
        throw Object.assign(
          new Error(`engine must be one of: ${VALID_RECOMMEND_ENGINES.join(', ')}`),
          { code: 'INVALID_ENGINE' }
        );
      }
      const task = args.task ?? 'optfreq';
      if (typeof task !== 'string' || !VALID_CALCULATION_TASKS.includes(task)) {
        throw Object.assign(
          new Error(`task must be one of: ${VALID_CALCULATION_TASKS.join(', ')}`),
          { code: 'INVALID_CALCULATION_TASK' }
        );
      }
      if (args.solvent !== undefined && typeof args.solvent !== 'string') {
        throw Object.assign(
          new Error('solvent must be a string when provided'),
          { code: 'INVALID_SOLVENT' }
        );
      }

      const result = await dispatchToHost('recommend-method', {
        ...(args.documentId !== undefined ? { documentId: args.documentId.trim() } : {}),
        ...(args.windowId !== undefined ? { windowId: args.windowId } : {}),
        engine,
        task,
        ...(args.solvent !== undefined ? { solvent: args.solvent.trim() } : {})
      });
      return {
        ok: true,
        ...result
      };
    }
  });

  registry.registerTool({
    name: 'ester_configure_calculation',
    description:
      'Create or update a Gaussian (.gjf) or ORCA (.inp) quantum chemistry calculation configuration for a document, synchronize it live into Ester Studio\'s Input workbench UI (preserving any shared frozen atoms and scan coordinates from ModelStore), validate all scientific settings, and return the complete generated input script and validation diagnostics.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          description: 'Target document ID or label. Defaults to the currently active document.'
        },
        engine: {
          type: 'string',
          enum: VALID_CALCULATION_ENGINES,
          description: 'Target quantum chemistry engine ("gaussian" or "orca").'
        },
        settings: {
          type: 'object',
          description: 'Calculation settings patch (task, method, customMethod, basis, dispersion, solventModel, solvent, charge, multiplicity, confirmElectronicState, unrestricted, use5D, nosymm, cores, memoryGB, writeCores, writeMemory, confirmResources, name, title, saveCheckpoint, checkpointName, scf, grid, integral, advanced, optimization, pno, version, excited, frequency, nmr, irc).',
          properties: {
            task: { type: 'string', enum: VALID_CALCULATION_TASKS },
            method: { type: 'string' },
            customMethod: { type: 'string' },
            basis: { type: 'string' },
            dispersion: { type: 'string', enum: ['gd3bj', 'gd3', 'none'] },
            solventModel: { type: 'string', enum: ['iefpcm', 'cpcm', 'smd'] },
            solvent: { type: 'string' },
            charge: { type: 'integer' },
            multiplicity: { type: 'integer', minimum: 1 },
            confirmElectronicState: { type: 'boolean' },
            unrestricted: { type: 'boolean' },
            use5D: { type: 'boolean' },
            nosymm: { type: 'boolean' },
            cores: { type: 'integer', minimum: 0, maximum: 4096 },
            memoryGB: { type: 'number', minimum: 0, maximum: 65536 },
            writeCores: { type: 'boolean' },
            writeMemory: { type: 'boolean' },
            confirmResources: { type: 'boolean' },
            name: { type: 'string' },
            title: { type: 'string' },
            saveCheckpoint: { type: 'boolean' },
            checkpointName: { type: 'string' },
            scf: {
              description: 'Gaussian SCF convergence ("default" or "conver6") or ORCA SCF options object ({ convergence, strategy, algorithm, maxIterations }).'
            },
            grid: { type: 'string' },
            integral: {
              type: 'object',
              properties: {
                grid: { type: 'string', enum: ['fine', 'ultrafine', 'superfinegrid'] },
                acc2e: { type: 'integer', minimum: 1 }
              },
              additionalProperties: false
            },
            advanced: { type: 'object' },
            optimization: { type: 'object' },
            pno: { type: 'string', enum: ['normal', 'tight', 'loose'] },
            version: { type: 'string', enum: ['5', '6.0', '6.1'] },
            excited: { type: 'object' },
            frequency: { type: 'object' },
            nmr: { type: 'string', enum: ['giao', 'spinspin', 'mixed', 'shielding', 'coupling'] },
            irc: { type: 'object' }
          },
          additionalProperties: false
        },
        switchToInputView: {
          type: 'boolean',
          description: 'When true (default), activates the target document and switches the live Ester Studio UI to the Input workbench so the user immediately sees the configured parameters and generated script.'
        },
        generateOutput: {
          type: 'boolean',
          description: 'When true (default), finalizes the generated .gjf / .inp output snapshot when validation has 0 errors.'
        },
        windowId: {
          type: 'integer',
          description: 'Optional Electron BrowserWindow ID override.'
        }
      },
      required: ['engine'],
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
      if (typeof args.engine !== 'string' || !VALID_CALCULATION_ENGINES.includes(args.engine)) {
        throw Object.assign(
          new Error(`engine must be one of: ${VALID_CALCULATION_ENGINES.join(', ')}`),
          { code: 'INVALID_ENGINE' }
        );
      }
      if (args.switchToInputView !== undefined && typeof args.switchToInputView !== 'boolean') {
        throw Object.assign(
          new Error('switchToInputView must be a boolean'),
          { code: 'INVALID_CALCULATION_OPTION' }
        );
      }
      if (args.generateOutput !== undefined && typeof args.generateOutput !== 'boolean') {
        throw Object.assign(
          new Error('generateOutput must be a boolean'),
          { code: 'INVALID_CALCULATION_OPTION' }
        );
      }
      if (args.settings !== undefined) {
        if (!isPlainObject(args.settings)) {
          throw Object.assign(
            new Error('settings must be a plain object'),
            { code: 'INVALID_CALCULATION_SETTINGS' }
          );
        }
        const s = args.settings;
        const allowedKeys = new Set([
          'task', 'method', 'customMethod', 'basis', 'dispersion',
          'solventModel', 'solvent', 'charge', 'multiplicity', 'confirmElectronicState',
          'unrestricted', 'use5D', 'nosymm', 'cores', 'memoryGB', 'writeCores', 'writeMemory',
          'confirmResources', 'name', 'title', 'saveCheckpoint', 'checkpointName',
          'scf', 'grid', 'integral', 'advanced', 'optimization', 'pno', 'version',
          'excited', 'frequency', 'nmr', 'irc'
        ]);
        for (const key of Object.keys(s)) {
          if (!allowedKeys.has(key)) {
            throw Object.assign(
              new Error(`Unsupported calculation setting key: "${key}"`),
              { code: 'INVALID_CALCULATION_SETTINGS' }
            );
          }
        }
        if (s.task !== undefined && (typeof s.task !== 'string' || !VALID_CALCULATION_TASKS.includes(s.task))) {
          throw Object.assign(
            new Error(`settings.task must be one of: ${VALID_CALCULATION_TASKS.join(', ')}`),
            { code: 'INVALID_CALCULATION_TASK' }
          );
        }
        if (s.charge !== undefined && (!Number.isSafeInteger(s.charge) || Math.abs(s.charge) > 200)) {
          throw Object.assign(
            new Error('settings.charge must be an integer in -200..200'),
            { code: 'INVALID_ELECTRONIC_STATE' }
          );
        }
        if (s.multiplicity !== undefined && (!Number.isSafeInteger(s.multiplicity) || s.multiplicity < 1 || s.multiplicity > 200)) {
          throw Object.assign(
            new Error('settings.multiplicity must be a positive integer in 1..200'),
            { code: 'INVALID_ELECTRONIC_STATE' }
          );
        }
        if (s.cores !== undefined && (!Number.isSafeInteger(s.cores) || s.cores < 0 || s.cores > 4096)) {
          throw Object.assign(
            new Error('settings.cores must be an integer in 0..4096'),
            { code: 'INVALID_CALCULATION_SETTINGS' }
          );
        }
        if (s.memoryGB !== undefined && (typeof s.memoryGB !== 'number' || !Number.isFinite(s.memoryGB) || s.memoryGB < 0 || s.memoryGB > 65536)) {
          throw Object.assign(
            new Error('settings.memoryGB must be a finite number in 0..65536'),
            { code: 'INVALID_CALCULATION_SETTINGS' }
          );
        }
        if (s.dispersion !== undefined && !['gd3bj', 'gd3', 'none'].includes(s.dispersion)) {
          throw Object.assign(
            new Error('settings.dispersion must be "gd3bj", "gd3", or "none"'),
            { code: 'INVALID_CALCULATION_SETTINGS' }
          );
        }
        if (s.solventModel !== undefined && !['iefpcm', 'cpcm', 'smd'].includes(s.solventModel)) {
          throw Object.assign(
            new Error('settings.solventModel must be "iefpcm", "cpcm", or "smd"'),
            { code: 'INVALID_CALCULATION_SETTINGS' }
          );
        }
      }

      const result = await dispatchToHost('configure-calculation', {
        ...(args.documentId !== undefined ? { documentId: args.documentId.trim() } : {}),
        ...(args.windowId !== undefined ? { windowId: args.windowId } : {}),
        engine: args.engine,
        settings: args.settings ?? {},
        switchToInputView: args.switchToInputView !== false,
        generateOutput: args.generateOutput !== false
      });
      return {
        ok: true,
        ...result
      };
    }
  });
}

const VALID_LOCAL_XTB_CALCULATIONS = Object.freeze([
  'singlepoint',
  'optimize',
  'conformer-search'
]);

const VALID_LOCAL_XTB_METHODS = Object.freeze([
  'gfn2',
  'gfn1',
  'gfn0',
  'gfnff'
]);

const VALID_XTB_SOLVATION_MODELS = Object.freeze([
  'alpb',
  'gbsa'
]);

const VALID_SUBMIT_TASK_MODES = Object.freeze([
  'open-dialog',
  'auto-submit'
]);

const VALID_TASK_MANAGE_ACTIONS = Object.freeze([
  'list-tasks',
  'task-detail',
  'read-log',
  'stop-task',
  'list-environments'
]);

const VALID_TASK_CATEGORIES = Object.freeze([
  'all',
  'active',
  'unverified',
  'completed',
  'failed',
  'archived',
  'recycle',
  'ungrouped'
]);

const ALLOWED_RUN_LOCAL_XTB_KEYS = Object.freeze([
  'documentId',
  'windowId',
  'calculation',
  'method',
  'solvent',
  'solvationModel',
  'maxSteps',
  'rebuildBonds',
  'maxCandidates',
  'pointsPerTorsion',
  'timeoutSeconds'
]);

const ALLOWED_SUBMIT_TASK_KEYS = Object.freeze([
  'documentId',
  'windowId',
  'engine',
  'mode',
  'environmentId',
  'taskName',
  'cores',
  'memoryGB'
]);

const ALLOWED_TASK_MANAGE_KEYS = Object.freeze([
  'windowId',
  'action',
  'taskId',
  'tailLines',
  'category',
  'artifactId'
]);

function assertNoControlChars(value, fieldName, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength || /[\r\n\0]/.test(value)) {
    throw Object.assign(
      new Error(`${fieldName} must be a non-empty single-line string up to ${maxLength} characters`),
      { code: 'INVALID_TASK_ARGUMENT' }
    );
  }
  return value.trim();
}

function registerTaskExecutionTools(registry, { dispatchToHost }) {
  if (typeof dispatchToHost !== 'function') {
    throw new Error('registerTaskExecutionTools requires a dispatchToHost function');
  }

  registry.registerTool({
    name: 'ester_run_local_xtb',
    description: 'Run a local semi-empirical xTB or GFN-FF calculation in Ester Studio: singlepoint (GFN2 energy + Mayer-Wiberg bond orders), geometry optimization (live 3D frame playback + converged coordinates), or rotatable-bond conformer search (torsion sampling + xTB stage optimization & RMSD/energy clustering).',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          description: 'Target document ID or tab label (defaults to the active document).'
        },
        windowId: {
          type: 'integer',
          description: 'Optional target Electron window ID.'
        },
        calculation: {
          type: 'string',
          enum: VALID_LOCAL_XTB_CALCULATIONS,
          description: 'Calculation mode: "singlepoint" (GFN2 only), "optimize", or "conformer-search".'
        },
        method: {
          type: 'string',
          enum: VALID_LOCAL_XTB_METHODS,
          description: 'xTB method: "gfn2" (default), "gfn1", "gfn0", or "gfnff". Note: singlepoint requires "gfn2".'
        },
        solvent: {
          type: 'string',
          description: 'Optional implicit solvent name (e.g., "water", "ch2cl2", "chcl3", "acetonitrile", "dmso", "thf", "methanol", "toluene", or "none"/"gas").'
        },
        solvationModel: {
          type: 'string',
          enum: VALID_XTB_SOLVATION_MODELS,
          description: 'Implicit solvation model when solvent is provided: "alpb" (default) or "gbsa".'
        },
        maxSteps: {
          type: 'integer',
          description: 'Maximum geometry optimization cycles (1..5000, default: 500).'
        },
        rebuildBonds: {
          type: 'boolean',
          description: 'Whether to update bond orders / connectivity after isolated singlepoint or optimization (default: true for GFN methods, false for periodic or GFN-FF).'
        },
        maxCandidates: {
          type: 'integer',
          description: 'Maximum target conformer guesses for "conformer-search" (1..500, default: 24).'
        },
        pointsPerTorsion: {
          type: 'integer',
          description: 'Base sampling grid points per rotatable dihedral for "conformer-search" (2..12, default: 3).'
        },
        timeoutSeconds: {
          type: 'integer',
          description: 'Maximum wall-clock wait time in seconds for MCP completion (5..600, default: 300).'
        }
      },
      required: ['calculation'],
      additionalProperties: false
    },
    async handler(args) {
      for (const key of Object.keys(args)) {
        if (!ALLOWED_RUN_LOCAL_XTB_KEYS.includes(key)) {
          throw Object.assign(
            new Error(`Unknown argument "${key}" for ester_run_local_xtb`),
            { code: 'UNKNOWN_XTB_ARGUMENT' }
          );
        }
      }
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
      if (!VALID_LOCAL_XTB_CALCULATIONS.includes(args.calculation)) {
        throw Object.assign(
          new Error(`calculation must be one of: ${VALID_LOCAL_XTB_CALCULATIONS.join(', ')}`),
          { code: 'INVALID_XTB_CALCULATION' }
        );
      }
      const method = args.method ?? 'gfn2';
      if (!VALID_LOCAL_XTB_METHODS.includes(method)) {
        throw Object.assign(
          new Error(`method must be one of: ${VALID_LOCAL_XTB_METHODS.join(', ')}`),
          { code: 'INVALID_XTB_METHOD' }
        );
      }
      if (args.calculation === 'singlepoint' && method !== 'gfn2') {
        throw Object.assign(
          new Error('calculation "singlepoint" only supports method "gfn2"'),
          { code: 'INVALID_XTB_METHOD' }
        );
      }
      let solvent;
      if (args.solvent !== undefined) {
        solvent = assertNoControlChars(args.solvent, 'solvent', 64);
      }
      if (args.solvationModel !== undefined && !VALID_XTB_SOLVATION_MODELS.includes(args.solvationModel)) {
        throw Object.assign(
          new Error(`solvationModel must be one of: ${VALID_XTB_SOLVATION_MODELS.join(', ')}`),
          { code: 'INVALID_XTB_SOLVATION' }
        );
      }
      if (args.maxSteps !== undefined && (!Number.isInteger(args.maxSteps) || args.maxSteps < 1 || args.maxSteps > 5000)) {
        throw Object.assign(
          new Error('maxSteps must be an integer between 1 and 5000'),
          { code: 'INVALID_XTB_MAX_STEPS' }
        );
      }
      if (args.rebuildBonds !== undefined && typeof args.rebuildBonds !== 'boolean') {
        throw Object.assign(
          new Error('rebuildBonds must be a boolean'),
          { code: 'INVALID_XTB_REBUILD_BONDS' }
        );
      }
      if (args.maxCandidates !== undefined && (!Number.isInteger(args.maxCandidates) || args.maxCandidates < 1 || args.maxCandidates > 500)) {
        throw Object.assign(
          new Error('maxCandidates must be an integer between 1 and 500'),
          { code: 'INVALID_XTB_MAX_CANDIDATES' }
        );
      }
      if (args.pointsPerTorsion !== undefined && (!Number.isInteger(args.pointsPerTorsion) || args.pointsPerTorsion < 2 || args.pointsPerTorsion > 12)) {
        throw Object.assign(
          new Error('pointsPerTorsion must be an integer between 2 and 12'),
          { code: 'INVALID_XTB_POINTS_PER_TORSION' }
        );
      }
      if (args.timeoutSeconds !== undefined && (!Number.isInteger(args.timeoutSeconds) || args.timeoutSeconds < 5 || args.timeoutSeconds > 600)) {
        throw Object.assign(
          new Error('timeoutSeconds must be an integer between 5 and 600'),
          { code: 'INVALID_XTB_TIMEOUT' }
        );
      }

      const result = await dispatchToHost('run-local-xtb', {
        ...(args.documentId !== undefined ? { documentId: args.documentId.trim() } : {}),
        ...(args.windowId !== undefined ? { windowId: args.windowId } : {}),
        calculation: args.calculation,
        method,
        ...(solvent !== undefined ? { solvent } : {}),
        ...(args.solvationModel !== undefined ? { solvationModel: args.solvationModel } : {}),
        ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
        ...(args.rebuildBonds !== undefined ? { rebuildBonds: args.rebuildBonds } : {}),
        ...(args.maxCandidates !== undefined ? { maxCandidates: args.maxCandidates } : {}),
        ...(args.pointsPerTorsion !== undefined ? { pointsPerTorsion: args.pointsPerTorsion } : {}),
        ...(args.timeoutSeconds !== undefined ? { timeoutSeconds: args.timeoutSeconds } : {})
      });
      return {
        ok: true,
        ...result
      };
    }
  });

  registry.registerTool({
    name: 'ester_submit_task',
    description: 'Submit the configured Gaussian (.gjf) or ORCA (.inp) input draft to Ester Studio Task Center. Supports "open-dialog" (pre-fills the submission dialog in UI for user confirmation, default) and "auto-submit" (directly stages and submits to the target local or SSH/Slurm environment and opens Task Center).',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          description: 'Target document ID or tab label (defaults to the active document).'
        },
        windowId: {
          type: 'integer',
          description: 'Optional target Electron window ID.'
        },
        engine: {
          type: 'string',
          enum: VALID_CALCULATION_ENGINES,
          description: 'Optional engine selector ("gaussian" or "orca") when the document holds drafts for both engines.'
        },
        mode: {
          type: 'string',
          enum: VALID_SUBMIT_TASK_MODES,
          description: 'Submission mode: "open-dialog" (default, opens pre-filled UI dialog for human confirmation) or "auto-submit" (submits directly to Task Center).'
        },
        environmentId: {
          type: 'string',
          description: 'Target compute environment ID from ester_task_manage(action: "list-environments"). Required in auto-submit mode when multiple environments match the engine.'
        },
        taskName: {
          type: 'string',
          description: 'Optional display name for the submitted task in Task Center.'
        },
        cores: {
          type: 'integer',
          description: 'Optional CPU core / MPI process count override (1..1024).'
        },
        memoryGB: {
          type: 'number',
          description: 'Optional total memory override in GB (e.g., 8 or 32; mapped to %Mem for Gaussian and 75% per-core %maxcore MB for ORCA).'
        }
      },
      additionalProperties: false
    },
    async handler(args) {
      for (const key of Object.keys(args)) {
        if (!ALLOWED_SUBMIT_TASK_KEYS.includes(key)) {
          throw Object.assign(
            new Error(`Unknown argument "${key}" for ester_submit_task`),
            { code: 'UNKNOWN_SUBMIT_ARGUMENT' }
          );
        }
      }
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
      if (args.engine !== undefined && !VALID_CALCULATION_ENGINES.includes(args.engine)) {
        throw Object.assign(
          new Error(`engine must be one of: ${VALID_CALCULATION_ENGINES.join(', ')}`),
          { code: 'INVALID_CALCULATION_ENGINE' }
        );
      }
      const mode = args.mode ?? 'open-dialog';
      if (!VALID_SUBMIT_TASK_MODES.includes(mode)) {
        throw Object.assign(
          new Error(`mode must be one of: ${VALID_SUBMIT_TASK_MODES.join(', ')}`),
          { code: 'INVALID_SUBMIT_MODE' }
        );
      }
      const environmentId = args.environmentId !== undefined
        ? assertNoControlChars(args.environmentId, 'environmentId', 200)
        : undefined;
      const taskName = args.taskName !== undefined
        ? assertNoControlChars(args.taskName, 'taskName', 128)
        : undefined;
      if (args.cores !== undefined && (!Number.isInteger(args.cores) || args.cores < 1 || args.cores > 1024)) {
        throw Object.assign(
          new Error('cores must be an integer between 1 and 1024'),
          { code: 'INVALID_SUBMIT_CORES' }
        );
      }
      if (args.memoryGB !== undefined && (typeof args.memoryGB !== 'number' || !Number.isFinite(args.memoryGB) || args.memoryGB <= 0 || args.memoryGB > 16384)) {
        throw Object.assign(
          new Error('memoryGB must be a positive finite number up to 16384'),
          { code: 'INVALID_SUBMIT_MEMORY' }
        );
      }

      const result = await dispatchToHost('submit-task', {
        ...(args.documentId !== undefined ? { documentId: args.documentId.trim() } : {}),
        ...(args.windowId !== undefined ? { windowId: args.windowId } : {}),
        ...(args.engine !== undefined ? { engine: args.engine } : {}),
        mode,
        ...(environmentId !== undefined ? { environmentId } : {}),
        ...(taskName !== undefined ? { taskName } : {}),
        ...(args.cores !== undefined ? { cores: args.cores } : {}),
        ...(args.memoryGB !== undefined ? { memoryGB: args.memoryGB } : {})
      });
      return {
        ok: true,
        ...result
      };
    }
  });

  registry.registerTool({
    name: 'ester_task_manage',
    description: 'Inspect and control tasks and environments in Ester Studio Task Center: list configured environments, list tasks with live execution states, inspect SCF/optimization energy & frame monitoring details, read output log tails, or stop a running task.',
    inputSchema: {
      type: 'object',
      properties: {
        windowId: {
          type: 'integer',
          description: 'Optional target Electron window ID.'
        },
        action: {
          type: 'string',
          enum: VALID_TASK_MANAGE_ACTIONS,
          description: 'Management action: "list-environments", "list-tasks", "task-detail", "read-log", or "stop-task".'
        },
        taskId: {
          type: 'string',
          description: 'Target Task Center taskId (required for "task-detail", "read-log", and "stop-task").'
        },
        tailLines: {
          type: 'integer',
          description: 'Number of trailing log lines to read for "read-log" (1..500, default: 80).'
        },
        category: {
          type: 'string',
          enum: VALID_TASK_CATEGORIES,
          description: 'Optional category filter for "list-tasks" (default: "all").'
        },
        artifactId: {
          type: 'string',
          description: 'Optional specific text file artifactId to read in "read-log" (defaults to primary output log).'
        }
      },
      required: ['action'],
      additionalProperties: false
    },
    async handler(args) {
      for (const key of Object.keys(args)) {
        if (!ALLOWED_TASK_MANAGE_KEYS.includes(key)) {
          throw Object.assign(
            new Error(`Unknown argument "${key}" for ester_task_manage`),
            { code: 'UNKNOWN_TASK_MANAGE_ARGUMENT' }
          );
        }
      }
      if (args.windowId !== undefined && (!Number.isInteger(args.windowId) || args.windowId <= 0)) {
        throw Object.assign(
          new Error('windowId must be a positive integer'),
          { code: 'INVALID_WINDOW_ID' }
        );
      }
      if (!VALID_TASK_MANAGE_ACTIONS.includes(args.action)) {
        throw Object.assign(
          new Error(`action must be one of: ${VALID_TASK_MANAGE_ACTIONS.join(', ')}`),
          { code: 'INVALID_TASK_MANAGE_ACTION' }
        );
      }
      const requiresTaskId = ['task-detail', 'read-log', 'stop-task'].includes(args.action);
      let taskId;
      if (args.taskId !== undefined) {
        taskId = assertNoControlChars(args.taskId, 'taskId', 200);
      } else if (requiresTaskId) {
        throw Object.assign(
          new Error(`taskId is required when action is "${args.action}"`),
          { code: 'MISSING_TASK_ID' }
        );
      }
      if (args.tailLines !== undefined && (!Number.isInteger(args.tailLines) || args.tailLines < 1 || args.tailLines > 500)) {
        throw Object.assign(
          new Error('tailLines must be an integer between 1 and 500'),
          { code: 'INVALID_TAIL_LINES' }
        );
      }
      if (args.category !== undefined && !VALID_TASK_CATEGORIES.includes(args.category)) {
        throw Object.assign(
          new Error(`category must be one of: ${VALID_TASK_CATEGORIES.join(', ')}`),
          { code: 'INVALID_TASK_CATEGORY' }
        );
      }
      const artifactId = args.artifactId !== undefined
        ? assertNoControlChars(args.artifactId, 'artifactId', 200)
        : undefined;

      const result = await dispatchToHost('task-manage', {
        ...(args.windowId !== undefined ? { windowId: args.windowId } : {}),
        action: args.action,
        ...(taskId !== undefined ? { taskId } : {}),
        ...(args.tailLines !== undefined ? { tailLines: args.tailLines } : {}),
        ...(args.category !== undefined ? { category: args.category } : {}),
        ...(artifactId !== undefined ? { artifactId } : {})
      });
      return {
        ok: true,
        ...result
      };
    }
  });
}

const VALID_ANALYSIS_PANELS = Object.freeze([
  'energy',
  'charges',
  'bonds',
  'orbitals',
  'trajectory',
  'excited',
  'vibrations',
  'surface',
  'interaction',
  'reactivity'
]);

const VALID_WAVEFUNCTION_ANALYSIS_KINDS = Object.freeze([
  'charges',
  'bond-orders',
  'composition',
  'orbitals',
  'reactivity'
]);

const VALID_CHARGE_METHODS = Object.freeze([
  'mulliken',
  'lowdin',
  'adch',
  'hirshfeld',
  'hirshfeld-i',
  'cm5',
  'resp',
  'scpa',
  'bader'
]);

const VALID_BOND_ORDER_METHODS = Object.freeze([
  'mayer',
  'wiberg-lowdin',
  'mulliken',
  'laplacian',
  'fuzzy'
]);

const VALID_COMPOSITION_METHODS = Object.freeze([
  'mulliken',
  'scpa'
]);

const VALID_ORBITAL_METHODS = Object.freeze([
  'frontier',
  'toy',
  'rough',
  'normal',
  'fine'
]);

const VALID_REACTIVITY_METRICS = Object.freeze([
  'dual',
  'fPlus',
  'fMinus',
  'fZero',
  'omega',
  'NNu',
  'sPlus',
  'sMinus',
  'sZero'
]);

const VALID_EXPORT_ARTIFACT_KINDS = Object.freeze([
  'structure',
  'input-script',
  'analysis-table'
]);

const VALID_EXPORT_FORMATS = Object.freeze([
  'xyz',
  'extxyz',
  'cif',
  'poscar',
  'gjf',
  'inp',
  'tsv'
]);

const EXPORT_FORMATS_BY_KIND = Object.freeze({
  structure: Object.freeze(['xyz', 'extxyz', 'cif', 'poscar']),
  'input-script': Object.freeze(['gjf', 'inp']),
  'analysis-table': Object.freeze(['tsv'])
});

const VALID_EXPORT_ANALYSIS_KINDS = Object.freeze([
  'charges',
  'bond-orders',
  'composition',
  'reactivity',
  'printed-charges'
]);

const ALLOWED_OPEN_RESULT_ANALYSIS_KEYS = Object.freeze([
  'source',
  'documentId',
  'panel',
  'frameIndex',
  'label',
  'windowId'
]);

const ALLOWED_RUN_WAVEFUNCTION_ANALYSIS_KEYS = Object.freeze([
  'documentId',
  'kind',
  'method',
  'orbitalKey',
  'isovalue',
  'gridSpacingAngstrom',
  'renderInViewport',
  'timeoutSeconds',
  'windowId'
]);

const ALLOWED_EXPORT_ARTIFACT_KEYS = Object.freeze([
  'documentId',
  'kind',
  'format',
  'withCell',
  'analysisKind',
  'method',
  'outputPath',
  'overwrite',
  'windowId'
]);

function registerAnalysisAndExportTools(registry, { dispatchToHost }) {
  if (typeof dispatchToHost !== 'function') {
    throw new Error('registerAnalysisAndExportTools requires a dispatchToHost function');
  }

  registry.registerTool({
    name: 'ester_open_result_analysis',
    description: 'Open or inspect a quantum-chemical calculation result in the Ester Studio Result Analysis (后处理) workspace from a Task Center task snapshot (source.taskId), a local output/wavefunction file (source.filePath: .log/.out/.fchk/.molden/.hess/.xyz), or an already-open analysis document, optionally switching sub-panels and returning energy, convergence, imaginary-frequency diagnostics, thermochemistry, frontier orbitals, and TD-DFT spectra summaries.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'object',
          properties: {
            taskId: {
              type: 'string',
              description: 'Task Center taskId to open as a fixed analysis snapshot.'
            },
            filePath: {
              type: 'string',
              description: 'Local file path (.log/.out/.fchk/.fch/.molden/.hess/.xyz) to load into Result Analysis (or pair onto documentId when specified).'
            }
          },
          additionalProperties: false,
          description: 'Optional result source to open. Provide either taskId or filePath (mutually exclusive), or omit to inspect/switch panels on an already-open analysis document.'
        },
        documentId: {
          type: 'string',
          description: 'Optional target document ID or label (when source.filePath is given, pairs companion wavefunction/hessian onto that document; when source is omitted, selects that open analysis document).'
        },
        panel: {
          type: 'string',
          enum: [...VALID_ANALYSIS_PANELS],
          description: 'Optional analysis sub-panel to open and focus in the UI (energy, charges, bonds, orbitals, trajectory, excited, vibrations, surface, interaction, reactivity).'
        },
        frameIndex: {
          type: 'integer',
          description: 'Optional 0-based trajectory/optimization frame index to seek to.'
        },
        label: {
          type: 'string',
          description: 'Optional custom tab label when opening a new analysis document from filePath.'
        },
        windowId: {
          type: 'integer',
          description: 'Optional target Electron window ID.'
        }
      },
      additionalProperties: false
    },
    async handler(args) {
      for (const key of Object.keys(args)) {
        if (!ALLOWED_OPEN_RESULT_ANALYSIS_KEYS.includes(key)) {
          throw Object.assign(
            new Error(`Unknown argument for ester_open_result_analysis: ${key}`),
            { code: 'UNKNOWN_ARGUMENT' }
          );
        }
      }
      if (args.windowId !== undefined && (!Number.isInteger(args.windowId) || args.windowId <= 0)) {
        throw Object.assign(
          new Error('windowId must be a positive integer'),
          { code: 'INVALID_WINDOW_ID' }
        );
      }
      const documentId = args.documentId !== undefined
        ? assertNoControlChars(args.documentId, 'documentId', 200)
        : undefined;
      const label = args.label !== undefined
        ? assertNoControlChars(args.label, 'label', 200)
        : undefined;
      if (args.panel !== undefined && (typeof args.panel !== 'string' || !VALID_ANALYSIS_PANELS.includes(args.panel))) {
        throw Object.assign(
          new Error(`panel must be one of: ${VALID_ANALYSIS_PANELS.join(', ')}`),
          { code: 'INVALID_ANALYSIS_PANEL' }
        );
      }
      if (args.frameIndex !== undefined && (!Number.isInteger(args.frameIndex) || args.frameIndex < 0)) {
        throw Object.assign(
          new Error('frameIndex must be a non-negative integer'),
          { code: 'INVALID_FRAME_INDEX' }
        );
      }

      let normalizedSource;
      if (args.source !== undefined) {
        if (!isPlainObject(args.source)) {
          throw Object.assign(
            new Error('source must be an object containing either taskId or filePath'),
            { code: 'INVALID_RESULT_SOURCE' }
          );
        }
        for (const key of Object.keys(args.source)) {
          if (key !== 'taskId' && key !== 'filePath') {
            throw Object.assign(
              new Error(`Unknown property in source: ${key}`),
              { code: 'INVALID_RESULT_SOURCE' }
            );
          }
        }
        const hasTaskId = args.source.taskId !== undefined;
        const hasFilePath = args.source.filePath !== undefined;
        if ((hasTaskId && hasFilePath) || (!hasTaskId && !hasFilePath)) {
          throw Object.assign(
            new Error('source must specify exactly one of taskId or filePath'),
            { code: 'INVALID_RESULT_SOURCE' }
          );
        }
        if (hasTaskId) {
          normalizedSource = {
            taskId: assertNoControlChars(args.source.taskId, 'source.taskId', 200)
          };
        } else {
          normalizedSource = {
            filePath: assertNoControlChars(args.source.filePath, 'source.filePath', 4096)
          };
        }
      }

      const result = await dispatchToHost('open-result-analysis', {
        ...(args.windowId !== undefined ? { windowId: args.windowId } : {}),
        ...(normalizedSource ? { source: normalizedSource } : {}),
        ...(documentId !== undefined ? { documentId } : {}),
        ...(args.panel !== undefined ? { panel: args.panel } : {}),
        ...(args.frameIndex !== undefined ? { frameIndex: args.frameIndex } : {}),
        ...(label !== undefined ? { label } : {})
      });
      return {
        ok: true,
        ...result
      };
    }
  });

  registry.registerTool({
    name: 'ester_run_wavefunction_analysis',
    description: 'Run native Multiwfn wavefunction analysis on an open Result Analysis document: atomic charges (resp, cm5, adch, hirshfeld, hirshfeld-i, bader, mulliken, lowdin, scpa), bond orders (mayer, wiberg-lowdin, mulliken, laplacian, fuzzy), orbital composition (mulliken, scpa), molecular orbitals (HOMO/LUMO 3D isosurface), or conceptual DFT reactivity (Fukui f+/f-/f0 & dual descriptor), synchronizing visual coloring/isosurfaces in the live 3D viewport and returning full numerical tables.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          description: 'Optional target analysis document ID or label (defaults to the active analysis document).'
        },
        windowId: {
          type: 'integer',
          description: 'Optional target Electron window ID.'
        },
        kind: {
          type: 'string',
          enum: [...VALID_WAVEFUNCTION_ANALYSIS_KINDS],
          description: 'Wavefunction analysis category: "charges", "bond-orders", "composition", "orbitals", or "reactivity".'
        },
        method: {
          type: 'string',
          description: 'Analysis method: for charges ("resp", "cm5", "adch", "hirshfeld", "hirshfeld-i", "bader", "mulliken", "lowdin", "scpa"; default "cm5"), bond-orders ("mayer", "wiberg-lowdin", "mulliken", "laplacian", "fuzzy"; default "mayer"), composition ("mulliken", "scpa"), orbitals ("frontier" | "toy" | "rough" | "normal" | "fine"), or reactivity atom coloring metric ("dual", "fPlus", "fMinus", "fZero", "omega", "NNu", "sPlus", "sMinus", "sZero"; default "dual").'
        },
        orbitalKey: {
          type: 'string',
          description: 'Target orbital key or alias ("HOMO", "LUMO", "HOMO-1", "LUMO+1", or native key like "restricted:12" / "alpha:12"). Required when kind is "composition"; defaults to "HOMO" when kind is "orbitals" and renderInViewport is true.'
        },
        isovalue: {
          type: 'number',
          description: 'Positive orbital isosurface magnitude in bohr^(-3/2) when kind is "orbitals" (0.0001..1.0, default: 0.05).'
        },
        gridSpacingAngstrom: {
          type: 'number',
          description: '3D orbital grid spacing in Angstrom when kind is "orbitals" (0.05..1.0, default: 0.15).'
        },
        renderInViewport: {
          type: 'boolean',
          description: 'Whether to activate the corresponding analysis sub-panel and project charge/bond/reactivity coloring or 3D orbital isosurfaces into the live 3D viewport (default: true).'
        },
        timeoutSeconds: {
          type: 'integer',
          description: 'Maximum wall-clock wait time in seconds for Multiwfn execution (5..600, default: 300).'
        }
      },
      required: ['kind'],
      additionalProperties: false
    },
    async handler(args) {
      for (const key of Object.keys(args)) {
        if (!ALLOWED_RUN_WAVEFUNCTION_ANALYSIS_KEYS.includes(key)) {
          throw Object.assign(
            new Error(`Unknown argument for ester_run_wavefunction_analysis: ${key}`),
            { code: 'UNKNOWN_ARGUMENT' }
          );
        }
      }
      if (args.windowId !== undefined && (!Number.isInteger(args.windowId) || args.windowId <= 0)) {
        throw Object.assign(
          new Error('windowId must be a positive integer'),
          { code: 'INVALID_WINDOW_ID' }
        );
      }
      const documentId = args.documentId !== undefined
        ? assertNoControlChars(args.documentId, 'documentId', 200)
        : undefined;
      if (typeof args.kind !== 'string' || !VALID_WAVEFUNCTION_ANALYSIS_KINDS.includes(args.kind)) {
        throw Object.assign(
          new Error(`kind must be one of: ${VALID_WAVEFUNCTION_ANALYSIS_KINDS.join(', ')}`),
          { code: 'INVALID_WAVEFUNCTION_KIND' }
        );
      }

      let method = args.method !== undefined
        ? assertNoControlChars(args.method, 'method', 80)
        : undefined;
      if (args.kind === 'charges') {
        method = method ? method.toLowerCase() : 'cm5';
        if (!VALID_CHARGE_METHODS.includes(method)) {
          throw Object.assign(
            new Error(`charges method must be one of: ${VALID_CHARGE_METHODS.join(', ')}`),
            { code: 'INVALID_WAVEFUNCTION_METHOD' }
          );
        }
      } else if (args.kind === 'bond-orders') {
        method = method ? method.toLowerCase() : 'mayer';
        if (!VALID_BOND_ORDER_METHODS.includes(method)) {
          throw Object.assign(
            new Error(`bond-orders method must be one of: ${VALID_BOND_ORDER_METHODS.join(', ')}`),
            { code: 'INVALID_WAVEFUNCTION_METHOD' }
          );
        }
      } else if (args.kind === 'composition') {
        if (method !== undefined) {
          method = method.toLowerCase();
          if (!VALID_COMPOSITION_METHODS.includes(method)) {
            throw Object.assign(
              new Error(`composition method must be one of: ${VALID_COMPOSITION_METHODS.join(', ')}`),
              { code: 'INVALID_WAVEFUNCTION_METHOD' }
            );
          }
        }
      } else if (args.kind === 'orbitals') {
        if (method !== undefined) {
          method = method.toLowerCase();
          if (!VALID_ORBITAL_METHODS.includes(method)) {
            throw Object.assign(
              new Error(`orbitals method must be one of: ${VALID_ORBITAL_METHODS.join(', ')}`),
              { code: 'INVALID_WAVEFUNCTION_METHOD' }
            );
          }
        }
      } else if (args.kind === 'reactivity') {
        method = method ?? 'dual';
        if (!VALID_REACTIVITY_METRICS.includes(method)) {
          throw Object.assign(
            new Error(`reactivity metric must be one of: ${VALID_REACTIVITY_METRICS.join(', ')}`),
            { code: 'INVALID_WAVEFUNCTION_METHOD' }
          );
        }
      }

      const orbitalKey = args.orbitalKey !== undefined
        ? assertNoControlChars(args.orbitalKey, 'orbitalKey', 120)
        : undefined;
      if (args.kind === 'composition' && !orbitalKey) {
        throw Object.assign(
          new Error('orbitalKey is required when kind is "composition" (e.g., "HOMO", "LUMO", or "restricted:5")'),
          { code: 'MISSING_ORBITAL_KEY' }
        );
      }

      if (args.isovalue !== undefined && (typeof args.isovalue !== 'number' || !Number.isFinite(args.isovalue) || args.isovalue < 0.0001 || args.isovalue > 1)) {
        throw Object.assign(
          new Error('isovalue must be a finite number between 0.0001 and 1.0'),
          { code: 'INVALID_ISOVALUE' }
        );
      }
      if (args.gridSpacingAngstrom !== undefined && (typeof args.gridSpacingAngstrom !== 'number' || !Number.isFinite(args.gridSpacingAngstrom) || args.gridSpacingAngstrom < 0.05 || args.gridSpacingAngstrom > 1)) {
        throw Object.assign(
          new Error('gridSpacingAngstrom must be a finite number between 0.05 and 1.0'),
          { code: 'INVALID_GRID_SPACING' }
        );
      }
      if (args.renderInViewport !== undefined && typeof args.renderInViewport !== 'boolean') {
        throw Object.assign(
          new Error('renderInViewport must be a boolean'),
          { code: 'INVALID_RENDER_IN_VIEWPORT' }
        );
      }
      if (args.timeoutSeconds !== undefined && (!Number.isInteger(args.timeoutSeconds) || args.timeoutSeconds < 5 || args.timeoutSeconds > 600)) {
        throw Object.assign(
          new Error('timeoutSeconds must be an integer between 5 and 600'),
          { code: 'INVALID_TIMEOUT_SECONDS' }
        );
      }

      const result = await dispatchToHost('run-wavefunction-analysis', {
        ...(args.windowId !== undefined ? { windowId: args.windowId } : {}),
        ...(documentId !== undefined ? { documentId } : {}),
        kind: args.kind,
        ...(method !== undefined ? { method } : {}),
        ...(orbitalKey !== undefined ? { orbitalKey } : {}),
        ...(args.isovalue !== undefined ? { isovalue: args.isovalue } : {}),
        ...(args.gridSpacingAngstrom !== undefined ? { gridSpacingAngstrom: args.gridSpacingAngstrom } : {}),
        renderInViewport: args.renderInViewport ?? true,
        ...(args.timeoutSeconds !== undefined ? { timeoutSeconds: args.timeoutSeconds } : {})
      });
      return {
        ok: true,
        ...result
      };
    }
  });

  registry.registerTool({
    name: 'ester_export_artifact',
    description: 'Export a molecular/crystal structure (xyz, extxyz, cif, poscar), generated Gaussian/ORCA input script (gjf, inp), or computed/printed wavefunction analysis table (tsv) to disk for downstream workflows such as Sobtop, ACPYPE, or GROMACS.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          description: 'Optional target document ID or label (defaults to the active document).'
        },
        windowId: {
          type: 'integer',
          description: 'Optional target Electron window ID.'
        },
        kind: {
          type: 'string',
          enum: [...VALID_EXPORT_ARTIFACT_KINDS],
          description: 'Artifact kind to export: "structure", "input-script", or "analysis-table".'
        },
        format: {
          type: 'string',
          enum: [...VALID_EXPORT_FORMATS],
          description: 'Optional file format: structure ("xyz", "extxyz", "cif", "poscar"), input-script ("gjf", "inp"), or analysis-table ("tsv"). Inferred from outputPath extension or document defaults when omitted.'
        },
        withCell: {
          type: 'boolean',
          description: 'Whether to include periodic unit cell metadata when exporting periodic structures (default: true when structure is periodic).'
        },
        analysisKind: {
          type: 'string',
          enum: [...VALID_EXPORT_ANALYSIS_KINDS],
          description: 'Optional table category when kind is "analysis-table" ("charges", "bond-orders", "composition", "reactivity", or "printed-charges"; defaults to the latest computed table on the document).'
        },
        method: {
          type: 'string',
          description: 'Optional charge/bond-order/printed scheme selector when kind is "analysis-table" (e.g., "resp", "cm5", "mayer", "mulliken").'
        },
        outputPath: {
          type: 'string',
          description: 'Destination file path on disk.'
        },
        overwrite: {
          type: 'boolean',
          description: 'Whether to overwrite outputPath if it already exists (default: true).'
        }
      },
      required: ['kind', 'outputPath'],
      additionalProperties: false
    },
    async handler(args) {
      for (const key of Object.keys(args)) {
        if (!ALLOWED_EXPORT_ARTIFACT_KEYS.includes(key)) {
          throw Object.assign(
            new Error(`Unknown argument for ester_export_artifact: ${key}`),
            { code: 'UNKNOWN_ARGUMENT' }
          );
        }
      }
      if (args.windowId !== undefined && (!Number.isInteger(args.windowId) || args.windowId <= 0)) {
        throw Object.assign(
          new Error('windowId must be a positive integer'),
          { code: 'INVALID_WINDOW_ID' }
        );
      }
      const documentId = args.documentId !== undefined
        ? assertNoControlChars(args.documentId, 'documentId', 200)
        : undefined;
      if (typeof args.kind !== 'string' || !VALID_EXPORT_ARTIFACT_KINDS.includes(args.kind)) {
        throw Object.assign(
          new Error(`kind must be one of: ${VALID_EXPORT_ARTIFACT_KINDS.join(', ')}`),
          { code: 'INVALID_EXPORT_KIND' }
        );
      }
      if (typeof args.outputPath !== 'string' || !args.outputPath.trim() || args.outputPath.trim().length > 4096 || /[\r\n\0]/.test(args.outputPath)) {
        throw Object.assign(
          new Error('outputPath must be a non-empty single-line path up to 4096 characters'),
          { code: 'INVALID_OUTPUT_PATH' }
        );
      }
      let format;
      if (args.format !== undefined) {
        if (typeof args.format !== 'string' || !VALID_EXPORT_FORMATS.includes(args.format)) {
          throw Object.assign(
            new Error(`format must be one of: ${VALID_EXPORT_FORMATS.join(', ')}`),
            { code: 'INVALID_EXPORT_FORMAT' }
          );
        }
        const allowedForKind = EXPORT_FORMATS_BY_KIND[args.kind];
        if (!allowedForKind.includes(args.format)) {
          throw Object.assign(
            new Error(`format "${args.format}" is not compatible with kind "${args.kind}" (expected one of: ${allowedForKind.join(', ')})`),
            { code: 'INVALID_EXPORT_FORMAT' }
          );
        }
        format = args.format;
      }
      if (args.withCell !== undefined && typeof args.withCell !== 'boolean') {
        throw Object.assign(
          new Error('withCell must be a boolean'),
          { code: 'INVALID_WITH_CELL' }
        );
      }
      if (args.analysisKind !== undefined) {
        if (args.kind !== 'analysis-table') {
          throw Object.assign(
            new Error('analysisKind is only valid when kind is "analysis-table"'),
            { code: 'INVALID_EXPORT_ANALYSIS_KIND' }
          );
        }
        if (typeof args.analysisKind !== 'string' || !VALID_EXPORT_ANALYSIS_KINDS.includes(args.analysisKind)) {
          throw Object.assign(
            new Error(`analysisKind must be one of: ${VALID_EXPORT_ANALYSIS_KINDS.join(', ')}`),
            { code: 'INVALID_EXPORT_ANALYSIS_KIND' }
          );
        }
      }
      const method = args.method !== undefined
        ? assertNoControlChars(args.method, 'method', 80)
        : undefined;
      if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean') {
        throw Object.assign(
          new Error('overwrite must be a boolean'),
          { code: 'INVALID_OVERWRITE' }
        );
      }

      const result = await dispatchToHost('export-artifact', {
        ...(args.windowId !== undefined ? { windowId: args.windowId } : {}),
        ...(documentId !== undefined ? { documentId } : {}),
        kind: args.kind,
        ...(format !== undefined ? { format } : {}),
        ...(args.withCell !== undefined ? { withCell: args.withCell } : {}),
        ...(args.analysisKind !== undefined ? { analysisKind: args.analysisKind } : {}),
        ...(method !== undefined ? { method } : {}),
        outputPath: args.outputPath.trim(),
        overwrite: args.overwrite ?? true
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
  VALID_CAMERA_PRESETS,
  VALID_ROTATE_STEPS,
  VALID_DISPLAY_STYLES,
  VALID_COORDINATE_TYPES,
  VALID_EDIT_STRUCTURE_OPERATIONS,
  VALID_CONSTRAINT_MODES,
  VALID_COORDINATE_ACTIONS,
  VALID_CALCULATION_ENGINES,
  VALID_RECOMMEND_ENGINES,
  VALID_CALCULATION_TASKS,
  VALID_LOCAL_XTB_CALCULATIONS,
  VALID_LOCAL_XTB_METHODS,
  VALID_XTB_SOLVATION_MODELS,
  VALID_SUBMIT_TASK_MODES,
  VALID_TASK_MANAGE_ACTIONS,
  VALID_TASK_CATEGORIES,
  VALID_ANALYSIS_PANELS,
  VALID_WAVEFUNCTION_ANALYSIS_KINDS,
  VALID_CHARGE_METHODS,
  VALID_BOND_ORDER_METHODS,
  VALID_COMPOSITION_METHODS,
  VALID_ORBITAL_METHODS,
  VALID_REACTIVITY_METRICS,
  VALID_EXPORT_ARTIFACT_KINDS,
  VALID_EXPORT_FORMATS,
  VALID_EXPORT_ANALYSIS_KINDS,
  isPlainObject,
  formatToolResult,
  jsonRpcSuccess,
  jsonRpcError,
  createMcpToolRegistry,
  registerFoundationTools,
  registerWindowAndFileTools,
  registerViewportAndVisionTools,
  registerStructureAndGeometryTools,
  registerInputConfigTools,
  registerTaskExecutionTools,
  registerAnalysisAndExportTools,
  createMcpProtocolProcessor
};
