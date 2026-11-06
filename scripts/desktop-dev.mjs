import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const electron = require('electron');
const occupied = await new Promise(resolveBusy => {
  const socket = createConnection({ host: '127.0.0.1', port: 4181 });
  socket.once('connect', () => { socket.destroy(); resolveBusy(true); });
  socket.once('error', () => { socket.destroy(); resolveBusy(false); });
});
if (occupied) throw new Error('127.0.0.1:4181 already has a listener; verify its owner before starting the desktop development server.');
const vite = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '4181', '--strictPort'], { cwd: root, stdio: 'inherit', windowsHide: true });
let desktop;
let closing = false;
function close(code = 0) { if (closing) return; closing = true; desktop?.kill(); vite.kill(); process.exitCode = code; }
vite.on('exit', code => close(code || 0));
for (let attempt = 0; attempt < 100 && !closing; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:4181/');
    if (response.ok) {
      desktop = spawn(electron, [root], { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, SCIYUE_DESKTOP_DEV: '1' } });
      desktop.on('exit', code => close(code || 0)); break;
    }
  } catch { /* Vite is still starting. */ }
  await new Promise(resolveWait => setTimeout(resolveWait, 100));
}
if (!desktop) { console.error('Desktop development server did not start on 127.0.0.1:4181'); close(1); }
process.on('SIGINT', () => close()); process.on('SIGTERM', () => close());
