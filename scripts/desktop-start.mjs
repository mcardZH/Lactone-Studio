import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const child = spawn(require('electron'), [root], { cwd: root, stdio: 'inherit', windowsHide: true });
child.on('exit', code => { process.exitCode = code || 0; });
child.on('error', error => { console.error(error); process.exitCode = 1; });
process.on('SIGINT', () => child.kill()); process.on('SIGTERM', () => child.kill());
