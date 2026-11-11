'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { profileForVersion } = require('../version-profile.cjs');
const { isPlainObject } = require('./protocol.cjs');

const SESSION_SCHEMA = 'ester-mcp-session/v1';
const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_TASK_ACTION_TIMEOUT_MS = 60000;
const DEFAULT_LOCAL_XTB_TIMEOUT_SECONDS = 300;
const DEFAULT_WAVEFUNCTION_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_INLINE_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_EXPORT_TEXT_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function resolveActionTimeoutMs(action, payload, configuredTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, { isClient = false } = {}) {
  const clientSlackMs = isClient ? 5000 : 0;
  const hostComputeSlackMs = 5000;
  if (action === 'run-local-xtb' || action === 'run-wavefunction-analysis') {
    if (isPlainObject(payload) && Number.isInteger(payload.timeoutSeconds) && payload.timeoutSeconds >= 5 && payload.timeoutSeconds <= 600) {
      return payload.timeoutSeconds * 1000 + hostComputeSlackMs + clientSlackMs;
    }
    if (configuredTimeoutMs === DEFAULT_REQUEST_TIMEOUT_MS) {
      const defaultSec = action === 'run-local-xtb'
        ? DEFAULT_LOCAL_XTB_TIMEOUT_SECONDS
        : DEFAULT_WAVEFUNCTION_TIMEOUT_SECONDS;
      return defaultSec * 1000 + hostComputeSlackMs + clientSlackMs;
    }
    return configuredTimeoutMs;
  }
  if (
    action === 'submit-task' ||
    action === 'task-manage' ||
    action === 'open-result-analysis' ||
    action === 'export-artifact'
  ) {
    if (configuredTimeoutMs === DEFAULT_REQUEST_TIMEOUT_MS) {
      return DEFAULT_TASK_ACTION_TIMEOUT_MS + clientSlackMs;
    }
    return configuredTimeoutMs;
  }
  return configuredTimeoutMs;
}

function resolveHostAppDataRoot(platform = process.platform, env = process.env, homedir = os.homedir()) {
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support');
  }
  if (platform === 'win32') {
    return env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
  }
  return env.XDG_CONFIG_HOME || path.join(homedir, '.config');
}

function resolveDefaultMcpSessionFile({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  packageMeta
} = {}) {
  if (typeof env.ESTER_MCP_SESSION_FILE === 'string' && env.ESTER_MCP_SESSION_FILE.trim()) {
    return path.resolve(env.ESTER_MCP_SESSION_FILE.trim());
  }
  const meta = packageMeta || require('../../package.json');
  const version = String(meta.version || '2.0.3');
  const revision = typeof meta.sciyueBuildRevision === 'string' && meta.sciyueBuildRevision
    ? `-${meta.sciyueBuildRevision}`
    : '';
  const profileDir = profileForVersion(resolveHostAppDataRoot(platform, env, homedir), `${version}${revision}`);
  return path.join(profileDir, 'mcp-session.json');
}

