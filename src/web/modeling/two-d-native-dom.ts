/** Supported Electron/Edge already provide these DOM operations. Keep the
 * obsolete compatibility polyfill out of the shipped editor dependency graph. */
if (typeof Element !== 'undefined' && (typeof Element.prototype.closest !== 'function' || typeof Element.prototype.matches !== 'function')) {
  throw new Error('二维编辑器需要当前桌面版提供的原生DOM功能。');
}
export {};
