'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function configurationError(code, stage, target, cause) {
  const systemCode = cause?.code ? ` [${cause.code}]` : '';
  const details = cause?.message ? `\n${cause.message}` : '';
  return Object.assign(new Error(`${stage}${systemCode}\n${target}${details}`, { cause }), { code });
}

async function programPathError(backend, label, target, cause) {
  if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') {
    try { await fs.stat(path.parse(target).root); }
    catch (volumeError) {
      return configurationError(`${backend}_PROGRAM_UNAVAILABLE`, `无法访问 ${label} 所在的存储位置。`, target, volumeError);
    }
    return configurationError(`${backend}_PROGRAM_NOT_FOUND`, `找不到所选 ${label} 程序，请重新选择。`, target, cause);
  }
  return configurationError(`${backend}_PROGRAM_UNAVAILABLE`, `无法访问所选 ${label} 程序。`, target, cause);
}

async function writeConfiguration(location, value) {
  const temporary = `${location}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx');
  try {
    try { await handle.writeFile(JSON.stringify(value) + '\n', 'utf8'); }
    finally { await handle.close(); }
    await fs.rename(temporary, location);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

module.exports = { configurationError, programPathError, writeConfiguration };
