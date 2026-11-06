/** Plain text copying uses a trusted desktop capability when present. */
export async function copyPlainText(text: string): Promise<void> {
  if (typeof text !== 'string') throw new TypeError('复制内容必须为文本。');
  if (window.sciyueDesktop?.writeClipboardText) {
    await window.sciyueDesktop.writeClipboardText(text);
    return;
  }
  if (!navigator.clipboard?.writeText) throw new Error('当前环境无法访问剪贴板，请下载文件或手动复制。');
  try { await navigator.clipboard.writeText(text); }
  catch (cause) { throw new Error(`复制失败，请允许剪贴板访问或下载文件。${cause instanceof Error ? ' '+cause.message : ''}`); }
}
