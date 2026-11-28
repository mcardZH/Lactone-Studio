'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createBinaryExportStore } = require('./binary-export-store.cjs');
const { atomicWriteStream, currentStreamFile, describeFile, fileChunks } = require('./stream-file-publication.cjs');
const { checkDirectory, directoryIdentity } = require('./portable-storage.cjs');
const { harnessExportDirectory, harnessWorkDirectory } = require('./portable-export.cjs');
const { isProjectIndexPath } = require('./sy-project-store.cjs');
const { isRecord, failure } = require('./mcp/wire.cjs');
const { structureSource } = require('./mcp/structure-source.cjs');

const sourceTools = new Set(['es_import', 'source_attach', 'job_preview', 'job_resubmit_plan', 'job_environment_transfer', 'input_assets']);
const destinationTools = new Set(['es_export', 'plot_export', 'view_export', 'input_generate', 'input_save', 'citation_export', 'trajectory_derive', 'trajectory_export', 'analysis_export', 'job_environment_transfer']);
const directoryTools = new Set(['input_generate', 'input_save', 'input_batch', 'trajectory_derive']);
const singleFileDirectoryTools = new Set(['es_export', 'plot_export', 'view_export', 'trajectory_export', 'analysis_export']);
const saveTools = new Set(['es_export', 'input_save', 'file_write_text']);
const batchActions = new Set(['es_project', 'file_write_text', 'file_list', 'file_inspect', 'job_file_export', 'structure_source', ...sourceTools, ...destinationTools, ...directoryTools]);
const fieldsByAction = {
  sources: [], 'structure-source': [], 'list-files': [], 'inspect-file': [], new: [], open: [], 'open-status': [], recover: [], close: [], 'save-location': [],
  write: ['name', 'fileName', 'group', 'bytes'],
  'export-group': ['names', 'group'],
  'write-text': [],
  'task-file-copy': [],
  'write-export': ['assetId', 'fileName'],
  'write-analysis': ['assetId', 'domainAssetId', 'fileName'],
  'capture-workbench': ['rect'],
};
const maxPreviewBytes = 65536;

function location(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw failure('invalid_path', '需要绝对文件路径。');
  // Normalize the Win32 extended path syntax before comparison with protected roots.
  if (process.platform === 'win32') {
    const slashes = value.replaceAll('/', '\\');
    if (/^\\\\\?\\UNC\\/i.test(slashes)) value = '\\\\' + slashes.slice(8);
    else if (/^\\\\\?\\[A-Za-z]:\\/.test(slashes)) value = slashes.slice(4);
    else if (/^\\\\[.?]\\/.test(slashes)) throw failure('invalid_path', '请选择普通 Windows 文件路径。');
    if (!/^(?:[A-Z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))/i.test(value.replaceAll('/', '\\'))) {
      throw failure('invalid_path', '需要包含盘符或共享位置的绝对文件路径。');
    }
  }
  if (!path.isAbsolute(value)) throw failure('invalid_path', '需要绝对文件路径。');
  return path.resolve(value);
}