function safeTokenEquals(expectedToken, providedToken) {
  if (typeof expectedToken !== 'string' || typeof providedToken !== 'string') return false;
  const expectedBuf = Buffer.from(expectedToken, 'utf8');
  const providedBuf = Buffer.from(providedToken, 'utf8');
  if (expectedBuf.length !== providedBuf.length || expectedBuf.length === 0) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

function readJsonRequest(req, maxBytes = MAX_HTTP_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    req.on('data', chunk => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        reject(Object.assign(new Error('MCP bridge request payload too large'), { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = raw ? JSON.parse(raw) : {};
        if (!isPlainObject(parsed)) {
          reject(Object.assign(new Error('Expected JSON object body'), { statusCode: 400, code: 'INVALID_BODY' }));
          return;
        }
        resolve(parsed);
      } catch (error) {
        reject(Object.assign(new Error(`Invalid JSON body: ${error.message}`), { statusCode: 400, code: 'INVALID_JSON' }));
      }
    });

    req.on('error', error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function sendJsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function createMcpLiveHost({
  getTargetWindow,
  getHostStatus,
  focusTargetWindow,
  openLaunchSource,
  closeLaunchSource,
  maxInlineTextBytes = DEFAULT_MAX_INLINE_TEXT_BYTES,
  sessionFilePath,
  host = '127.0.0.1',
  port = 0,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  serverVersion = '2.0.3'
} = {}) {
  if (typeof getTargetWindow !== 'function') {
    throw new Error('createMcpLiveHost requires getTargetWindow function');
  }
  if (typeof getHostStatus !== 'function') {
    throw new Error('createMcpLiveHost requires getHostStatus function');
  }

  const resolvedSessionFile = sessionFilePath
    ? path.resolve(sessionFilePath)
    : resolveDefaultMcpSessionFile();
  const token = crypto.randomBytes(32).toString('hex');
  const pendingFrontendRequests = new Map();
  const customActionHandlers = new Map();
  let httpServer = null;
  let boundPort = null;
  let startedAt = null;
  let disposed = false;

  function registerActionHandler(action, handler) {
    if (typeof action !== 'string' || !action.trim()) {
      throw new Error('Invalid MCP bridge action name');
    }
    if (typeof handler !== 'function') {
      throw new Error(`MCP bridge action "${action}" requires a handler function`);
    }
    customActionHandlers.set(action, handler);
  }

  function requestFrontend(action, payload = {}, options = {}) {
    if (disposed) {
      return Promise.reject(Object.assign(new Error('MCP live host is disposed'), { code: 'MCP_HOST_DISPOSED' }));
    }
    const targetWindow = getTargetWindow(options.windowId);
    if (!targetWindow || targetWindow.isDestroyed?.() || targetWindow.webContents?.isDestroyed?.()) {
      return Promise.reject(Object.assign(new Error('No active Ester Studio workbench window is available'), { code: 'MCP_NO_WORKBENCH_WINDOW' }));
    }

    const ownerId = targetWindow.webContents.id;
    const requestId = crypto.randomUUID();
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : requestTimeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingFrontendRequests.delete(requestId);
        reject(Object.assign(new Error(`Timed out waiting for frontend response to "${action}" (${timeoutMs}ms)`), {
          code: 'MCP_FRONTEND_TIMEOUT'
        }));
      }, timeoutMs);
      timer.unref?.();

      pendingFrontendRequests.set(requestId, {
        requestId,
        ownerId,
        action,
        timer,
        resolve,
        reject
      });

      try {
        targetWindow.webContents.send('sciyue:mcp-frontend-request', {
          requestId,
          action,
          payload: isPlainObject(payload) ? payload : {}
        });
      } catch (error) {
        clearTimeout(timer);
        pendingFrontendRequests.delete(requestId);
        reject(Object.assign(new Error(`Failed to send request to frontend window: ${error.message}`), {
          code: 'MCP_FRONTEND_SEND_FAILED'
        }));
      }
    });
  }

  function handleFrontendReply(ownerId, response) {
    if (!isPlainObject(response) || typeof response.requestId !== 'string' || !response.requestId) {
      throw new Error('Invalid MCP frontend reply payload');
    }
    const pending = pendingFrontendRequests.get(response.requestId);
    if (!pending) {
      return { accepted: false, reason: 'unknown-or-expired-request' };
    }
    if (pending.ownerId !== ownerId) {
      throw new Error('MCP frontend reply sender does not match target window');
    }
    clearTimeout(pending.timer);
    pendingFrontendRequests.delete(response.requestId);

    if (response.ok === false) {
      const errMessage = isPlainObject(response.error) && typeof response.error.message === 'string'
        ? response.error.message
        : 'Frontend rejected MCP request';
      const errCode = isPlainObject(response.error) && typeof response.error.code === 'string'
        ? response.error.code
        : 'MCP_FRONTEND_ERROR';
      const sourceAdopted = isPlainObject(response.error) && response.error.sourceAdopted === true;
      pending.reject(Object.assign(new Error(errMessage), { code: errCode, sourceAdopted }));
    } else {
      pending.resolve(response.result ?? {});
    }
    return { accepted: true };
  }

  function disposeOwner(ownerId) {
    for (const [requestId, pending] of pendingFrontendRequests.entries()) {
      if (pending.ownerId === ownerId) {
        clearTimeout(pending.timer);
        pendingFrontendRequests.delete(requestId);
        pending.reject(Object.assign(new Error('Frontend window closed before completing MCP request'), {
          code: 'MCP_FRONTEND_WINDOW_CLOSED'
        }));
      }
    }
  }

  async function dispatchAction(action, payload = {}) {
    if (typeof action !== 'string' || !action) {
      throw Object.assign(new Error('Missing MCP dispatch action'), { statusCode: 400, code: 'MISSING_ACTION' });
    }

    if (action === 'ping') {
      const hostStatus = await getHostStatus();
      let frontend = { workbenchOnline: false };
      try {
        frontend = await requestFrontend('frontend.ping', payload);
      } catch (error) {
        frontend = {
          workbenchOnline: false,
          reason: error instanceof Error ? error.message : String(error),
          code: error?.code ?? 'MCP_FRONTEND_UNAVAILABLE'
        };
      }
      return {
        desktopConnected: true,
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
        version: serverVersion,
        startedAt,
        ...hostStatus,
        frontend
      };
    }

    if (action === 'status') {
      const hostStatus = await getHostStatus();
      let workbench = { workbenchOnline: false };
      try {
        workbench = await requestFrontend('frontend.status', payload);
      } catch (error) {
        workbench = {
          workbenchOnline: false,
          reason: error instanceof Error ? error.message : String(error),
          code: error?.code ?? 'MCP_FRONTEND_UNAVAILABLE'
        };
      }
      return {
        desktopConnected: true,
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
        version: serverVersion,
        startedAt,
        ...hostStatus,
        workbench
      };
    }

    if (action === 'window-manage') {
      const manageAction = typeof payload.action === 'string' ? payload.action : '';
      if (!manageAction) {
        throw Object.assign(new Error('Missing window-manage action'), {
          statusCode: 400,
          code: 'INVALID_WINDOW_ACTION'
        });
      }
      if (manageAction === 'focus-window') {
        const targetWindow = getTargetWindow(payload.windowId);
        if (!targetWindow || targetWindow.isDestroyed?.() || targetWindow.webContents?.isDestroyed?.()) {
          throw Object.assign(new Error('No active Ester Studio workbench window is available'), {
            statusCode: 404,
            code: 'MCP_NO_WORKBENCH_WINDOW'
          });
        }
        if (typeof focusTargetWindow === 'function') {
          await focusTargetWindow(targetWindow, payload.windowId);
        } else {
          if (targetWindow.isMinimized?.()) targetWindow.restore?.();
          targetWindow.show?.();
          targetWindow.focus?.();
        }
        const workbench = await requestFrontend(
          'frontend.status',
          { includeDocuments: true },
          { windowId: payload.windowId }
        );
        return {
          action: 'focus-window',
          focused: true,
          windowId: targetWindow.webContents.id,
          workbench
        };
      }
      return await requestFrontend('frontend.windowManage', payload, {
        windowId: payload.windowId
      });
    }

    if (action === 'open-file') {
      if (typeof payload.path !== 'string' || !payload.path.trim()) {
        throw Object.assign(new Error('open-file requires a non-empty file path'), {
          statusCode: 400,
          code: 'INVALID_FILE_PATH'
        });
      }
      const resolvedPath = path.resolve(payload.path.trim());
      let stat;
      try {
        stat = await fsPromises.lstat(resolvedPath);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw Object.assign(new Error(`File not found: ${resolvedPath}`), {
            statusCode: 404,
            code: 'MCP_FILE_NOT_FOUND'
          });
        }
        throw Object.assign(new Error(`Cannot access file "${resolvedPath}": ${error.message}`), {
          statusCode: 400,
          code: 'MCP_FILE_ACCESS_ERROR'
        });
      }
      if (stat.isSymbolicLink()) {
        throw Object.assign(new Error(`Symbolic links are not permitted for MCP file import: ${resolvedPath}`), {
          statusCode: 400,
          code: 'MCP_SYMLINK_NOT_ALLOWED'
        });
      }
      if (!stat.isFile()) {
        throw Object.assign(new Error(`Path is not a regular file: ${resolvedPath}`), {
          statusCode: 400,
          code: 'MCP_NOT_REGULAR_FILE'
        });
      }
      if (stat.size <= 0) {
        throw Object.assign(new Error(`File is empty: ${resolvedPath}`), {
          statusCode: 400,
          code: 'MCP_EMPTY_FILE'
        });
      }

      const targetWindow = getTargetWindow(payload.windowId);
      if (!targetWindow || targetWindow.isDestroyed?.() || targetWindow.webContents?.isDestroyed?.()) {
        throw Object.assign(new Error('No active Ester Studio workbench window is available'), {
          statusCode: 404,
          code: 'MCP_NO_WORKBENCH_WINDOW'
        });
      }
      const ownerId = targetWindow.webContents.id;

      let sourceDescriptor = null;
      if (typeof openLaunchSource === 'function') {
        sourceDescriptor = await openLaunchSource(ownerId, resolvedPath);
      }

      let text;
      if (stat.size <= maxInlineTextBytes) {
        try {
          text = await fsPromises.readFile(resolvedPath, 'utf8');
        } catch {
          text = undefined;
        }
      }

      try {
        const frontendResult = await requestFrontend(
          'frontend.openFile',
          {
            path: resolvedPath,
            name: path.basename(resolvedPath),
            size: stat.size,
            ...(text !== undefined ? { text } : {}),
            ...(sourceDescriptor ? { sourceDescriptor } : {}),
            target: payload.target ?? 'auto',
            ...(typeof payload.label === 'string' && payload.label.trim()
              ? { label: payload.label.trim() }
              : {})
          },
          { windowId: payload.windowId }
        );
        return {
          path: resolvedPath,
          fileName: path.basename(resolvedPath),
          byteSize: stat.size,
          ...frontendResult
        };
      } catch (error) {
        if (sourceDescriptor?.token && typeof closeLaunchSource === 'function') {
          await Promise.resolve(closeLaunchSource(ownerId, sourceDescriptor.token)).catch(() => {});
        }
        throw error;
      }
    }

    if (action === 'viewport-camera') {
      const { windowId, ...cameraPayload } = payload;
      return await requestFrontend('frontend.viewportCamera', cameraPayload, {
        windowId
      });
    }

    if (action === 'viewport-screenshot') {
      let resolvedSavePath = null;
      if (payload.savePath !== undefined) {
        if (typeof payload.savePath !== 'string' || !payload.savePath.trim()) {
          throw Object.assign(new Error('savePath must be a non-empty string'), {
            statusCode: 400,
            code: 'INVALID_SAVE_PATH'
          });
        }
        resolvedSavePath = path.resolve(payload.savePath.trim());
        const parentDir = path.dirname(resolvedSavePath);
        let parentStat;
        try {
          parentStat = await fsPromises.lstat(parentDir);
        } catch (error) {
          if (error?.code === 'ENOENT') {
            throw Object.assign(new Error(`Save directory does not exist: ${parentDir}`), {
              statusCode: 400,
              code: 'MCP_SAVE_DIR_NOT_FOUND'
            });
          }
          throw Object.assign(new Error(`Cannot access save directory "${parentDir}": ${error.message}`), {
            statusCode: 400,
            code: 'MCP_FILE_ACCESS_ERROR'
          });
        }
        if (parentStat.isSymbolicLink()) {
          throw Object.assign(new Error(`Symbolic link directory is not permitted for screenshot output: ${parentDir}`), {
            statusCode: 400,
            code: 'MCP_SYMLINK_NOT_ALLOWED'
          });
        }
        if (!parentStat.isDirectory()) {
          throw Object.assign(new Error(`Save parent path is not a directory: ${parentDir}`), {
            statusCode: 400,
            code: 'MCP_INVALID_SAVE_DIR'
          });
        }

        try {
          const targetStat = await fsPromises.lstat(resolvedSavePath);
          if (targetStat.isSymbolicLink()) {
            throw Object.assign(new Error(`Symbolic links are not permitted for screenshot output: ${resolvedSavePath}`), {
              statusCode: 400,
              code: 'MCP_SYMLINK_NOT_ALLOWED'
            });
          }
          if (!targetStat.isFile()) {
            throw Object.assign(new Error(`Screenshot savePath is not a regular file: ${resolvedSavePath}`), {
              statusCode: 400,
              code: 'MCP_NOT_REGULAR_FILE'
            });
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            throw error;
          }
        }
      }

      const { windowId, savePath: _ignoredSavePath, ...screenshotPayload } = payload;
      const frontendResult = await requestFrontend('frontend.viewportScreenshot', screenshotPayload, {
        windowId
      });

      if (!isPlainObject(frontendResult) || typeof frontendResult.base64Png !== 'string' || !frontendResult.base64Png) {
        throw Object.assign(new Error('Frontend did not return screenshot PNG data'), {
          statusCode: 500,
          code: 'MCP_INVALID_SCREENSHOT_DATA'
        });
      }

      const pngBuffer = Buffer.from(frontendResult.base64Png, 'base64');
      if (pngBuffer.length < 8 || !pngBuffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw Object.assign(new Error('Frontend returned invalid PNG binary payload'), {
          statusCode: 500,
          code: 'MCP_INVALID_SCREENSHOT_DATA'
        });
      }

      if (resolvedSavePath) {
        const tempSavePath = `${resolvedSavePath}.${process.pid}.${Date.now()}.tmp`;
        try {
          await fsPromises.writeFile(tempSavePath, pngBuffer);
          await fsPromises.rename(tempSavePath, resolvedSavePath);
        } catch (error) {
          await fsPromises.unlink(tempSavePath).catch(() => {});
          throw Object.assign(new Error(`Failed to write screenshot to "${resolvedSavePath}": ${error.message}`), {
            statusCode: 500,
            code: 'MCP_SCREENSHOT_WRITE_FAILED'
          });
        }
      }

      return {
        ...frontendResult,
        mimeType: 'image/png',
        byteLength: pngBuffer.byteLength,
        ...(resolvedSavePath ? { savedPath: resolvedSavePath } : {})
      };
    }

    if (action === 'structure-info') {
      const { windowId, ...infoPayload } = payload;
      return await requestFrontend('frontend.getStructureInfo', infoPayload, {
        windowId
      });
    }

    if (action === 'measure-geometry') {
      const { windowId, ...measurePayload } = payload;
      return await requestFrontend('frontend.measureGeometry', measurePayload, {
        windowId
      });
    }

    if (action === 'edit-structure') {
      const { windowId, ...editPayload } = payload;
      return await requestFrontend('frontend.editStructure', editPayload, {
        windowId
      });
    }

    if (action === 'set-constraints') {
      const { windowId, ...constraintPayload } = payload;
      return await requestFrontend('frontend.setConstraints', constraintPayload, {
        windowId
      });
    }

    if (action === 'recommend-method') {
      const { windowId, ...recommendPayload } = payload;
      return await requestFrontend('frontend.recommendMethod', recommendPayload, {
        windowId
      });
    }

    if (action === 'configure-calculation') {
      const { windowId, ...configurePayload } = payload;
      return await requestFrontend('frontend.configureCalculation', configurePayload, {
        windowId
      });
    }

    if (action === 'run-local-xtb') {
      const { windowId, ...xtbPayload } = payload;
      return await requestFrontend('frontend.runLocalXtb', xtbPayload, {
        windowId,
        timeoutMs: resolveActionTimeoutMs(action, xtbPayload, requestTimeoutMs)
      });
    }

    if (action === 'submit-task') {
      const { windowId, ...submitPayload } = payload;
      return await requestFrontend('frontend.submitTask', submitPayload, {
        windowId,
        timeoutMs: resolveActionTimeoutMs(action, submitPayload, requestTimeoutMs)
      });
    }

    if (action === 'task-manage') {
      const { windowId, ...managePayload } = payload;
      return await requestFrontend('frontend.taskManage', managePayload, {
        windowId,
        timeoutMs: resolveActionTimeoutMs(action, managePayload, requestTimeoutMs)
      });
    }

    if (action === 'open-result-analysis') {
      const { windowId, ...analysisPayload } = payload;
      const actionTimeoutMs = resolveActionTimeoutMs(action, analysisPayload, requestTimeoutMs);

      if (isPlainObject(analysisPayload.source) && analysisPayload.source.filePath !== undefined) {
        if (typeof analysisPayload.source.filePath !== 'string' || !analysisPayload.source.filePath.trim() || /[\r\n\0]/.test(analysisPayload.source.filePath)) {
          throw Object.assign(new Error('source.filePath must be a non-empty single-line file path'), {
            statusCode: 400,
            code: 'INVALID_FILE_PATH'
          });
        }
        const resolvedPath = path.resolve(analysisPayload.source.filePath.trim());
        let stat;
        try {
          stat = await fsPromises.lstat(resolvedPath);
        } catch (error) {
          if (error?.code === 'ENOENT') {
            throw Object.assign(new Error(`File not found: ${resolvedPath}`), {
              statusCode: 404,
              code: 'MCP_FILE_NOT_FOUND'
            });
          }
          throw Object.assign(new Error(`Cannot access file "${resolvedPath}": ${error.message}`), {
            statusCode: 400,
            code: 'MCP_FILE_ACCESS_ERROR'
          });
        }
        if (stat.isSymbolicLink()) {
          throw Object.assign(new Error(`Symbolic links are not permitted for MCP analysis import: ${resolvedPath}`), {
            statusCode: 400,
            code: 'MCP_SYMLINK_NOT_ALLOWED'
          });
        }
        if (!stat.isFile()) {
          throw Object.assign(new Error(`Path is not a regular file: ${resolvedPath}`), {
            statusCode: 400,
            code: 'MCP_NOT_REGULAR_FILE'
          });
        }
        if (stat.size <= 0) {
          throw Object.assign(new Error(`File is empty: ${resolvedPath}`), {
            statusCode: 400,
            code: 'MCP_EMPTY_FILE'
          });
        }

        const targetWindow = getTargetWindow(windowId);
        if (!targetWindow || targetWindow.isDestroyed?.() || targetWindow.webContents?.isDestroyed?.()) {
          throw Object.assign(new Error('No active Ester Studio workbench window is available'), {
            statusCode: 404,
            code: 'MCP_NO_WORKBENCH_WINDOW'
          });
        }
        const ownerId = targetWindow.webContents.id;

        let sourceDescriptor = null;
        if (typeof openLaunchSource === 'function') {
          sourceDescriptor = await openLaunchSource(ownerId, resolvedPath);
        }

        let text;
        if (stat.size <= maxInlineTextBytes) {
          try {
            text = await fsPromises.readFile(resolvedPath, 'utf8');
          } catch {
            text = undefined;
          }
        }

        try {
          const frontendResult = await requestFrontend(
            'frontend.openResultAnalysis',
            {
              ...analysisPayload,
              source: {
                filePath: resolvedPath,
                name: path.basename(resolvedPath),
                size: stat.size,
                ...(text !== undefined ? { text } : {}),
                ...(sourceDescriptor ? { sourceDescriptor } : {})
              }
            },
            {
              windowId,
              timeoutMs: actionTimeoutMs
            }
          );
          return {
            sourcePath: resolvedPath,
            fileName: path.basename(resolvedPath),
            byteSize: stat.size,
            ...frontendResult
          };
        } catch (error) {
          if (!error?.sourceAdopted && sourceDescriptor?.token && typeof closeLaunchSource === 'function') {
            await Promise.resolve(closeLaunchSource(ownerId, sourceDescriptor.token)).catch(() => {});
          }
          throw error;
        }
      }

      return await requestFrontend('frontend.openResultAnalysis', analysisPayload, {
        windowId,
        timeoutMs: actionTimeoutMs
      });
    }

    if (action === 'run-wavefunction-analysis') {
      const { windowId, ...wfPayload } = payload;
      return await requestFrontend('frontend.runWavefunctionAnalysis', wfPayload, {
        windowId,
        timeoutMs: resolveActionTimeoutMs(action, wfPayload, requestTimeoutMs)
      });
    }

    if (action === 'export-artifact') {
      if (typeof payload.outputPath !== 'string' || !payload.outputPath.trim() || /[\r\n\0]/.test(payload.outputPath)) {
        throw Object.assign(new Error('outputPath must be a non-empty single-line string'), {
          statusCode: 400,
          code: 'INVALID_OUTPUT_PATH'
        });
      }
      const resolvedOutputPath = path.resolve(payload.outputPath.trim());
      const overwrite = payload.overwrite !== false;

      const verifyExportPathSafety = async () => {
        const parentDir = path.dirname(resolvedOutputPath);
        let parentStat;
        try {
          parentStat = await fsPromises.lstat(parentDir);
        } catch (error) {
          if (error?.code === 'ENOENT') {
            throw Object.assign(new Error(`Export directory does not exist: ${parentDir}`), {
              statusCode: 400,
              code: 'MCP_SAVE_DIR_NOT_FOUND'
            });
          }
          throw Object.assign(new Error(`Cannot access export directory "${parentDir}": ${error.message}`), {
            statusCode: 400,
            code: 'MCP_FILE_ACCESS_ERROR'
          });
        }
        if (parentStat.isSymbolicLink()) {
          throw Object.assign(new Error(`Symbolic link directory is not permitted for artifact export: ${parentDir}`), {
            statusCode: 400,
            code: 'MCP_SYMLINK_NOT_ALLOWED'
          });
        }
        if (!parentStat.isDirectory()) {
          throw Object.assign(new Error(`Export parent path is not a directory: ${parentDir}`), {
            statusCode: 400,
            code: 'MCP_INVALID_SAVE_DIR'
          });
        }

        try {
          const targetStat = await fsPromises.lstat(resolvedOutputPath);
          if (targetStat.isSymbolicLink()) {
            throw Object.assign(new Error(`Symbolic links are not permitted for artifact export: ${resolvedOutputPath}`), {
              statusCode: 400,
              code: 'MCP_SYMLINK_NOT_ALLOWED'
            });
          }
          if (!targetStat.isFile()) {
            throw Object.assign(new Error(`Export outputPath is not a regular file: ${resolvedOutputPath}`), {
              statusCode: 400,
              code: 'MCP_NOT_REGULAR_FILE'
            });
          }
          if (!overwrite) {
            throw Object.assign(new Error(`Export file already exists and overwrite is false: ${resolvedOutputPath}`), {
              statusCode: 409,
              code: 'MCP_FILE_ALREADY_EXISTS'
            });
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            throw error;
          }
        }
      };

      await verifyExportPathSafety();

      const { windowId, overwrite: _ignoredOverwrite, ...exportPayload } = payload;
      const frontendResult = await requestFrontend(
        'frontend.exportArtifact',
        {
          ...exportPayload,
          outputPath: resolvedOutputPath
        },
        {
          windowId,
          timeoutMs: resolveActionTimeoutMs(action, exportPayload, requestTimeoutMs)
        }
      );

      if (!isPlainObject(frontendResult) || typeof frontendResult.content !== 'string' || !frontendResult.content.length) {
        throw Object.assign(new Error('Frontend did not return valid text content for artifact export'), {
          statusCode: 500,
          code: 'MCP_INVALID_EXPORT_DATA'
        });
      }

      const contentBuffer = Buffer.from(frontendResult.content, 'utf8');
      if (contentBuffer.byteLength > MAX_EXPORT_TEXT_BYTES) {
        throw Object.assign(new Error(`Export payload exceeds maximum size (${MAX_EXPORT_TEXT_BYTES} bytes)`), {
          statusCode: 413,
          code: 'MCP_EXPORT_TOO_LARGE'
        });
      }

      await verifyExportPathSafety();

      if (!overwrite) {
        try {
          await fsPromises.writeFile(resolvedOutputPath, contentBuffer, { flag: 'wx' });
        } catch (error) {
          if (error?.code === 'EEXIST') {
            throw Object.assign(new Error(`Export file already exists and overwrite is false: ${resolvedOutputPath}`), {
              statusCode: 409,
              code: 'MCP_FILE_ALREADY_EXISTS'
            });
          }
          throw Object.assign(new Error(`Failed to write exported artifact to "${resolvedOutputPath}": ${error.message}`), {
            statusCode: 500,
            code: 'MCP_EXPORT_WRITE_FAILED'
          });
        }
      } else {
        const tempSavePath = `${resolvedOutputPath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        try {
          await fsPromises.writeFile(tempSavePath, contentBuffer);
          await fsPromises.rename(tempSavePath, resolvedOutputPath);
        } catch (error) {
          await fsPromises.unlink(tempSavePath).catch(() => {});
          throw Object.assign(new Error(`Failed to write exported artifact to "${resolvedOutputPath}": ${error.message}`), {
            statusCode: 500,
            code: 'MCP_EXPORT_WRITE_FAILED'
          });
        }
      }

      const { content, ...metadata } = frontendResult;
      const normalizedLines = content.endsWith('\n')
        ? content.slice(0, -1).split('\n').length
        : content.split('\n').length;
      const preview = content.length <= 2048 ? content : `${content.slice(0, 2048)}\n... [truncated]`;
      return {
        ...metadata,
        savedPath: resolvedOutputPath,
        byteLength: contentBuffer.byteLength,
        lineCount: normalizedLines,
        preview
      };
    }

    if (customActionHandlers.has(action)) {
      const handler = customActionHandlers.get(action);
      return await handler(payload, { requestFrontend, getHostStatus });
    }

    if (action.startsWith('frontend.')) {
      return await requestFrontend(action, payload);
    }

    throw Object.assign(new Error(`Unsupported MCP bridge action: ${action}`), {
      statusCode: 404,
      code: 'UNSUPPORTED_MCP_ACTION'
    });
  }

  async function writeSessionFile(sessionInfo) {
    await fsPromises.mkdir(path.dirname(resolvedSessionFile), { recursive: true });
    const tempFile = `${resolvedSessionFile}.${process.pid}.${Date.now()}.tmp`;
    const content = JSON.stringify(sessionInfo, null, 2);
    await fsPromises.writeFile(tempFile, content, { encoding: 'utf8', mode: 0o600 });
    await fsPromises.rename(tempFile, resolvedSessionFile);
  }

  function removeSessionFileSyncIfOwned() {
    try {
      if (!fs.existsSync(resolvedSessionFile)) return;
      const raw = fs.readFileSync(resolvedSessionFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.token === token && parsed.pid === process.pid) {
        fs.unlinkSync(resolvedSessionFile);
      }
    } catch {
      // Ignore cleanup errors during shutdown
    }
  }

  async function start() {
    if (disposed) {
      throw new Error('Cannot start a disposed MCP live host');
    }
    if (httpServer) {
      return getSessionInfo();
    }

    startedAt = new Date().toISOString();
    const server = http.createServer(async (req, res) => {
      try {
        const authHeader = req.headers.authorization || '';
        const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
        if (!match || !safeTokenEquals(token, match[1])) {
          sendJsonResponse(res, 401, {
            ok: false,
            error: {
              code: 'MCP_UNAUTHORIZED',
              message: 'Invalid or missing MCP session token'
            }
          });
          return;
        }

        if (req.method !== 'POST' || req.url !== '/mcp/dispatch') {
          sendJsonResponse(res, 404, {
            ok: false,
            error: {
              code: 'MCP_NOT_FOUND',
              message: 'Expected POST /mcp/dispatch'
            }
          });
          return;
        }

        const body = await readJsonRequest(req);
        const result = await dispatchAction(body.action, isPlainObject(body.payload) ? body.payload : {});
        sendJsonResponse(res, 200, {
          ok: true,
          result
        });
      } catch (error) {
        const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        sendJsonResponse(res, statusCode, {
          ok: false,
          error: {
            code: error?.code ?? 'MCP_BRIDGE_ERROR',
            message: error instanceof Error ? error.message : String(error)
          }
        });
      }
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    httpServer = server;
    const address = server.address();
    boundPort = typeof address === 'object' && address ? address.port : port;

    const sessionInfo = getSessionInfo();
    await writeSessionFile(sessionInfo);
    return sessionInfo;
  }

  function getSessionInfo() {
    if (!httpServer || !boundPort) return null;
    return {
      schema: SESSION_SCHEMA,
      host,
      port: boundPort,
      token,
      pid: process.pid,
      version: serverVersion,
      startedAt,
      sessionFilePath: resolvedSessionFile
    };
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;

    for (const [requestId, pending] of pendingFrontendRequests.entries()) {
      clearTimeout(pending.timer);
      pendingFrontendRequests.delete(requestId);
      pending.reject(Object.assign(new Error('MCP live host shutting down'), { code: 'MCP_HOST_SHUTDOWN' }));
    }

    removeSessionFileSyncIfOwned();

    if (httpServer) {
      const serverToClose = httpServer;
      httpServer = null;
      boundPort = null;
      await new Promise(resolve => {
        serverToClose.close(() => resolve());
      });
    }
  }

  return Object.freeze({
    start,
    dispose,
    disposeOwner,
    requestFrontend,
    handleFrontendReply,
    registerActionHandler,
    dispatchAction,
    getSessionInfo,
    sessionFilePath: resolvedSessionFile
  });
}

function sendHttpRequest({ host, port, token, pathName = '/mcp/dispatch', body, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: host,
        port,
        path: pathName,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${token}`
        },
        timeout: timeoutMs
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            const parsed = raw ? JSON.parse(raw) : {};
            resolve({
              statusCode: res.statusCode ?? 500,
              body: parsed
            });
          } catch (error) {
            reject(Object.assign(new Error(`Invalid JSON response from MCP live host: ${error.message}`), {
              code: 'MCP_INVALID_HOST_RESPONSE'
            }));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(Object.assign(new Error(`MCP live host request timed out after ${timeoutMs}ms`), {
        code: 'MCP_HOST_TIMEOUT'
      }));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function createMcpLiveClient({
  sessionFilePath,
  resolveSessionFile,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
} = {}) {
  function currentSessionFilePath() {
    if (typeof resolveSessionFile === 'function') {
      return resolveSessionFile();
    }
    if (typeof sessionFilePath === 'string' && sessionFilePath.trim()) {
      return path.resolve(sessionFilePath.trim());
    }
    return resolveDefaultMcpSessionFile();
  }

  async function readSession() {
    const filePath = currentSessionFilePath();
    const raw = await fsPromises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      !isPlainObject(parsed) ||
      parsed.schema !== SESSION_SCHEMA ||
      typeof parsed.host !== 'string' ||
      !Number.isInteger(parsed.port) ||
      parsed.port <= 0 ||
      typeof parsed.token !== 'string' ||
      !parsed.token
    ) {
      throw Object.assign(new Error(`Invalid MCP session file at ${filePath}`), {
        code: 'MCP_INVALID_SESSION_FILE'
      });
    }
    return {
      ...parsed,
      sessionFilePath: filePath
    };
  }

  function buildOfflineResult(action, error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (action === 'ping') {
      return {
        desktopConnected: false,
        sessionFilePath: currentSessionFilePath(),
        reason,
        frontend: {
          workbenchOnline: false
        }
      };
    }
    return {
      desktopConnected: false,
      sessionFilePath: currentSessionFilePath(),
      reason,
      workbench: {
        workbenchOnline: false
      }
    };
  }

  async function dispatch(action, payload = {}) {
    let session;
    try {
      session = await readSession();
    } catch (error) {
      if (action === 'ping' || action === 'status') {
        return buildOfflineResult(action, error);
      }
      throw Object.assign(
        new Error(`Ester Studio desktop is not running or MCP session file is unavailable (${error.message})`),
        { code: 'MCP_DESKTOP_OFFLINE' }
      );
    }

    let response;
    try {
      response = await sendHttpRequest({
        host: session.host,
        port: session.port,
        token: session.token,
        body: { action, payload },
        timeoutMs: resolveActionTimeoutMs(action, payload, timeoutMs, { isClient: true })
      });
    } catch (error) {
      if (
        (action === 'ping' || action === 'status') &&
        (error?.code === 'ECONNREFUSED' || error?.code === 'ECONNRESET' || error?.code === 'ENOENT')
      ) {
        return buildOfflineResult(action, error);
      }
      throw Object.assign(
        new Error(`Failed to reach Ester Studio desktop MCP bridge: ${error.message}`),
        { code: error?.code ?? 'MCP_DESKTOP_OFFLINE' }
      );
    }

    if (response.statusCode !== 200 || !response.body || response.body.ok !== true) {
      const errCode = response.body?.error?.code ?? 'MCP_BRIDGE_ERROR';
      const errMessage = response.body?.error?.message ?? `MCP bridge HTTP ${response.statusCode}`;
      throw Object.assign(new Error(errMessage), { code: errCode, statusCode: response.statusCode });
    }

    return response.body.result;
  }

  return Object.freeze({
    dispatch,
    readSession,
    getSessionFilePath: currentSessionFilePath
  });
}

module.exports = {
  SESSION_SCHEMA,
  resolveHostAppDataRoot,
  resolveDefaultMcpSessionFile,
  resolveActionTimeoutMs,
  safeTokenEquals,
  createMcpLiveHost,
  createMcpLiveClient
};
