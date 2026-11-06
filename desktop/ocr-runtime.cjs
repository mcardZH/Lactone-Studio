'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {assert} = require('./security.cjs');
const approvedMolvec = require('./ocr/molvec-component.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value);
const catalogue = new Map([['molvec', approvedMolvec]]);

async function safeDirectory(root) {
  const stat = await fs.lstat(root), actual = await fs.realpath(root);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && path.resolve(actual).toLowerCase() === path.resolve(root).toLowerCase(), 'OCR_COMPONENT_PATH: 组件目录不能经过链接。');
}
async function checkedFile(root, relative, expected) {
  assert(typeof relative === 'string' && relative.length < 1024 && !relative.includes('\\') && relative.split('/').every(part => part && part !== '.' && part !== '..') && !path.isAbsolute(relative), 'OCR_COMPONENT_PATH: Invalid component member');
  const file = path.join(root, ...relative.split('/'));
  let parent = path.dirname(file);
  while (parent !== root) { await safeDirectory(parent); parent = path.dirname(parent); }
  const stat = await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === expected.bytes, 'OCR_COMPONENT_FILE: 组件文件身份不符：' + relative);
  const handle = await fs.open(file, 'r');
  try {
    const before=await handle.stat();assert(before.dev===stat.dev&&before.ino===stat.ino&&before.size===stat.size&&before.mtimeMs===stat.mtimeMs,'OCR_COMPONENT_CHANGED: 组件在读取前变化。');
    const bytes=await handle.readFile();const after=await handle.stat(), current=await fs.lstat(file);
    assert(after.dev===before.dev&&after.ino===before.ino&&after.size===before.size&&after.mtimeMs===before.mtimeMs&&!current.isSymbolicLink()&&current.ino===before.ino&&current.dev===before.dev,'OCR_COMPONENT_CHANGED: 组件在读取时变化。');
    assert(sha256(bytes) === expected.sha256, 'OCR_COMPONENT_HASH: 组件校验失败：' + relative);
  } finally {await handle.close();}
  return file;
}
/** A selected manifest cannot authorize its own executable or Python pickle.
 * Only manifests shipped in the host catalogue can enable a fixed driver. */
function createOcrRuntime({defaultRoot, distributionRoot, platform = process.platform, architecture = process.arch, approved = catalogue}) {
  const selected = new Map();
  async function defaultComponentRoot(engine) {
    if (defaultRoot !== undefined) return path.join(defaultRoot, engine);
    const bundled = path.join(distributionRoot, 'runtime', 'ocr-components');
    // Older portable packages and source checkouts kept components at root.
    // Fall back only when the new directory is absent, never after a failed
    // integrity check of a present bundled component.
    try { await fs.lstat(bundled); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return path.join(distributionRoot, 'ocr-components', engine);
    }
    return path.join(bundled, engine);
  }
  async function resolve(engine, root) {
    const pinned = approved.get(engine);
    assert(pinned, 'OCR_UNSUPPORTED: 当前版本尚未接入该识别组件。');
    assert(platform === pinned.platform, 'OCR_UNSUPPORTED: 组件不支持当前系统。');
    assert(!pinned.architecture || architecture === pinned.architecture, 'OCR_UNSUPPORTED: 组件不支持当前处理器架构。');
    root ??= selected.get(engine) ?? await defaultComponentRoot(engine);
    root = path.resolve(root); await safeDirectory(root);
    const manifestFile = path.join(root, 'component.json'), stat = await fs.lstat(manifestFile);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size < 1024 * 1024, 'OCR_COMPONENT_MANIFEST: Invalid manifest');
    const bytes = await fs.readFile(manifestFile);
    const actual = JSON.parse(bytes.toString('utf8'));
    assert(canonical(actual) === canonical(pinned), 'OCR_COMPONENT_UNAPPROVED: 组件版本或清单未被本版认可。');
    const expected = new Set(Object.keys(pinned.files));
    async function enumerate(dir, prefix = '') {
      for (const name of await fs.readdir(dir)) {
        const rel = prefix + name, file = path.join(dir, name), info = await fs.lstat(file);
        assert(!info.isSymbolicLink(), 'OCR_COMPONENT_PATH: 组件中不能包含链接。');
        if (info.isDirectory()) { await safeDirectory(file); await enumerate(file, rel + '/'); }
        else assert(rel === 'component.json' || expected.has(rel), 'OCR_COMPONENT_EXTRA: 组件含未认可文件：' + rel);
      }
    }
    await enumerate(root);
    for (const [relative, identity] of Object.entries(pinned.files)) await checkedFile(root, relative, identity);
    return {root, engine, version: pinned.version, componentSHA256: sha256(Buffer.from(canonical(pinned))), executable: path.join(root, pinned.executable), jar: path.join(root, pinned.jar), manifest: pinned};
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