function leafName(value) {
  if (typeof value !== 'string' || !value || /[\\/<>:"|?*\x00-\x1f]|[. ]$/.test(value) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value)) {
    throw failure('invalid_file_name', '需要单个合法的导出文件名。');
  }
  return value;
}

async function listFiles(args, active) {
  const directory = location(args.directory);
  const { cursor = 0, limit = 100, query = '', extension: filter } = args;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || typeof query !== 'string') {
    throw failure('invalid_file_list_options', '请提供有效文件名查询、列表页大小及游标。');
  }
  const extension = typeof filter === 'string' ? filter.trim().replace(/^\./, '').toLowerCase() : '';
  if (filter !== undefined && (!extension || /[./\\\0]/.test(extension))) {
    throw failure('invalid_file_extension', '请指定单个扩展名，例如 out 或 .out。');
  }
  const parent = await directoryIdentity(directory);
  active();
  const term = query.toLowerCase();
  const candidates = (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() &&
    (!extension || path.extname(entry.name).toLowerCase() === '.' + extension) && entry.name.toLowerCase().includes(term))
    .map(entry => entry.name).sort();
  const items = [], issues = [];
  for (const name of candidates.slice(cursor, cursor + limit)) {
    active();
    const file = path.join(directory, name);
    try {
      const selected = await fs.lstat(file);
      if (!selected.isFile() || selected.isSymbolicLink()) throw failure('source_changed', '列表项目已变化，请重新列出。');
      items.push({ name, path: file, bytes: selected.size });
    } catch (error) {
      issues.push({ name, code: error.code ?? 'source_unavailable', message: error.message });
    }
  }
  await checkDirectory(directory, parent);
  active();
  const total = candidates.length;
  return { status: issues.length ? 'partial' : 'listed', directory, items, total,
    nextCursor: cursor + limit < total ? cursor + limit : null, ...(issues.length ? { issues } : {}) };
}

async function inspectFile(args, owner, active, signal, launchSources) {
  const file = location(args.path);
  const { headBytes = 0, tailBytes = 0, sha256 = false } = args;
  if ([headBytes, tailBytes].some(bytes => !Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxPreviewBytes) || typeof sha256 !== 'boolean') {
    throw failure('invalid_file_inspection', `请将文本预览范围指定为 0 至 ${maxPreviewBytes} 字节，sha256 使用布尔值。`);
  }
  const selected = await fs.lstat(file);
  if (!selected.isFile() || selected.isSymbolicLink()) throw failure('invalid_source', '请选择普通文件。');
  active();
  const [{ token, name, size }] = await launchSources.open(owner, [file]);
  try {
    active();
    const preview = async (start, end) => {
      const bytes = await launchSources.read(owner, token, start, end);
      active();
      return { start, end, text: new TextDecoder('utf-8').decode(bytes) };
    };
    const head = headBytes ? await preview(0, Math.min(headBytes, size)) : undefined;
    const tail = tailBytes ? await preview(Math.max(0, size - tailBytes), size) : undefined;
    const checksum = sha256 ? await launchSources.describe(owner, token, { signal }) : undefined;
    active();
    return { status: 'inspected', name, path: file, bytes: size, ...(head ? { head } : {}), ...(tail ? { tail } : {}),
      ...(checksum ? { sha256: checksum.revision } : {}) };
  } finally { await launchSources.close(owner, token); }
}

function authorizedOperation(request, spec) {
  if (request.name !== 'batch_apply') {
    if (spec.batchIndex !== undefined) throw failure('invalid_batch_member', '当前调用不是批次。');
    return request;
  }
  const { action, items, commonOptions } = request.arguments;
  const index = spec.batchIndex;
  if (!batchActions.has(action) || !Array.isArray(items) || !Number.isSafeInteger(index) || index < 0 ||
      !isRecord(items[index]) || (commonOptions !== undefined && !isRecord(commonOptions))) {
    throw failure('invalid_batch_member', '文件操作需要本次批次中有效的成员编号及具名参数。');
  }
  return { name: action, arguments: { ...commonOptions, ...items[index] } };
}

