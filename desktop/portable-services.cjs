'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateWorkbenchPreferences } = require('./preferences.cjs');
const { validateModelDisplay } = require('./model-display-preferences.cjs');
const { assertExportDestination } = require('./portable-export.cjs');
const { hash, identity, failure, classifyStorageError, directoryIdentity, checkDirectory, checkWritable, readChecked, currentFile, sameFile, atomicWrite, inventory } = require('./portable-storage.cjs');
const TTL = 120000, BUNDLE_SCHEMA = 'sciyue-portable-preferences-v1';
const RUNTIME_ERRORS = Object.freeze({
  RUNTIME_CHECK_CANCELLED: '原生检查已取消；没有修改模型。',
  RUNTIME_CHECK_SPAWN: '原生引擎无法启动，请保留完整程序目录。',
  RUNTIME_CHECK_PROTOCOL: '原生引擎未返回完整合法的检查结果。',
  RUNTIME_CHECK_TIMEOUT: '原生检查超时；没有修改模型。',
  RUNTIME_CHECK_OUTPUT: '原生检查输出超出限制。',
  RUNTIME_CHECK_STDERR: '原生检查错误输出超出限制。',
  RUNTIME_CHECK_INPUT: '无法向原生引擎发送检查请求。',
  RUNTIME_CHECK_FAILED: '原生检查未完成，请保留完整程序目录并重试。',
});
// Read only explicitly allowed own data fields; never invoke helper-result getters.
const ownValue = (value, key) => { if (!value || typeof value !== 'object') return undefined; try { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined; } catch { return undefined; } };
const runtimeCode = value => typeof value === 'string' && /^[A-Z_]{1,40}$/.test(value) && Object.hasOwn(RUNTIME_ERRORS, value) ? value : 'RUNTIME_CHECK_FAILED';
function sanitizeNativeCheck(result, checkedAt, exception, elapsedMs) {
  const error = ownValue(result, 'error');
  const passed = !exception && !error && ownValue(result, 'passed') === true;
  const measured = ownValue(result, 'elapsedMs');
  const check = { checkedAt, observationScope: 'last-explicit-user-runtime-check', operation: 'convert', completeScientificValidation: false, passed,
    protocolValidated: !exception && ownValue(result, 'protocolValidated') === true,
    directChildClosed: !exception && ownValue(result, 'directChildClosed') === true,
    executableBundled: !exception && ownValue(result, 'executableBundled') === true,
    elapsedMs: Number.isFinite(measured) && measured >= 0 && measured <= 60000 ? measured : Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= 60000 ? elapsedMs : 0 };
  const engine = ownValue(result, 'engine'), engineVersion = ownValue(result, 'engineVersion');
  if (['RDKit', 'OpenBabel', 'ASE'].includes(engine)) { check.engine = engine; if (typeof engineVersion === 'string' && engineVersion.length <= 40 && /^\d{1,4}(?:\.\d{1,4}){1,4}(?:(?:rc|a|b|post|dev)\d{1,4})?$/.test(engineVersion)) check.engineVersion = engineVersion; }
  if (!passed) check.error = { code: runtimeCode(ownValue(exception ?? error, 'code')) };
  return check;
}
const exact = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw failure('PORTABLE_REQUEST', 'Invalid portable request fields'); };
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
function validateBundle(value) {
  exact(value, ['schema', 'version', 'layout', 'display']);
  if (value.schema !== BUNDLE_SCHEMA || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:-r\d+)?$/.test(value.version)) throw failure('PORTABLE_SCHEMA', 'Unsupported preference bundle schema/version');
  return { schema: BUNDLE_SCHEMA, version: value.version, layout: validateWorkbenchPreferences(value.layout), display: validateModelDisplay(value.display) };
}
function validateRequest(request) {
  const fields = { info: ['action'], 'open-location': ['action', 'location'], 'preferences-export': ['action'], 'import-preview': ['action'], 'import-apply': ['action', 'token', 'confirmed'], diagnostics: ['action'], 'diagnostics-export': ['action'], 'runtime-check': ['action'], 'cache-preview': ['action'], 'cache-apply': ['action', 'token', 'confirmed'] };
  if (!request || !Object.hasOwn(fields, request.action)) throw failure('PORTABLE_REQUEST', 'Unknown portable action'); exact(request, fields[request.action]);
  if (request.action === 'open-location' && !['profile', 'cache', 'temp', 'logs'].includes(request.location)) throw failure('PORTABLE_REQUEST', 'Unknown location');
  if (request.action.endsWith('-apply') && (request.confirmed !== true || typeof request.token !== 'string' || !/^[a-f0-9-]{36}$/.test(request.token))) throw failure('PORTABLE_CONFIRMATION', 'Explicit confirmation and preview token required');
}
/** Exact public response envelopes (all include ok:true,action):
 * info: {info:{version,mode,backend,paths:{root,data,profile,cache,temp,logs,crashDumps},
 *   writable:boolean,writableLocations:{profile,cache,temp,logs:boolean},storageErrors?:{location:code},filesystem,usage:{data,cache,temp,logs:{files,bytes,complete,error?}}}}
 * open-location: {opened:true}; preferences-export: {exported:true,path} OR {cancelled:true}
 * import-preview: {preview:{token,expiresAt,source:{version,label},changes:{layouts,display:true},backupRequired:true}} OR {cancelled:true}
 * import-apply: {imported:true,backup,layoutVersion,displayVersion}
 * diagnostics: {diagnostic:{schema,generatedAt,version,mode,backend,writable,filesystem,
 *   directoryIdentityVerified,nativeSmokePerformed:false,customerContentIncluded:false,limitations:string[],
 *   lastNativeCheck?:{checkedAt,observationScope:'last-explicit-user-runtime-check',operation:'convert',completeScientificValidation:false,
 *     passed,protocolValidated,directChildClosed,executableBundled,elapsedMs,engine?,engineVersion?,error?:{code}}}}
 * diagnostics-export: {exported:true,path} OR {cancelled:true}; runtime-check: {runtimeCheck:hostResult}
 * cache-preview: {preview:{token,expiresAt,files,bytes,browserCacheBytes,clearsBrowserCache,skippedRuns,requiresIdle:true}}
 * cache-apply: {removedFiles,removedBytes,browserCacheCleared,emptyDirectoriesRetained:true}
 * failure: {ok:false,action,error:{code,message,retryable,preserved,recoveryRequired?,backup?,
 *   partial?,removedFiles?,removedBytes?,browserCacheCleared?,browserCacheAttempted?}}
 * No response includes imported model/source data; imports affect persistent defaults only.
 */
