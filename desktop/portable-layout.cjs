'use strict';
const fsDefault = require('node:fs');
const path = require('node:path');

const LAYOUT_SCHEMA = 'sciyue-portable-layout/v2';
const HOST_NAME = 'sciyue-host.exe';
const MARKER_NAME = 'portable-layout.json';
function hostName(version) { const [major, minor] = version.split('.').map(Number); return major > 0 ? 'Ester-Studio-host.exe' : minor >= 65 ? 'SY-Studio-host.exe' : HOST_NAME; }
function compatibleHost(version, host) {
  const [major, minor] = version.split('.').map(Number);
  return host === hostName(version) || host === 'SY-Studio-host.exe' && (major > 0 || minor >= 65);
}
function layoutDescriptor(version, host = hostName(version)) {
  if (!/^\d+\.\d+\.\d+(?:-dev\.[1-9]\d*)?$/.test(version)) throw new Error('Invalid portable layout version');
  if (!compatibleHost(version, host)) throw new Error('Invalid portable layout host');
  return { schema: LAYOUT_SCHEMA, layoutVersion: 2, version, runtime: 'runtime', host, state: 'state', provenance: 'provenance' };
}
function invalid(message) { return Object.assign(new Error(message), { code: 'PORTABLE_LAYOUT_INVALID' }); }
function checkedAncestors(fs, directory) {
  for (let cursor = path.resolve(directory);; cursor = path.dirname(cursor)) {
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid('便携程序目录不能经过链接。');
    if (path.dirname(cursor) === cursor) break;
  }
}
/** Host-owned executable location is the only layout input. Never reads env/argv. */
function resolvePortableLayout({ executable, version, fs = fsDefault }) {
  if (typeof executable !== 'string' || !path.isAbsolute(executable)) throw invalid('Invalid portable executable path');
  const runtimeRoot = path.dirname(executable);
  if (![HOST_NAME, 'sy-studio-host.exe', 'ester-studio-host.exe'].includes(path.basename(executable).toLowerCase())) {
    return { layoutVersion: 1, distributionRoot: runtimeRoot, runtimeRoot, stateRoot: runtimeRoot, provenanceRoot: path.join(runtimeRoot, 'provenance') };
  }
  if (path.basename(runtimeRoot).toLowerCase() !== 'runtime') throw invalid('Ester Studio 内部程序需要位于完整便携目录的 runtime 中。');
  checkedAncestors(fs, runtimeRoot);
  const marker = path.join(runtimeRoot, MARKER_NAME), stat = fs.lstatSync(marker);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw invalid('Invalid portable layout marker');
  let value;
  try { value = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { throw invalid('Invalid portable layout marker'); }
  let expected;
  try { expected = layoutDescriptor(version, value?.host); } catch { throw invalid('便携宿主文件名与版本不匹配。'); }
  if (path.basename(executable).toLowerCase() !== expected.host.toLowerCase()) throw invalid('便携宿主文件名与版本不匹配。');
  if (!value || Object.keys(value).length !== Object.keys(expected).length || !Object.keys(expected).every(key => value[key] === expected[key])) throw invalid('便携目录布局或版本不匹配，请保留完整程序目录。');
  return { layoutVersion: 2, distributionRoot: path.dirname(runtimeRoot), runtimeRoot, stateRoot: path.join(runtimeRoot, 'state'), provenanceRoot: path.join(runtimeRoot, 'provenance') };
}
module.exports = { LAYOUT_SCHEMA, HOST_NAME, MARKER_NAME, hostName, layoutDescriptor, resolvePortableLayout };
