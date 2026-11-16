'use strict';
const { execFile: runProcess } = require('node:child_process');
const path = require('node:path');

const WM_MOUSEACTIVATE = 0x21;
const WM_ACTIVATE = 0x06;
const WA_CLICKACTIVE = 2;
const ACTIVATION_CHANNEL = 'sciyue:two-d-pointer-activation';
const windowHooks = new WeakMap();
const noop = () => {};

function attachTwoDPointerActivation(window, platform = process.platform) {
  if (platform !== 'win32' || window.isDestroyed() || typeof window.hookWindowMessage !== 'function') return noop;
  const attached = windowHooks.get(window);
  if (attached) return attached;

  let reported = false, detached = false;
  const hooks = [];
  function publish() {
    if (detached || reported || window.isDestroyed() || window.webContents.isDestroyed()) return;
    reported = true;
    window.webContents.send(ACTIVATION_CHANNEL);
  }
  function onActivate(wParam) {
    if (!Buffer.isBuffer(wParam) || wParam.length < 2) return;
    if (wParam.readUInt16LE(0) === WA_CLICKACTIVE) publish();
    else reported = false;
  }
  function detach() {
    if (detached) return;
    detached = true;
    windowHooks.delete(window);
    window.removeListener('closed', detach);
    // Destruction already releases native hooks. A live window can detach explicitly.
    if (!window.isDestroyed()) for (const message of hooks) window.unhookWindowMessage(message);
    hooks.length = 0;
  }

  try {
    window.hookWindowMessage(WM_MOUSEACTIVATE, publish);
    hooks.push(WM_MOUSEACTIVATE);
    window.hookWindowMessage(WM_ACTIVATE, onActivate);
    hooks.push(WM_ACTIVATE);
  } catch {
    detach();
    return noop;
  }
  windowHooks.set(window, detach);
  window.once('closed', detach);
  return detach;
}

const DEFAULT_SETTINGS = Object.freeze({ doubleClickMs: 500, doubleClickWidth: 4, doubleClickHeight: 4, source: 'platform-default' });
const QUERY = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class EsterPointerSettings {
    [DllImport("user32.dll")] public static extern uint GetDoubleClickTime();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
}
'@
$doubleClickMs = [EsterPointerSettings]::GetDoubleClickTime()
$SM_CXDOUBLECLK = 36
$SM_CYDOUBLECLK = 37
$doubleClickWidth = [EsterPointerSettings]::GetSystemMetrics($SM_CXDOUBLECLK)
$doubleClickHeight = [EsterPointerSettings]::GetSystemMetrics($SM_CYDOUBLECLK)
@{doubleClickMs = $doubleClickMs; doubleClickWidth = $doubleClickWidth; doubleClickHeight = $doubleClickHeight} | ConvertTo-Json -Compress
`;

function createTwoDPointerSettingsReader({ platform = process.platform, execFile = runProcess, systemRoot = process.env.SystemRoot ?? 'C:/Windows' } = {}) {
  let pending;
  return function readTwoDPointerSettings() {
    if (platform !== 'win32') return Promise.resolve({ ...DEFAULT_SETTINGS });
    pending ??= new Promise(resolve => {
      const powershell = path.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
      const fallback = () => resolve(DEFAULT_SETTINGS);
      try {
        execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', QUERY], {
          windowsHide: true, shell: false, encoding: 'utf8', timeout: 2500, maxBuffer: 4096,
        }, (error, stdout) => {
          if (error) return fallback();
          try {
            const { doubleClickMs, doubleClickWidth, doubleClickHeight } = JSON.parse(stdout.trim());
            if (![doubleClickMs, doubleClickWidth, doubleClickHeight].every(value => Number.isSafeInteger(value) && value > 0)) return fallback();
            resolve({ doubleClickMs, doubleClickWidth, doubleClickHeight, source: 'win32' });
          } catch { fallback(); }
        });
      } catch { fallback(); }
    });
    return pending.then(settings => ({ ...settings }));
  };
}

const readTwoDPointerSettings = createTwoDPointerSettingsReader();
module.exports = { attachTwoDPointerActivation, readTwoDPointerSettings, createTwoDPointerSettingsReader };