function createPortableServices({ profile, workbenchStore, displayStore, dialog = {}, openPath, clearCache, runtimeCheck, isBusy = () => true, backendInfo = () => ({ name: 'unknown', verified: false }), clock = Date.now }) {
  if (profile?.mode !== 'portable' || !workbenchStore?.exclusive || !displayStore?.exclusive) throw new Error('Portable host and exclusive preference stores required');
  const tokens = new Map(), epochs = new Map(); let closed = false, queue = Promise.resolve(), lastNativeCheck;
  const epoch = owner => epochs.get(owner) ?? 0;
  const active = context => { if (closed || context.epoch !== epoch(context.owner)) throw failure('PORTABLE_OWNER_CLOSED', 'Window/portable service closed'); };
  const lock = (context, operation) => workbenchStore.exclusive(context.owner, layout => displayStore.exclusive(context.owner, display => operation(layout, display)));
  const guard = async () => { await checkDirectory(profile.root, profile.identities.root); for (const key of ['data', 'profile', 'cache', 'temp', 'logs', 'crashDumps']) await checkDirectory(profile.paths[key], profile.identities[key]); };
  function issue(context, kind, details) {
    active(context); for (const [id, record] of tokens) if (record.expiresAt <= clock()) tokens.delete(id);
    if (tokens.size >= 64) throw failure('PORTABLE_TOKEN_LIMIT', 'Too many pending previews');
    const token = randomUUID(), expiresAt = clock() + TTL; tokens.set(token, { ...details, kind, owner: context.owner, epoch: context.epoch, expiresAt }); return { token, expiresAt };
  }
  function consume(context, token, kind) { active(context); const found = tokens.get(token); if (!found || found.owner !== context.owner || found.epoch !== context.epoch || found.kind !== kind || found.expiresAt <= clock()) throw failure('PORTABLE_TOKEN', 'Preview expired or belongs to another window'); tokens.delete(token); return found; }
  async function snapshots(layout, display) { const [a, b] = await Promise.all([layout.read(), display.read()]); if (!a.writable || !b.writable) throw failure('PORTABLE_SCHEMA', '损坏或未来偏好格式已保留，禁止导入覆盖。'); return { layout: a, display: b }; }
  const targetFiles = () => ['workbench-layout-v3.json', 'model-display-preferences-v1.json'].map(name => path.join(profile.paths.profile, name));
  function exportDestination(file) {
    return assertExportDestination(file, { root: profile.layout?.distributionRoot ?? profile.root, managedRoots: Object.values(profile.paths), layout: profile.layout });
  }
  async function sourceSelection(selection) {
    const selected = typeof selection === 'string' ? selection : selection?.path;
    if (typeof selected !== 'string' || !path.isAbsolute(selected)) throw failure('PORTABLE_SELECTION', 'Host-selected absolute import path required');
    const stat = await fs.lstat(selected); if (stat.isSymbolicLink()) throw failure('PORTABLE_PATH_CHANGED', 'Linked import source forbidden');
    if (stat.isFile()) { const record = await readChecked(selected); return { bundle: validateBundle(parse(record.bytes)), records: [record], sourceParent: record.parent, sourceDirectory: path.dirname(selected) }; }
    if (!stat.isDirectory()) throw failure('PORTABLE_INVALID_FILE', 'Import source must be a preference bundle or selected profile directory');
    const parent = await directoryIdentity(selected), records = []; let layout;
    for (const name of ['workbench-layout-v3.json', 'workbench-layout-v2.json', 'workbench-layout-v1.json']) { try { const record = await readChecked(path.join(selected, name)); layout = validateWorkbenchPreferences(parse(record.bytes)); records.push(record); break; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    if (!layout) throw failure('PORTABLE_SCHEMA', 'Selected profile has no layout preferences');
    const record = await readChecked(path.join(selected, 'model-display-preferences-v1.json')); const display = parse(record.bytes); exact(display, ['schemaVersion', 'display']); if (display.schemaVersion !== 1) throw failure('PORTABLE_SCHEMA', 'Unsupported display schema'); records.push(record);
    const match = /^v(\d+\.\d+\.\d+(?:-r\d+)?)$/.exec(path.basename(selected)); if (!match) throw failure('PORTABLE_SCHEMA', 'Select a versioned profile directory or export bundle');
    await checkDirectory(selected, parent); return { bundle: validateBundle({ schema: BUNDLE_SCHEMA, version: match[1], layout, display: display.display }), records, sourceParent: parent, sourceDirectory: selected };
  }
  async function usage() {
    const result = {}; for (const key of ['data', 'cache', 'temp', 'logs']) { try { const scan = await inventory(profile.paths[key], profile.identities[key]); result[key] = { files: scan.files.length, bytes: scan.bytes, complete: true }; } catch (error) { result[key] = { files: 0, bytes: 0, complete: false, error: classifyStorageError(error).code }; } } return result;
  }
  async function writable() {
    const writableLocations = {}, storageErrors = {}; for (const key of ['profile', 'cache', 'temp', 'logs']) { try { await checkWritable(profile.paths[key], profile.identities[key]); writableLocations[key] = true; } catch (error) { if (error.code === 'PORTABLE_PATH_CHANGED') throw error; writableLocations[key] = false; storageErrors[key] = classifyStorageError(error).code; } }
    return { writable: Object.values(writableLocations).every(Boolean), writableLocations, ...(Object.keys(storageErrors).length ? { storageErrors } : {}) };
  }
  async function diagnostic() { return { schema: 'sciyue-portable-diagnostics-v1', generatedAt: new Date(clock()).toISOString(), version: profile.version, mode: profile.mode, backend: await backendInfo(), writable: (await writable()).writable, filesystem: profile.filesystem, directoryIdentityVerified: true, nativeSmokePerformed: false, customerContentIncluded: false, limitations: ['Windows/third-party startup writes are not guaranteed to stay portable', 'Writable exclusive-publish and atomic-replace filesystem required'], ...(lastNativeCheck ? { lastNativeCheck: structuredClone(lastNativeCheck) } : {}) }; }
  async function cachePlan() {
    if (await isBusy()) throw failure('PORTABLE_BUSY', '运行任务或文件操作尚未结束，请稍后清理。');
    await guard(); const parent = path.dirname(profile.paths.temp), parentIdentity = await directoryIdentity(parent), scans = [], skipped = [];
    for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
      const directory = path.join(parent, entry.name); if (directory === profile.paths.temp) { skipped.push(entry.name); continue; }
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[A-Za-z0-9_-]{1,80}$/.test(entry.name)) { skipped.push(entry.name); continue; }
      try {
        const marker = await readChecked(path.join(directory, '.portable-run.json'), 4096), run = parse(marker.bytes);
        exact(run, ['schema', 'version', 'revision', 'runId', 'pid', 'startedAt', 'state']);
        if (run.schema !== 'sciyue-portable-run-v1' || run.version !== profile.version || run.revision !== profile.revision || run.runId !== entry.name || run.state !== 'closed' || !Number.isInteger(run.pid) || run.pid < 1 || !Number.isFinite(Date.parse(run.startedAt))) { skipped.push(entry.name); continue; }
        const token = await directoryIdentity(directory), scan = await inventory(directory, token); scans.push({ directory, identity: token, marker, ...scan });
      } catch (error) { if (['ENOENT', 'PORTABLE_INVALID_FILE', 'PORTABLE_LINKED_FILE'].includes(error.code) || error instanceof SyntaxError) { skipped.push(entry.name); continue; } throw error; }
    }
    // Chromium-owned current cache is cleared only through Electron, never by deleting its tree.
    const browser = await inventory(profile.paths.cache, profile.identities.cache);
    return { parent, parentIdentity, scans, skipped, files: scans.flatMap(scan => scan.files), bytes: scans.reduce((sum, scan) => sum + scan.bytes, 0), browserCacheBytes: browser.bytes };
  }
  async function execute(request, context) {
    validateRequest(request); active(context); await guard(); active(context);
    if (request.action === 'info') return { info: { version: profile.version, mode: profile.mode, backend: await backendInfo(), paths: { root: profile.layout?.distributionRoot ?? profile.root, ...(profile.layout?.layoutVersion === 2 ? { runtime: profile.layout.runtimeRoot, state: profile.root } : {}), ...profile.paths }, ...await writable(), filesystem: profile.filesystem, usage: await usage() } };
    if (request.action === 'open-location') { if (typeof openPath !== 'function') throw failure('PORTABLE_UNAVAILABLE', 'Host open-location unavailable'); const error = await openPath(profile.paths[request.location]); active(context); if (error) throw failure('PORTABLE_OPEN_FAILED', error); return { opened: true }; }
    if (request.action === 'diagnostics') return { diagnostic: await diagnostic() };
    if (request.action === 'runtime-check') {
      if (typeof runtimeCheck !== 'function') throw failure('PORTABLE_UNAVAILABLE', 'Host runtime check unavailable'); if (await isBusy()) throw failure('PORTABLE_BUSY', 'Runtime check requires idle host'); active(context); const started = clock(); let result;
      try { result = await runtimeCheck(context.owner); }
      catch (error) { lastNativeCheck = sanitizeNativeCheck(null, new Date(clock()).toISOString(), error, clock() - started); active(context); const code = lastNativeCheck.error.code; throw failure(code, RUNTIME_ERRORS[code]); }
      lastNativeCheck = sanitizeNativeCheck(result, new Date(clock()).toISOString(), null, clock() - started); active(context); await guard();
      const { checkedAt, observationScope, ...summary } = lastNativeCheck;
      return { runtimeCheck: { ...structuredClone(summary), completeScientificValidation: false, ...(summary.error ? { error: { code: summary.error.code, message: RUNTIME_ERRORS[summary.error.code] } } : {}) } };
    }
    if (request.action === 'diagnostics-export') {
      if (typeof dialog.selectDiagnosticsExport !== 'function') throw failure('PORTABLE_UNAVAILABLE', 'Host diagnostic export dialog unavailable'); const selected = await dialog.selectDiagnosticsExport(context.owner); active(context); if (!selected) return { cancelled: true };
      const file = exportDestination(typeof selected === 'string' ? selected : selected.path); const existing = await currentFile(file), parent = await directoryIdentity(path.dirname(file)); if (existing && selected.overwriteConfirmed !== true) throw failure('PORTABLE_CONFIRMATION', 'Export overwrite requires host dialog confirmation'); await guard(); await atomicWrite(file, Buffer.from(JSON.stringify(await diagnostic(), null, 2) + '\n'), existing, parent); return { exported: true, path: file };
    }
    if (request.action === 'preferences-export') {
      if (typeof dialog.selectExport !== 'function') throw failure('PORTABLE_UNAVAILABLE', 'Host export dialog unavailable'); const selected = await dialog.selectExport(context.owner); active(context); if (!selected) return { cancelled: true };
      const file = exportDestination(typeof selected === 'string' ? selected : selected.path);
      const existing = await currentFile(file), parent = await directoryIdentity(path.dirname(file)); if (existing && selected.overwriteConfirmed !== true) throw failure('PORTABLE_CONFIRMATION', 'Export overwrite requires host dialog confirmation');
      return lock(context, async (layout, display) => { const state = await snapshots(layout, display); active(context); await guard(); const bundle = { schema: BUNDLE_SCHEMA, version: profile.version + (profile.revision ? '-' + profile.revision : ''), layout: state.layout.preferences, display: state.display.display }; await atomicWrite(file, Buffer.from(JSON.stringify(bundle, null, 2) + '\n'), existing, parent); active(context); return { exported: true, path: file }; });
    }
    if (request.action === 'import-preview') {
      if (typeof dialog.selectImport !== 'function') throw failure('PORTABLE_UNAVAILABLE', 'Host import dialog unavailable'); const selected = await dialog.selectImport(context.owner); active(context); if (!selected) return { cancelled: true };
      const source = await sourceSelection(selected); const sourceStat = await fs.lstat(source.sourceDirectory), profileStat = await fs.lstat(profile.paths.profile); if (sourceStat.dev === profileStat.dev && sourceStat.ino === profileStat.ino) throw failure('PORTABLE_SELECTION', '请选择旧版本或其他目录，不要导入当前正在使用的偏好目录。'); return lock(context, async (layout, display) => { const state = await snapshots(layout, display); active(context); const targets = await Promise.all(targetFiles().map(file => currentFile(file))); return { preview: { ...issue(context, 'import', { source, state, targets }), source: { version: source.bundle.version, label: path.basename(typeof selected === 'string' ? selected : selected.path) }, changes: { layouts: source.bundle.layout.layouts.length, display: true }, backupRequired: true } }; });
    }
    if (request.action === 'import-apply') {
      const preview = consume(context, request.token, 'import'); return lock(context, async (layout, display) => {
        await guard(); active(context); const state = await snapshots(layout, display);
        if (state.layout.version !== preview.state.layout.version || state.display.version !== preview.state.display.version) throw failure('PORTABLE_CONFLICT', '偏好在预览后发生变化，请重新预览。');
        await checkDirectory(preview.source.sourceDirectory, preview.source.sourceParent); for (const record of preview.source.records) await sameFile(record.path, record);
        const files = targetFiles(); for (let i = 0; i < files.length; i++) await sameFile(files[i], preview.targets[i]);
        const backupRoot = path.join(profile.paths.profile, 'import-backups'); try { await fs.mkdir(backupRoot); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        await directoryIdentity(backupRoot); const backup = path.join(backupRoot, randomUUID()); await fs.mkdir(backup); const backupIdentity = await directoryIdentity(backup);
        for (let i = 0; i < files.length; i++) if (preview.targets[i]) await atomicWrite(path.join(backup, path.basename(files[i])), preview.targets[i].bytes, null, backupIdentity);
        const journal = path.join(backup, 'import-receipt.json'); let journalState = { schema: 'sciyue-portable-import-v1', sourceVersion: preview.source.bundle.version, targetVersion: profile.version, createdAt: new Date(clock()).toISOString(), stage: 'prepared', originalMissing: preview.targets.map(item => !item), oldDataUntouched: true }; let journalFile = await atomicWrite(journal, Buffer.from(JSON.stringify(journalState) + '\n'), null, backupIdentity);
        let savedLayout, savedDisplay; const published = [], attempted = [];
        try {
          active(context); await guard(); attempted[0] = true; savedLayout = await layout.write({ baseVersion: state.layout.version, preferences: preview.source.bundle.layout }); published[0] = await currentFile(files[0]);
          active(context); await guard(); attempted[1] = true; savedDisplay = await display.write({ baseVersion: state.display.version, display: preview.source.bundle.display }); published[1] = await currentFile(files[1]);
          active(context); await guard(); journalState.stage = 'imported'; await atomicWrite(journal, Buffer.from(JSON.stringify(journalState) + '\n'), journalFile, backupIdentity);
          return { imported: true, backup, layoutVersion: savedLayout.version, displayVersion: savedDisplay.version };
        } catch (error) {
          // Two files cannot form one OS atomic transaction. Exact backups and a journal
          // make failures recoverable; rollback only our own unchanged published bytes.
          let recoveryRequired = false;
          for (let i = 0; i < files.length; i++) {
            if (!attempted[i]) continue;
            try { await guard(); const now = await currentFile(files[i]); if ((!now && !preview.targets[i]) || (now && preview.targets[i] && now.identity === preview.targets[i].identity && now.sha256 === preview.targets[i].sha256)) continue; if (!published[i]) throw failure('PORTABLE_PATH_CHANGED', 'No proven publication identity; recover from backup'); await sameFile(files[i], published[i]);
              if (preview.targets[i]) await atomicWrite(files[i], preview.targets[i].bytes, now, profile.identities.profile); else { await sameFile(files[i], now); await checkDirectory(profile.paths.profile, profile.identities.profile); await fs.unlink(files[i]); }
            } catch { recoveryRequired = true; }
          }
          journalState.stage = recoveryRequired ? 'recovery-required' : 'rolled-back'; try { await atomicWrite(journal, Buffer.from(JSON.stringify(journalState) + '\n'), journalFile, backupIdentity); } catch { recoveryRequired = true; }
          error.recoveryRequired = recoveryRequired; error.backup = backup; if (recoveryRequired) error.message = '导入未完成，目标可能部分更新；原偏好备份已保留，请从备份恢复。'; throw error;
        }
      });
    }
    if (request.action === 'cache-preview') { const plan = await cachePlan(); active(context); return { preview: { ...issue(context, 'cache', { plan }), files: plan.files.length, bytes: plan.bytes, browserCacheBytes: plan.browserCacheBytes, clearsBrowserCache: typeof clearCache === 'function', skippedRuns: plan.skipped.length, requiresIdle: true } }; }
    if (request.action === 'cache-apply') {
      const preview = consume(context, request.token, 'cache'); if (await isBusy()) throw failure('PORTABLE_BUSY', '有活跃任务，拒绝清理。'); active(context); await guard(); const plan = preview.plan;
      await checkDirectory(plan.parent, plan.parentIdentity);
      for (const scan of plan.scans) { const current = await inventory(scan.directory, scan.identity); if (JSON.stringify(current) !== JSON.stringify({ files: scan.files, directories: scan.directories, bytes: scan.bytes })) throw failure('PORTABLE_PATH_CHANGED', 'Cache manifest changed after preview'); await sameFile(scan.marker.path, scan.marker); }
      let removedFiles = 0, removedBytes = 0, browserCacheCleared = false, browserCacheAttempted = false;
      try {
        for (const scan of plan.scans) {
          // Keep the ownership marker until every other file has been processed.
          const files = [...scan.files.filter(item => item.path !== scan.marker.path), ...scan.files.filter(item => item.path === scan.marker.path)];
          for (const item of files) { active(context); if (await isBusy()) throw failure('PORTABLE_BUSY', 'A task became active during cleanup'); await guard(); await checkDirectory(scan.directory, scan.identity); const stat = await fs.lstat(item.path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || identity(stat) !== item.identity) throw failure('PORTABLE_PATH_CHANGED', 'Cache member changed'); await fs.unlink(item.path); removedFiles++; removedBytes += item.bytes; }
        }
        if (typeof clearCache === 'function') { active(context); if (await isBusy()) throw failure('PORTABLE_BUSY', 'Cache clearing requires idle host'); browserCacheAttempted = true; await clearCache(); browserCacheCleared = true; active(context); }
        return { removedFiles, removedBytes, browserCacheCleared, emptyDirectoriesRetained: true };
      } catch (error) {
        error.cleanup = { partial: removedFiles > 0 || browserCacheAttempted, removedFiles, removedBytes, browserCacheCleared, browserCacheAttempted };
        if (error.cleanup.partial) error.message = `清理未完全完成；已移除${removedFiles}个自有临时文件（${removedBytes}字节），浏览器缓存${browserCacheCleared ? '已清理' : browserCacheAttempted ? '清理结果不明' : '未清理'}。`;
        throw error;
      }
    }
    throw failure('PORTABLE_REQUEST', 'Unknown action');
  }
  return {
    handle(request, { ownerId } = {}) {
      if (!['string', 'number'].includes(typeof ownerId) || String(ownerId).length > 100 || !String(ownerId)) return Promise.resolve({ ok: false, action: request?.action ?? 'invalid', error: classifyStorageError(failure('PORTABLE_OWNER', 'Owned window identity required')) });
      const context = { owner: ownerId, epoch: epoch(ownerId) };
      const work = queue.then(async () => { try { const result = await execute(request, context); active(context); return { ok: true, action: request.action, ...result }; } catch (error) { return { ok: false, action: typeof request?.action === 'string' ? request.action : 'invalid', error: { ...classifyStorageError(error), ...(error.recoveryRequired !== undefined ? { recoveryRequired: error.recoveryRequired, preserved: !error.recoveryRequired, backup: error.backup, ...(error.recoveryRequired ? { message: error.message } : {}) } : {}), ...(error.cleanup ? { ...error.cleanup, preserved: !error.cleanup.partial, ...(error.cleanup.partial ? { message: error.message } : {}) } : {}) } }; } }); queue = work.catch(() => {}); return work;
    },
    disposeOwner(owner) { epochs.set(owner, epoch(owner) + 1); for (const [token, record] of tokens) if (record.owner === owner) tokens.delete(token); },
    dispose() { closed = true; tokens.clear(); },
    settle: () => queue,
  };
}
async function finishPortableRun(profile) {
  await checkDirectory(profile.paths.temp, profile.identities.temp); const file = path.join(profile.paths.temp, '.portable-run.json'), current = await readChecked(file, 4096); const run = parse(current.bytes);
  if (JSON.stringify(run) !== JSON.stringify(profile.run)) throw failure('PORTABLE_PATH_CHANGED', 'Run marker changed');
  await atomicWrite(file, Buffer.from(JSON.stringify({ ...run, state: 'closed' }) + '\n'), current, profile.identities.temp);
}
module.exports = { createPortableServices, finishPortableRun, validateBundle, validateRequest, BUNDLE_SCHEMA, TTL };
