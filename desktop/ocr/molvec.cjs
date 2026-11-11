'use strict';
const path = require('node:path');
const {assert} = require('../security.cjs');

const DARWIN_ARCHITECTURES = new Set(['arm64', 'x64']);
const DARWIN_EXECUTABLE_PATTERN = /^runtime\/(?!\.+$)([^/\\\0]+)\/(?:Contents\/Home\/)?bin\/java$/;
const LINUX_EXECUTABLE_PATTERN = /^runtime\/(?!\.+$)([^/\\\0]+)\/bin\/java$/;
const WIN32_EXECUTABLE_PATTERN = /^runtime\/(?!\.+$)([^/\\<>:"|?*\x00-\x1f]+)\/bin\/java\.exe$/;

function isValidRelativeJreSegment(segment, platform) {
  if (typeof segment !== 'string' || segment.length === 0 || segment === '.' || segment === '..') return false;
  if (segment.includes('/') || segment.includes('\\') || segment.includes('\0')) return false;
  if (platform === 'win32') {
    if (/[<>:"|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment)) return false;
  }
  return true;
}

function isSupportedJavaExecutable(executable, platform, {allowAbsolute = true} = {}) {
  if (typeof executable !== 'string' || executable.length === 0 || executable.length >= 1024 || executable.includes('\0')) return false;
  if (platform === 'darwin') {
    if (path.posix.isAbsolute(executable)) {
      if (!allowAbsolute) return false;
      const parts = executable.split('/').filter(Boolean);
      if (parts.some(part => part === '.' || part === '..')) return false;
      const tail3 = parts.slice(-3);
      if (tail3.length === 3 && tail3[1] === 'bin' && tail3[2] === 'java') return true;
      const tail5 = parts.slice(-5);
      return tail5.length === 5 && tail5[1] === 'Contents' && tail5[2] === 'Home' && tail5[3] === 'bin' && tail5[4] === 'java';
    }
    if (executable.includes('\\')) return false;
    const parts = executable.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) return false;
    const match = executable.match(DARWIN_EXECUTABLE_PATTERN);
    return Boolean(match && isValidRelativeJreSegment(match[1], 'darwin'));
  }
  if (platform === 'win32') {
    const normalized = executable.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.some(part => part === '.' || part === '..')) return false;
    if (path.win32.isAbsolute(executable) || normalized.startsWith('/')) {
      if (!allowAbsolute) return false;
      const tail3 = parts.slice(-3);
      return tail3.length === 3
        && /^bin$/i.test(tail3[1])
        && /^java\.exe$/i.test(tail3[2])
        && isValidRelativeJreSegment(tail3[0], 'win32');
    }
    if (executable.includes('\\')) return false;
    const relParts = executable.split('/');
    if (relParts.some(part => !part || part === '.' || part === '..')) return false;
    const match = executable.match(WIN32_EXECUTABLE_PATTERN);
    return Boolean(match && isValidRelativeJreSegment(match[1], 'win32'));
  }
  if (platform === 'linux') {
    if (path.posix.isAbsolute(executable)) {
      if (!allowAbsolute) return false;
      const parts = executable.split('/').filter(Boolean);
      if (parts.some(part => part === '.' || part === '..')) return false;
      const tail3 = parts.slice(-3);
      return tail3.length === 3 && tail3[1] === 'bin' && tail3[2] === 'java';
    }
    if (executable.includes('\\')) return false;
    const parts = executable.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) return false;
    const match = executable.match(LINUX_EXECUTABLE_PATTERN);
    return Boolean(match && isValidRelativeJreSegment(match[1], 'linux'));
  }
  if (platform === undefined) {
    return isSupportedJavaExecutable(executable, 'darwin', {allowAbsolute})
      || isSupportedJavaExecutable(executable, 'linux', {allowAbsolute})
      || isSupportedJavaExecutable(executable, 'win32', {allowAbsolute});
  }
  return false;
}

function resolveJavaHome(executable, platform) {
  assert(isSupportedJavaExecutable(executable, platform), 'OCR_COMPONENT_EXECUTABLE: 组件Java启动器路径不受支持。');
  const useWin32 = platform === 'win32'
    || (platform !== 'darwin' && platform !== 'linux' && !executable.startsWith('/') && (/^[A-Za-z]:[\\/]/.test(executable) || executable.includes('\\') || /\.exe$/i.test(executable)));
  const pathImpl = useWin32 ? path.win32 : path.posix;
  return pathImpl.dirname(pathImpl.dirname(executable));
}

function command(runtime, input, output, resources, directory) {
  const targetPlatform = runtime?.manifest?.platform;
  assert(isSupportedJavaExecutable(runtime?.executable, targetPlatform), 'OCR_COMPONENT_EXECUTABLE: 组件Java启动器路径不受支持。');
  assert(typeof runtime?.jar === 'string' && runtime.jar.length > 0, 'OCR_COMPONENT_FILE: 组件JAR路径无效。');
  const heapMiB = Math.min(2048, Math.floor(resources.memoryBudgetBytes / 1024 ** 2 * 0.65));
  assert(heapMiB >= 128, 'OCR_MEMORY: 可用内存预算不足以启动识别。');
  const threads = resources.threads;
  return {executable: runtime.executable, args: ['-Djava.awt.headless=true', '-Dfile.encoding=UTF-8', '-Djava.io.tmpdir=' + directory,
    '-Xmx' + heapMiB + 'm', '-XX:ActiveProcessorCount=' + threads, '-XX:ParallelGCThreads=' + threads, '-XX:ConcGCThreads=' + threads,
    '-jar', runtime.jar, '-f', input, '-o', output], cwd: directory, output,
    environment: {JAVA_HOME: resolveJavaHome(runtime.executable, targetPlatform), JAVA_TOOL_OPTIONS: '', JDK_JAVA_OPTIONS: '', _JAVA_OPTIONS: '', CLASSPATH: ''}};
}
function parse(text) {
  assert(typeof text === 'string' && text.length <= 4 * 1024 * 1024 && /M  END\s*(?:\r?\n|$)/.test(text), 'OCR_OUTPUT: 识别没有返回有效MOL候选。');
  // Structural acceptance/chemistry remains with the common 2D adapter.
  assert(!text.includes('\0'), 'OCR_OUTPUT: Invalid MOL bytes');
  return {molblock: text};
}
module.exports = {
  DARWIN_ARCHITECTURES,
  DARWIN_EXECUTABLE_PATTERN,
  LINUX_EXECUTABLE_PATTERN,
  WIN32_EXECUTABLE_PATTERN,
  isSupportedJavaExecutable,
  resolveJavaHome,
  command,
  parse,
};