function sourceLocations(name, args) {
  if (name === 'job_environment_transfer') {
    if (!['preview-import', 'import'].includes(args.action)) throw failure('file_action_not_authorized', '当前环境操作没有请求读取文件。');
    return [location(args.path)];
  }
  if (name === 'input_assets') {
    if (args.action !== 'import') throw failure('file_action_not_authorized', '当前输入资产操作没有授权读取文件。');
    return [location(args.path)];
  }
  if (name === 'job_preview' || name === 'job_resubmit_plan') {
    const dependencies = args.dependencies ?? [];
    if (!Array.isArray(dependencies)) throw failure('invalid_source', '请提供作业依赖清单。');
    const paths = [];
    if (args.input?.path !== undefined) {
      if (args.input.text !== undefined) throw failure('invalid_source', '作业输入须指定一种内容来源。');
      paths.push(location(args.input.path));
    }
    for (const row of dependencies) {
      if (!isRecord(row) || (typeof row.text === 'string') === (typeof row.path === 'string')) {
        throw failure('invalid_source', '每份作业依赖须指定一种内容来源。');
      }
      if (typeof row.path === 'string') paths.push(location(row.path));
    }
    return paths;
  }
  const items = name === 'source_attach' ? [args.asset] : args.items;
  if (!Array.isArray(items) || !items.length) throw failure('invalid_source', '请选择导入来源。');
  return items.map(item => location(typeof item === 'string' ? item : item?.path));
}

function destinationFor(name, args, spec) {
  if (args.onExists !== undefined && !['error', 'conflict', 'overwrite'].includes(args.onExists)) {
    throw failure('invalid_disposition', '导出冲突处理参数无效。');
  }
  if (spec.name !== undefined) {
    if (!directoryTools.has(name) || args.destination !== undefined) throw failure('destination_not_authorized', '本次操作未授权目录内生成文件。');
    const filename = leafName(spec.name);
    if (name === 'input_save' && args.fileName !== undefined && filename !== args.fileName) {
      throw failure('destination_not_authorized', '导出文件名与本次选中的输入不符。');
    }
    return args.directory === undefined ? undefined : path.join(location(args.directory), filename);
  }
  if (args.directory !== undefined && args.destination === undefined && singleFileDirectoryTools.has(name)) {
    return path.join(location(args.directory), leafName(spec.fileName));
  }
  if (!destinationTools.has(name) || args.directory !== undefined) {
    throw failure('destination_not_authorized', '本次操作未授权单文件目标。');
  }
  return args.destination === undefined ? undefined : location(args.destination);
}

function numberedName(name, number) {
  if (number === 1) return name;
  const extension = path.extname(name);
  return name.slice(0, name.length - extension.length) + '-' + number + extension;
}

function portableWriteError(error, destination, isDefault) {
  const permission = ['EACCES', 'EPERM', 'EROFS'].includes(error.code);
  if (!isDefault && !permission) return error;
  const message = permission ? '保存位置没有写入权限，请选择其他目录。' : error.message;
  return failure(permission ? 'destination_not_writable' : error.code ?? 'export_failed', message, {
    ...error.data, path: destination, reason: error.code, nextAction: 'choose-explicit-destination',
  });
}

async function publicationReceipt(error, destination, isDefault, companions = []) {
  if (!error.publicationPerformed && !error.publishedFiles?.length) throw portableWriteError(error, destination, isDefault);
  const knownMembers = error.publishedFiles ?? [{ path: destination }];
  const publishedFiles = await Promise.all(knownMembers.map(async member => {
    try {
      const actual = await currentStreamFile(member.path);
      return { path: member.path, present: !!actual, ...(actual ? { bytes: actual.bytesLength, sha256: actual.sha256 } : {}),
        ...(member.sha256 ? { verified: !!actual && actual.sha256 === member.sha256 && (member.bytes === undefined || actual.bytesLength === member.bytes) } : {}),
        ...(member.sha256 ? { expectedSha256: member.sha256 } : {}) };
    } catch (cause) {
      return { ...member, verified: false, verificationError: cause.code ?? 'read_failed' };
    }
  }));
  return { status: 'publication_unconfirmed', path: destination, publicationPerformed: true, publishedFiles,
    requestedFiles: [destination, ...companions.map(suffix => destination + suffix)],
    warning: { code: error.code ?? 'export_confirmation_failed', message: error.message,
      ...(error.data?.cleanupWarning ? { cleanupWarning: error.data.cleanupWarning } : {}),
      ...(error.temporaryCleanupFailed ? { cleanupPending: true } : {}) } };
}

