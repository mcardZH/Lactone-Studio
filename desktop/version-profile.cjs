'use strict';
const path = require('node:path');
/** Host-only profile identity; renderer/command-line requests never select paths.
 * Different versions do not share mutable defaults. No implicit legacy import.
 */
function profileForVersion(appDataRoot, version) {
  if (typeof appDataRoot !== 'string' || !path.isAbsolute(appDataRoot)) throw new Error('Invalid host appData root');
  if (typeof version !== 'string' || version.length > 80 || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?(?:\+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(version)) throw new Error('Invalid application version for isolated profile');
  return path.join(path.resolve(appDataRoot), 'SciYue', 'profiles', 'v' + version);
}
function prepareVersionProfile(fs, appDataRoot, version) {
  const target = profileForVersion(appDataRoot, version), base = path.resolve(appDataRoot), actualBase = fs.realpathSync(base);
  let cursor = base;
  for (const part of path.relative(base, target).split(path.sep)) {
    cursor = path.join(cursor, part);
    try { fs.mkdirSync(cursor); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(cursor), relative = path.relative(actualBase, fs.realpathSync(cursor));
    if (!stat.isDirectory() || stat.isSymbolicLink() || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Version profile must not traverse a link or leave host appData');
  }
  return target;
}
module.exports = { profileForVersion, prepareVersionProfile };
