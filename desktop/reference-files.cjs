'use strict';
const path = require('node:path');
const { assert, plain, string } = require('./security.cjs');

const REFERENCE_EXTENSIONS = new Set(['chk', 'xyz', 'gbw', 'hess']);
function referenceSelectionRequest(request) {
  assert(plain(request) && Object.keys(request).every(key => ['title', 'extensions'].includes(key)), 'Invalid reference file request');
  assert(string(request.title, 100) && !/[\r\n\0]/.test(request.title), 'Invalid reference file title');
  assert(Array.isArray(request.extensions) && request.extensions.length > 0 && request.extensions.length <= REFERENCE_EXTENSIONS.size, 'Invalid reference file extensions');
  assert(request.extensions.every(value => typeof value === 'string' && REFERENCE_EXTENSIONS.has(value)), 'Unsupported reference file extension');
  return { title: request.title, extensions: [...new Set(request.extensions)] };
}

// This entry deliberately never opens, decodes, hashes or converts source bytes.
async function pickReferenceFile({ window, request, dialog, assertOwner, testSelection }) {
  const options = referenceSelectionRequest(request);
  let selected;
  if (testSelection) selected = await testSelection();
  else {
    const selection = await dialog.showOpenDialog(window, { title: options.title, properties: ['openFile'], filters: [{ name: '运行来源文件', extensions: options.extensions }] });
    if (!selection.canceled) {
      assert(Array.isArray(selection.filePaths) && selection.filePaths.length === 1, 'Select one reference file');
      selected = selection.filePaths[0];
    }
  }
  assertOwner();
  if (!selected) return null;
  assert(string(selected, 4096) && path.isAbsolute(selected), 'Reference selection must have an absolute local path');
  assert(options.extensions.includes(path.extname(selected).slice(1).toLowerCase()), 'Selected reference file extension does not match');
  return { name: path.basename(selected), path: selected };
}
module.exports = { referenceSelectionRequest, pickReferenceFile };