function createMcpFiles({ assertRequest, launchSources, projectIPC, createWindow, publicTarget, requestClose, assertDestination, takeBinaryAsset, saveAnalysisCube, copyTaskFile, fetchStructureSource, bundleRoot = () => undefined }) {
  const reserved = new Set();
  const groups = new WeakMap();
  const groupKey = spec => `${spec.batchIndex ?? ''}:${spec.group ?? ''}`;
  function reportOpen(indexPath, row, alreadyOpen = false) {
    if (!row) return { status: 'not-tracked', path: indexPath };
    const { ownerId, requestId, status, error } = row;
    return { ...publicTarget(ownerId), status: alreadyOpen && status === 'loaded' ? 'already-open' : status,
      path: indexPath, ...(requestId ? { openRequestId: requestId } : {}), ...(error ? { error } : {}),
      ...(['queued', 'loading'].includes(status) ? { nextAction: { action: 'open-status', path: indexPath } } : {}),
      ...(['failed', 'cancelled'].includes(status) ? { nextAction: { action: 'open', path: indexPath, retry: true } } : {}) };
  }
  function permitsDefault(name, args) {
    if (saveTools.has(name) || args.save === true) return;
    throw failure('destination_not_authorized', '请指定绝对保存位置，或使用 save:true 保存到随包目录。');
  }
  function table(signal) {
    if (!groups.has(signal)) groups.set(signal, new Map());
    return groups.get(signal);
  }
  async function planGroup(name, args, spec, active) {
    if (!directoryTools.has(name) || args.destination !== undefined || args.directory !== undefined ||
        !Array.isArray(spec.names) || !spec.names.length) {
      throw failure('destination_not_authorized', '当前操作不能规划随包文件组。');
    }
    permitsDefault(name, args);
    const names = spec.names.map(leafName);
    if (args.fileName !== undefined && (names[0] !== args.fileName || (name !== 'input_generate' && names.length !== 1))) {
      throw failure('destination_not_authorized', '导出文件组和选中的输入不符。');
    }
    if (new Set(names.map(name => name.toLowerCase())).size !== names.length) {
      throw failure('invalid_file_name', '同一文件组需要不同的文件名。');
    }
    const plans = table(active().signal), key = groupKey(spec), previous = plans.get(key);
    if (previous) {
      if (JSON.stringify(previous.names) === JSON.stringify(names)) return { directory: previous.directory };
      throw failure('destination_not_authorized', '本次输出组已规划，无法更换成员。');
    }
    const parent = await harnessExportDirectory(bundleRoot()), parentIdentity = await directoryIdentity(parent);
    let directory = parent;
    if (names.length > 1) {
      // Keep original names and relative companion references within a group.
      const stem = path.parse(names[0]).name;
      for (let number = 1;; number++) {
        directory = path.join(parent, number === 1 ? stem : stem + '-' + number);
        try {
          active();
          assertDestination(path.join(directory, names[0]));
          await fs.mkdir(directory);
          if (await directoryIdentity(parent) !== parentIdentity) throw failure('destination_changed', '随包导出目录已变化。');
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw portableWriteError(error, directory, true);
        }
      }
    }
    plans.set(key, { names, directory, identity: await directoryIdentity(directory) });
    return { directory };
  }
  async function publish(name, args, spec, active, write, { companions = [] } = {}) {
    const explicit = name === 'file_write_text'
      ? args.destination === undefined ? undefined : location(args.destination)
      : destinationFor(name, args, spec);
    if (explicit !== undefined) {
      try { return await write(explicit, args.onExists === 'overwrite'); }
      catch (error) { return publicationReceipt(error, explicit, false, companions); }
    }
    permitsDefault(name, args);
    const filename = leafName(name === 'file_write_text' ? args.fileName : spec.name ?? spec.fileName);
    const signal = active().signal;
    const plan = signal && groups.get(signal)?.get(groupKey(spec));
    if (plan && !plan.names.includes(filename)) throw failure('destination_not_authorized', '文件未列入本次输出组。');
    const directory = plan?.directory ?? await (name === 'file_write_text' ? harnessWorkDirectory : harnessExportDirectory)(bundleRoot());
    const identity = await directoryIdentity(directory);
    if (plan && identity !== plan.identity) throw failure('destination_changed', '随包导出目录已变化。', { path: directory });
    const exists = async file => {
      try { await fs.lstat(file); return true; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    };
    const grouped = plan?.names.length > 1;
    for (let number = 1;; number++) {
      const destination = path.join(directory, numberedName(filename, number));
      const candidates = [destination, ...companions.map(suffix => destination + suffix)];
      const keys = candidates.map(file => file.toLowerCase());
      try {
        active();
        candidates.forEach(assertDestination);
        if ((await Promise.all(candidates.map(exists))).some(Boolean) || keys.some(key => reserved.has(key))) {
          if (grouped) throw failure('destination_conflict', '输出组的文件已存在。');
          continue;
        }
        // Claims are synchronous following the last await, for other requests in this host.
        keys.forEach(key => reserved.add(key));
        try {
          if (await directoryIdentity(directory) !== identity) throw failure('destination_changed', '随包导出目录已变化。');
          return await write(destination, false);
        } finally { keys.forEach(key => reserved.delete(key)); }
      } catch (error) { return publicationReceipt(error, destination, true, companions); }
    }
  }

  async function writeBytes(owner, bytes, destination, overwrite, active, extension) {
    let receipt, cause;
    const store = createBinaryExportStore({
      chooseDestination: async () => ({ path: destination, overwriteConfirmed: overwrite }),
      assertDestination, ownerAlive: active,
    });
    try {
      const { token } = await store.begin(owner, { name: path.basename(destination), extension });
      const chunk = 1024 * 1024;
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        await store.append(owner, token, bytes.subarray(offset, offset + chunk));
      }
      receipt = { ...await store.commit(owner, token), path: destination };
    } catch (error) {
      cause = error;
      if (error.publicationPerformed) error.publishedFiles = [{
        path: destination, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      }];
    }
    try { await store.dispose(); }
    catch (error) {
      if (!cause) return { ...receipt, warning: { code: 'export_cleanup_pending', message: error.message } };
      cause.temporaryCleanupFailed = true;
    }
    if (cause) throw cause;
    return receipt;
  }

  async function writeSealed(owner, assetId, destination, overwrite, active) {
    if (typeof assetId !== 'string' || !assetId) throw failure('invalid_export_asset', '导出需要完整的 ES 二进制资源。');
    assertDestination(destination);
    const parent = await directoryIdentity(path.dirname(destination));
    const previous = await currentStreamFile(destination);
    if (previous && !overwrite) throw failure('destination_conflict', '目标文件已存在，请明确选择覆盖或其他文件。', { path: destination });
    active();
    const lease = await takeBinaryAsset(owner, assetId);
    let receipt, cause;
    try {
      const source = await describeFile(lease.path);
      if (source.parent !== lease.parent || source.bytesLength !== lease.bytesLength) {
        throw failure('export_asset_changed', '导出资源在接管时发生变化。');
      }
      active();
      async function* chunks() {
        for await (const chunk of fileChunks(source)) { active(); yield chunk; }
        active();
      }
      const saved = await atomicWriteStream(destination, { ...source, sha256: lease.sha256, chunks: chunks() }, previous, parent);
      receipt = { written: true, path: destination, bytes: saved.bytesLength, sha256: saved.sha256 };
    } catch (error) {
      cause = error;
      if (error.publicationPerformed) error.publishedFiles = [{ path: destination, bytes: lease.bytesLength, sha256: lease.sha256 }];
    }
    try { await lease.close(); }
    catch (error) {
      if (!cause) return { ...receipt, warning: { code: 'export_asset_release_pending', message: error.message } };
      cause.data = { ...cause.data, cleanupWarning: { code: 'export_asset_release_pending', message: error.message } };
    }
    if (cause) throw cause;
    return receipt;
  }
  async function openImportItems(owner, items, active) {
    if (!Array.isArray(items) || !items.length) throw failure('invalid_source', '请选择导入来源。');
    const results = [], retained = [];
    try {
      for (const [index, item] of items.entries()) {
        active();
        if (isRecord(item) && typeof item.text === 'string' && !Object.hasOwn(item, 'path')) continue;
        try {
          if (isRecord(item) && Object.hasOwn(item, 'text')) throw failure('invalid_source', '路径与结构正文须为独立导入成员。');
          const file = location(typeof item === 'string' ? item : item?.path);
          const [source] = await launchSources.open(owner, [file]);
          retained.push(source);
          results.push({ index, source });
        } catch (error) {
          active();
          results.push({ index, error: error.message, code: error.code ?? 'source_unavailable' });
        }
      }
      active();
      return { items: results };
    } catch (error) {
      await Promise.allSettled(retained.map(source => launchSources.close(owner, source.token)));
      throw error;
    }
  }

  async function invoke(window, spec) {
    if (!isRecord(spec) || typeof spec.action !== 'string' || !Object.hasOwn(fieldsByAction, spec.action) ||
        Object.keys(spec).some(key => !['requestId', 'action', 'batchIndex', ...fieldsByAction[spec.action]].includes(key)) ||
        (spec.group !== undefined && (typeof spec.group !== 'string' || !/^[\w.-]{1,80}$/.test(spec.group)))) {
      throw failure('invalid_file_request', '无效的 ES 文件操作。');
    }
    const owner = window.webContents.id;
    const active = () => assertRequest(owner, spec.requestId);
    const request = active();
    const { name, arguments: args } = authorizedOperation(request, spec);
    if (spec.action === 'list-files' && name === 'file_list') return listFiles(args, active);
    if (spec.action === 'inspect-file' && name === 'file_inspect') return inspectFile(args, owner, active, request.signal, launchSources);
    if (spec.action === 'capture-workbench' && name === 'view_export' && ['workbench', 'analysis-panel'].includes(args.scope)) {
      const contents = window.webContents;
      if (!window.isVisible() || window.isMinimized()) throw failure('workbench_capture_unavailable', '请先显示已连接的 ES 工作台。');
      let rect;
      if (args.scope === 'analysis-panel') {
        const bounds = spec.rect, factor = contents.getZoomFactor(), content = window.getContentBounds();
        if (!isRecord(bounds) || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]) && bounds[key] >= 0)) {
          throw failure('invalid_capture_region', '缺少当前分析面板的原生范围。');
        }
        const x = Math.floor(bounds.x * factor), y = Math.floor(bounds.y * factor);
        const width = Math.min(content.width, Math.ceil((bounds.x + bounds.width) * factor)) - x;
        const height = Math.min(content.height, Math.ceil((bounds.y + bounds.height) * factor)) - y;
        if (!(width > 0 && height > 0)) throw failure('invalid_capture_region', '分析面板在当前工作台中不可见。');
        rect = { x, y, width, height };
      } else if (spec.rect !== undefined) {
        throw failure('invalid_capture_region', '工作台抓取使用当前完整内容范围。');
      }
      const image = await contents.capturePage(rect, { stayHidden: true });
      active();
      if (image.isEmpty() || !window.isVisible() || window.isMinimized())
        throw failure('workbench_capture_unavailable', '没有取得当前工作台的可见图像。');
      const { width, height } = image.getSize();
      return { bytes: new Uint8Array(image.toPNG()), width, height };
    }
    if (spec.action === 'structure-source' && name === 'structure_source') {
      const { destination, ...lookup } = args;
      if (destination !== undefined && lookup.action !== 'import') {
        throw failure('file_action_not_authorized', '仅导入结构库条目可指定原件保存位置。');
      }
      const result = await structureSource(lookup, request.signal, fetchStructureSource);
      active();
      if (destination === undefined) return result;
      let outputPath, original;
      try {
        outputPath = location(destination);
        const receipt = await writeBytes(owner, result.bytes, outputPath, false, active, result.source.format);
        original = { status: 'written', ...receipt, sha256: result.source.sha256 };
      } catch (cause) {
        if (outputPath && (cause.publicationPerformed || cause.publishedFiles?.length)) {
          original = await publicationReceipt(cause, outputPath, false);
        } else {
          active();
          const error = outputPath ? portableWriteError(cause, outputPath, false) : cause;
          const code = error.message?.startsWith('EXPORT_OVERWRITE:') ? 'destination_conflict' : error.code ?? 'export_failed';
          original = { status: 'failed', path: outputPath ?? destination, error: { code, message: error.message, data: error.data } };
        }
      }
      return { ...result, original };
    }
    if (spec.action === 'export-group') return planGroup(name, args, spec, active);
    if (spec.action === 'sources' && name === 'es_import') return openImportItems(owner, args.items, active);
    if (spec.action === 'sources' && sourceTools.has(name)) {
      const paths = sourceLocations(name, args);
      if (!paths.length) return [];
      const descriptors = await launchSources.open(owner, paths);
      try { active(); return descriptors; }
      catch (error) {
        await Promise.allSettled(descriptors.map(source => launchSources.close(owner, source.token)));
        throw error;
      }
    }
    if (name === 'es_project') {
      if (spec.action === 'new' && args.action === 'new') {
        const next = createWindow();
        return { ...publicTarget(next.webContents.id), status: 'opened' };
      }
      if (['open', 'open-status'].includes(spec.action) && args.action === spec.action) {
        const indexPath = location(args.path);
        if (!isProjectIndexPath(indexPath)) throw failure('invalid_project_path', '请选择 .es 项目入口。');
        const lookup = () => {
          const row = projectIPC.openStatus(indexPath);
          return args.retry === true && ['failed', 'cancelled'].includes(row?.status) ? null : row;
        };
        if (spec.action === 'open-status') return reportOpen(indexPath, projectIPC.openStatus(indexPath));
        const previous = lookup();
        if (previous) return reportOpen(indexPath, previous, true);
        const stat = await fs.lstat(indexPath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw failure('invalid_project_path', '项目入口须为普通文件。');
        active();
        const existing = lookup();
        if (existing) return reportOpen(indexPath, existing, true);
        const next = createWindow();
        const requestId = projectIPC.enqueue(next, indexPath);
        return { ...reportOpen(indexPath, { ownerId: next.webContents.id, requestId, status: 'queued' }),
          status: 'opening', loadStatus: 'queued' };
      }
      if (spec.action === 'recover' && args.action === 'recover') {
        const indexPath = location(args.path), point = args.recovery ?? 'inspect';
        if (!isProjectIndexPath(indexPath) || !['inspect', 'auto', 'previous'].includes(point)) {
          throw failure('invalid_recovery_request', '请选择 .es 项目入口及有效恢复点。');
        }
        const recovery = await projectIPC.inspectRecovery(indexPath);
        active();
        const existing = projectIPC.windowForPath(indexPath);
        const report = { path: indexPath, ...recovery };
        if (point === 'inspect') return { ...report, status: 'inspected', ...(existing === null ? {} : { activeWindow: publicTarget(existing) }) };
        if (!recovery.points[point]) return { ...report, status: 'recovery_unavailable', requestedRecovery: point };
        if (existing !== null) return { ...report, ...publicTarget(existing), status: 'project_already_open', requestedRecovery: point, nextAction: 'close-active-project-first' };
        const next = createWindow();
        projectIPC.enqueue(next, indexPath, { recovery: point });
        return { ...report, ...publicTarget(next.webContents.id), status: 'opening_recovery', requestedRecovery: point };
      }
      if (spec.action === 'save-location' && ['save', 'save-as'].includes(args.action)) {
        const destination = location(args.path);
        assertDestination(destination);
        return projectIPC.grantSaveLocation(window, destination, active);
      }
      if (spec.action === 'close' && args.action === 'close') {
        requestClose(window, spec.requestId);
        return { ...publicTarget(owner), status: 'close_requested' };
      }
    }
    if (spec.action === 'write-export' && name === 'trajectory_export') {
      return publish(name, args, spec, active,
        (destination, overwrite) => writeSealed(owner, spec.assetId, destination, overwrite, active));
    }
    if (spec.action === 'write-analysis' && name === 'analysis_export') {
      if (typeof spec.assetId !== 'string' || !spec.assetId || (spec.domainAssetId !== undefined &&
          (typeof spec.domainAssetId !== 'string' || !spec.domainAssetId || spec.domainAssetId === spec.assetId))) {
        throw failure('invalid_export_asset', '导出需要不同的完整 ES 格点及有效域资源。');
      }
      return publish(name, args, spec, active, async (destination, overwrite) => {
        const extension = path.extname(destination).toLowerCase();
        if (args.assetId === 'original-molden') {
          if (spec.domainAssetId !== undefined || !/\.molden(?:\.input)?$/i.test(path.basename(destination))) {
            throw failure('invalid_export_format', '原始 Molden 导出需要 .molden 或 .molden.input 路径。');
          }
          return writeSealed(owner, spec.assetId, destination, overwrite, active);
        }
        if (extension === '.cube' || extension === '.cub') {
          assertDestination(destination);
          if (spec.domainAssetId) assertDestination(destination + '.sciyue-domain.json');
          return saveAnalysisCube(window, { name: path.basename(destination), assetId: spec.assetId, domainAssetId: spec.domainAssetId }, { destination, overwrite, active });
        }
        if (spec.domainAssetId !== undefined || !['.txt', '.json'].includes(extension)) {
          throw failure('invalid_export_format', '分析导出支持 Cube、TXT 和 JSON 文件。');
        }
        return writeSealed(owner, spec.assetId, destination, overwrite, active);
      }, { companions: spec.domainAssetId ? ['.sciyue-domain.json'] : [] });
    }
    if (spec.action === 'task-file-copy' && name === 'job_file_export') {
      const destination = location(args.destination);
      assertDestination(destination);
      if (typeof args.artifactId !== 'string' || !args.artifactId) throw failure('invalid_source', '请指定作业文件。');
      return copyTaskFile(owner, { artifactId: args.artifactId, expectedSourceIdentity: args.expectedSourceIdentity }, { approvedDestination: destination, signal: active().signal });
    }
    const textWrite = spec.action === 'write-text' && name === 'file_write_text';
    if (textWrite || (spec.action === 'write' && name !== 'analysis_export' && (destinationTools.has(name) || directoryTools.has(name)))) {
      if (name === 'job_environment_transfer' && args.action !== 'export') throw failure('file_action_not_authorized', '该环境操作没有请求写入文件。');
      if (textWrite && typeof args.text !== 'string') throw failure('invalid_text', '请提供完整文件正文。');
      const bytes = textWrite ? Buffer.from(args.text, 'utf8') : spec.bytes;
      if (!(bytes instanceof Uint8Array)) throw failure('invalid_export_bytes', '导出数据无效。');
      return publish(name, args, spec, active, async (destination, overwrite) => {
        const extension = textWrite ? 'txt' : path.extname(destination).slice(1) || 'dat';
        return writeBytes(owner, bytes, destination, overwrite, active, extension);
      });
    }
    throw failure('file_action_not_authorized', '当前调用未授权此文件操作。');
  }
  return { invoke };
}

module.exports = { createMcpFiles };
