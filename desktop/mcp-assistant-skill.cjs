'use strict';

const { existsSync } = require('node:fs');
const { lstat, open, realpath } = require('node:fs/promises');
const { basename, dirname, join, resolve } = require('node:path');
const { deflateRawSync } = require('node:zlib');

const readSkillName = 'assistant_read_skill';

function assistantSkillRoot({ packaged, appPath, resourcesPath }) {
  if (!packaged) return join(appPath, 'skills', 'ester-studio');
  for (const candidate of [
    resourcesPath && join(resourcesPath, 'skills', 'ester-studio'),
    appPath && join(appPath, 'skills', 'ester-studio'),
  ]) {
    if (candidate && existsSync(join(candidate, 'SKILL.md'))) return candidate;
  }
  return resolve(resourcesPath, '..', '..', 'harness', 'skills', 'ester-studio');
}

async function readMember(root, member, signal) {
  const path = join(root, member);
  // A packaged guide may select only its own regular members, including after resolving links.
  const memberInfo = await lstat(path);
  if (!memberInfo.isFile() || await realpath(path) !== path) throw new Error('ES 使用指南需要目录内的常规文件。');
  const file = await open(path, 'r');
  try {
    const opened = await file.stat();
    if (!opened.isFile() || memberInfo.dev !== opened.dev || memberInfo.ino !== opened.ino)
      throw new Error('读取期间指南文件发生了替换。');
    return await file.readFile({ encoding: 'utf8', signal });
  } finally {
    await file.close();
  }
}

async function loadAssistantSkill(directory) {
  const root = join(await realpath(dirname(directory)), basename(directory));
  if (!(await lstat(root)).isDirectory()) throw new Error('随包指南目录不可用。');
  const entry = await readMember(root, 'SKILL.md');
  const chapters = new Set(Array.from(entry.matchAll(/\]\((references\/[a-z][a-z0-9-]*\.md)\)/g), match => match[1]));
  if (!chapters.size) throw new Error('ES 使用指南中没有有效的章节链接。');
  return {
    instructions: `以下是 Ester Studio 随产品提供的使用指南入口。需要具体操作路线、建议设置或结果接续时，按目标调用 ${readSkillName}，用章节链接作 chapter。已有回执足够时可直接继续。工具参数和当前能力以实际开放的工具为准。\n\n${entry}`,
    tool: {
      name: readSkillName,
      description: 'Read a chapter of the bundled Ester Studio usage guide when it applies to the current task. Use the chapter link listed in the system instructions.',
      parameters: {
        type: 'object',
        properties: { chapter: { type: 'string', enum: [...chapters] } },
        required: ['chapter'],
        additionalProperties: false,
      },
    },
    async read(args, signal) {
      const { chapter } = args;
      if (Object.keys(args).length !== 1 || !chapters.has(chapter))
        throw Object.assign(new Error('请使用 ES 使用指南入口列出的章节链接。'), { code: 'invalid_arguments' });
      try {
        return { chapter, content: await readMember(root, chapter, signal) };
      } catch (cause) {
        signal.throwIfAborted();
        throw Object.assign(new Error('随产品提供的这一章暂时无法读取。可用 es_capabilities 查询当前工具。', { cause }),
          { code: 'assistant_skill_unavailable' });
      }
    },
  };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZipArchive(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x5421, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x5421, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, buf) => sum + buf.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

async function buildSkillZipBuffer(directory) {
  const root = join(await realpath(dirname(directory)), basename(directory));
  const skillText = await readMember(root, 'SKILL.md');
  const chapters = [...new Set(Array.from(skillText.matchAll(/\]\((references\/[a-z][a-z0-9-]*\.md)\)/g), m => m[1]))].sort();
  const entries = [{ name: 'ester-studio/SKILL.md', data: Buffer.from(skillText, 'utf8') }];
  for (const chapter of chapters) {
    const content = await readMember(root, chapter);
    entries.push({ name: `ester-studio/${chapter}`, data: Buffer.from(content, 'utf8') });
  }
  return buildZipArchive(entries);
}

module.exports = { assistantSkillRoot, loadAssistantSkill, buildSkillZipBuffer, readSkillName };
