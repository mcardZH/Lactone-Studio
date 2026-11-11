'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {assert, plain} = require('./security.cjs');
const approvedMolvec = require('./ocr/molvec-component.json');
const {
  DARWIN_ARCHITECTURES,
  isSupportedJavaExecutable,
} = require('./ocr/molvec.cjs');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const catalogue = new Map([['molvec', approvedMolvec]]);

function assertSupportedTarget(rawEntry, platform, architecture) {
  if (rawEntry === approvedMolvec) {
    assert(platform === 'win32' || platform === 'darwin' || platform === 'linux', 'OCR_UNSUPPORTED: 组件不支持当前系统。');
    if (platform === 'win32' || platform === 'linux') {
      assert(architecture === 'x64', 'OCR_UNSUPPORTED: 组件不支持当前处理器架构。');
    } else {
      assert(DARWIN_ARCHITECTURES.has(architecture), 'OCR_UNSUPPORTED: 组件不支持当前处理器架构。');
    }
    return {version: approvedMolvec.version, jar: approvedMolvec.jar};
  }
  const entries = Array.isArray(rawEntry) ? rawEntry : [rawEntry];
  const platformMatches = entries.filter(item => item && (!item.platform || item.platform === platform));
  assert(platformMatches.length > 0, 'OCR_UNSUPPORTED: 组件不支持当前系统。');
  const archMatch = platformMatches.find(item => !item.architecture || item.architecture === architecture);
  assert(archMatch, 'OCR_UNSUPPORTED: 组件不支持当前处理器架构。');
  return {version: archMatch.version, jar: archMatch.jar};
}

async function safeDirectory(root) {
  const stat = await fs.lstat(root), actual = await fs.realpath(root);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && path.resolve(actual).toLowerCase() === path.resolve(root).toLowerCase(), 'OCR_COMPONENT_PATH: 组件目录不能经过链接。');
}

async function checkedFile(root, relative, {requireExecutable = false, readContent = true} = {}) {
  assert(typeof relative === 'string' && relative.length > 0 && relative.length < 1024 && !relative.includes('\0') && !relative.includes('\\') && relative.split('/').every(part => part && part !== '.' && part !== '..') && !path.isAbsolute(relative), 'OCR_COMPONENT_PATH: Invalid component member');
  const file = path.join(root, ...relative.split('/'));
  let parent = path.dirname(file);
  while (parent !== root) { await safeDirectory(parent); parent = path.dirname(parent); }
  const stat = await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, 'OCR_COMPONENT_FILE: 组件文件无效：' + relative);
  if (requireExecutable) {
    assert((stat.mode & 0o111) !== 0, 'OCR_COMPONENT_EXECUTABLE: 组件可执行文件缺少执行权限。');
  }
  if (!readContent) {
    return {file, size: stat.size};
  }
  const bytes = await fs.readFile(file);
  return {file, size: stat.size, sha256: sha256(bytes)};
}

/** Lightweight cross-platform OCR component resolver (validates component metadata,
 * launcher path contract, and executable/JAR presence without JRE file-tree hash pinning). */
function createOcrRuntime({defaultRoot, distributionRoot, platform = process.platform, architecture = process.arch, approved = catalogue}) {
  const selected = new Map();
  async function defaultComponentRoot(engine) {
    if (defaultRoot !== undefined) return path.join(defaultRoot, engine);
    const bundled = path.join(distributionRoot, 'runtime', 'ocr-components');
    try { await fs.lstat(bundled); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return path.join(distributionRoot, 'ocr-components', engine);
    }
    return path.join(bundled, engine);
  }
  async function resolve(engine, root) {
    const rawEntry = approved.get(engine);
    assert(rawEntry, 'OCR_UNSUPPORTED: 当前版本尚未接入该识别组件。');
    const target = assertSupportedTarget(rawEntry, platform, architecture);
    root ??= selected.get(engine) ?? await defaultComponentRoot(engine);
    root = path.resolve(root); await safeDirectory(root);
    const manifestFile = path.join(root, 'component.json'), stat = await fs.lstat(manifestFile);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size < 1024 * 1024, 'OCR_COMPONENT_MANIFEST: Invalid manifest');
    const bytes = await fs.readFile(manifestFile);
    const actual = JSON.parse(bytes.toString('utf8'));
    assert(
      plain(actual)
        && actual.schema === 1
        && actual.engine === engine
        && actual.version === target.version
        && actual.platform === platform
        && typeof actual.architecture === 'string'
        && actual.architecture === architecture
        && actual.jar === target.jar,
      'OCR_COMPONENT_UNAPPROVED: 组件版本或清单未被本版认可。',
    );
    if (engine === 'molvec') {
      assert(
        isSupportedJavaExecutable(actual.executable, platform, {allowAbsolute: false}),
        'OCR_COMPONENT_EXECUTABLE: 组件Java启动器路径不受支持。',
      );
    }
    const requireExecMode = platform !== 'win32' && process.platform !== 'win32';
    const checkedExec = await checkedFile(root, actual.executable, {
      requireExecutable: requireExecMode,
      readContent: false,
    });
    const checkedJar = await checkedFile(root, actual.jar, {readContent: true});
    const componentSHA256 = checkedJar.sha256;
    return {
      root,
      engine,
      version: actual.version,
      componentSHA256,
      jarSHA256: checkedJar.sha256,
      executable: checkedExec.file,
      jar: checkedJar.file,
      manifest: actual,
    };
  }
  async function capabilities() {
    const engines = [];
    for (const engine of ['molvec', 'molscribe']) {
      if (!approved.has(engine)) { engines.push({engine, status: 'unsupported', confidence: 'none', message: '本版本尚未接入已验证的离线组件。'}); continue; }
      try { const value = await resolve(engine); engines.push({engine, status: 'ready', version: value.version, componentSHA256: value.componentSHA256, confidence: 'none'}); }
      catch (error) { engines.push({engine, status: error.code === 'ENOENT' ? 'not-installed' : 'invalid', confidence: 'none', message: error.code === 'ENOENT' ? '尚未安装离线识别组件。' : error.message}); }
    }
    return {engines, maxImageBytes: 20 * 1024 * 1024, maxImagePixels: 24_000_000};
  }
  return {resolve, capabilities, async select(root) {
    assert(typeof root === 'string' && path.isAbsolute(root), 'OCR_COMPONENT_PATH: 请选择离线组件目录。');
    let found;
    for (const engine of approved.keys()) { try { const runtime = await resolve(engine, root); found = runtime; break; } catch (error) { if (!found) found = error; } }
    if (found instanceof Error) throw found;
    assert(found?.engine, 'OCR_COMPONENT_UNAPPROVED: 无可用组件。'); selected.set(found.engine, path.resolve(root));
    return capabilities();
  }};
}
module.exports = {createOcrRuntime, sha256, checkedFile, safeDirectory};
