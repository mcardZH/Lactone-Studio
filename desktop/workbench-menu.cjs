'use strict';
const { assert, allowedURL } = require('./security.cjs');
const LAYOUT_MENU_ID = 'sciyue.layout';
const LAYOUT_OPEN_ID = 'sciyue.layout.open';
const LAYOUT_OPEN_CHANNEL = 'sciyue:workbench-layout-open';
const SETTINGS_MENU_ID = 'sciyue.settings';
const SETTINGS_OPEN_ID = 'sciyue.settings.open';
const SETTINGS_OPEN_CHANNEL = 'sciyue:global-settings-open';
const FILE_ACTION_CHANNEL = 'sciyue:workbench-file-action';
const CITATIONS_OPEN_ID = 'sciyue.citations.open';
const CITATIONS_OPEN_CHANNEL = 'sciyue:citations-open';
const refreshers = new WeakMap();
/** Image export belongs to the focused viewport, including a shared member's
 * local camera. Structural file operations still belong to its document owner. */
function workbenchFileActionRoute(window, action, member, resolveOwner) {
  assert(['import', 'export-structure', 'export-image'].includes(action), 'Invalid workbench file action');
  const target = action === 'export-image' || !member ? window : resolveOwner(Number(member.ownerWindowId));
  return { target, request: { action, ...(member ? { documentId: member.documentId } : {}) } };
}
function ownedLayoutWindow(focusedWindow, { BrowserWindow, windows, development = false }) {
  try {
    if (!(focusedWindow instanceof BrowserWindow)) return false;
    const contents = focusedWindow.webContents, owned = contents && windows.get(contents.id);
    // The external hidden-test adapter may hold a proxy of this same native window.
    return Boolean(owned && owned.id === focusedWindow.id && owned.webContents === contents &&
      !focusedWindow.isDestroyed() && !contents.isDestroyed() && allowedURL(contents.mainFrame?.url, development));
  } catch { return false; }
}
function installWorkbenchMenu({ Menu, MenuItem, BrowserWindow, windows, development = false, requestProjectAction = () => false, requestFileAction = () => false, requestCitations = () => false, canFileAction = () => false, canProjectAction = () => true, requestQuit = () => {}, isClosing = () => false }) {
  assert(Menu && typeof Menu.buildFromTemplate === 'function' && typeof Menu.getApplicationMenu === 'function' && typeof Menu.setApplicationMenu === 'function' && typeof MenuItem === 'function', 'Native application menu API unavailable');
  assert(typeof BrowserWindow === 'function' && windows && typeof windows.get === 'function', 'Owned native window registry required');
  const existing = Menu.getApplicationMenu();
  const owned = window => ownedLayoutWindow(window, { BrowserWindow, windows, development });
  const targetAction = callback => (_item, window) => { if (!owned(window) || isClosing()) return false; try { return callback(window); } catch { return false; } };
  const project = (id, label, action, accelerator) => ({ id, label, accelerator, enabled: false, click: targetAction(window => canProjectAction(window, action) ? requestProjectAction(window, action) : false) });
  const file = (id, label, action, accelerator) => ({ id, label, accelerator, enabled: false, click: targetAction(window => canFileAction(window, action) ? requestFileAction(window, action) : false) });
  const fileItems = [
    project('sciyue.file.open', '打开项目…', 'open', 'CmdOrCtrl+O'),
    project('sciyue.file.save', '保存项目', 'save', 'CmdOrCtrl+S'),
    project('sciyue.file.save-as', '项目另存为…', 'save-as', 'CmdOrCtrl+Shift+S'),
    { type: 'separator' },
    file('sciyue.file.import', '导入文件…', 'import'),
    file('sciyue.file.export-structure', '导出结构文件…', 'export-structure'),
    file('sciyue.file.export-image', '导出图片…', 'export-image'),
    { type: 'separator' },
    { id: 'sciyue.file.quit', label: '退出', accelerator: 'Alt+F4', click: () => { requestQuit(); return true; } },
  ];
  const settings = new MenuItem({ id: SETTINGS_OPEN_ID, label: 'Settings', enabled: false,
    click(_item, focusedWindow) {
      if (!owned(focusedWindow) || isClosing()) return false;
      try { focusedWindow.webContents.send(SETTINGS_OPEN_CHANNEL); return true; } catch { return false; }
    },
  });
  // Preserve the existing Edit object, submenu, callbacks and accelerators.
  const edit = existing?.items.find(item => String(item.role ?? '').toLowerCase() === 'editmenu' || ['edit', '编辑'].includes(String(item.label ?? '').replace(/&/g, '').trim().toLowerCase()));
  const citations = new MenuItem({id:CITATIONS_OPEN_ID,label:'导出文献',enabled:false,click:targetAction(requestCitations)});
  const template = [{ id: 'sciyue.file', label: 'File', submenu: Menu.buildFromTemplate(fileItems) }, edit ?? { label: 'Edit', role: 'editMenu' }, settings,citations];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  refreshers.set(menu, window => {
    const available = owned(window) && !isClosing();
    for (const action of ['open', 'save', 'save-as']) menu.getMenuItemById('sciyue.file.' + action).enabled = available && canProjectAction(window, action);
    for (const action of ['import', 'export-structure', 'export-image']) menu.getMenuItemById('sciyue.file.' + action).enabled = available && canFileAction(window, action);
    menu.getMenuItemById(SETTINGS_OPEN_ID).enabled = available;
    menu.getMenuItemById(CITATIONS_OPEN_ID).enabled = available;
  });
  refreshers.get(menu)(BrowserWindow.getFocusedWindow?.());
  return menu;
}
function refreshWorkbenchMenu(menu, window) { refreshers.get(menu)?.(window); }
module.exports = { installWorkbenchMenu, refreshWorkbenchMenu, workbenchFileActionRoute, ownedLayoutWindow, FILE_ACTION_CHANNEL, CITATIONS_OPEN_ID, CITATIONS_OPEN_CHANNEL, LAYOUT_MENU_ID, LAYOUT_OPEN_ID, LAYOUT_OPEN_CHANNEL, SETTINGS_MENU_ID, SETTINGS_OPEN_ID, SETTINGS_OPEN_CHANNEL };
