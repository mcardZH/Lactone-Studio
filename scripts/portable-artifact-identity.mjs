import assert from 'node:assert/strict';

export function packageRelativePath(value) {
  assert(typeof value === 'string' && !/^[A-Za-z]:|^[\\/]/.test(value), 'Unsafe portable relative path');
  const parts = value.replaceAll('\\', '/').split('/');
  assert(parts.every(part => part && part !== '.' && part !== '..' && !/[<>:"|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)), 'Unsafe portable relative component');
  return parts.join('/');
}
