'use strict';
const path = require('node:path');
const {assert} = require('../security.cjs');
function command(runtime, input, output, resources, directory) {
  const heapMiB = Math.min(2048, Math.floor(resources.memoryBudgetBytes / 1024 ** 2 * 0.65));
  assert(heapMiB >= 128, 'OCR_MEMORY: 可用内存预算不足以启动识别。');
  const threads = resources.threads;
  return {executable: runtime.executable, args: ['-Djava.awt.headless=true', '-Dfile.encoding=UTF-8', '-Djava.io.tmpdir=' + directory,
    '-Xmx' + heapMiB + 'm', '-XX:ActiveProcessorCount=' + threads, '-XX:ParallelGCThreads=' + threads, '-XX:ConcGCThreads=' + threads,
    '-jar', runtime.jar, '-f', input, '-o', output], cwd: directory, output,
    environment: {JAVA_HOME: path.dirname(path.dirname(runtime.executable)), JAVA_TOOL_OPTIONS: '', JDK_JAVA_OPTIONS: '', _JAVA_OPTIONS: '', CLASSPATH: ''}};
}
function parse(text) {
  assert(typeof text === 'string' && text.length <= 4 * 1024 * 1024 && /M  END\s*(?:\r?\n|$)/.test(text), 'OCR_OUTPUT: 识别没有返回有效MOL候选。');
  // Structural acceptance/chemistry remains with the common 2D adapter.
  assert(!text.includes('\0'), 'OCR_OUTPUT: Invalid MOL bytes');
  return {molblock: text};
}
module.exports = {command, parse};
