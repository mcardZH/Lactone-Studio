import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const LAUNCHER_C_PATH = path.join(REPO_ROOT, 'scripts/portable/win32-engine-launcher.c');

test('win32-engine-launcher.c enforces regular-file checks, isolated Python env scrubbing, MSVCRT quoting, and Job Object lifetime binding', () => {
  assert.equal(fs.existsSync(LAUNCHER_C_PATH), true);
  const src = fs.readFileSync(LAUNCHER_C_PATH, 'utf8');

  // 1. Reparse-point & directory rejection on python.exe and bootstrap.py
  assert.ok(src.includes('FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT'));
  assert.ok(src.includes('\\\\python\\\\python.exe'));
  assert.ok(src.includes('\\\\bootstrap.py'));

  // 2. Ambient Python/Conda/RDKit environment variable scrubbing
  for (const key of [
    'PYTHONPATH',
    'PYTHONHOME',
    'PYTHONSTARTUP',
    'PYTHONUSERBASE',
    'VIRTUAL_ENV',
    'CONDA_PREFIX',
    'CONDA_DEFAULT_ENV',
    '_PYTHON_SYSCONFIGDATA_NAME',
    'RDBASE',
  ]) {
    assert.ok(src.includes(`L"${key}"`), `Expected ${key} to be scrubbed in win32-engine-launcher.c`);
  }
  assert.ok(src.includes('L"PYTHONNOUSERSITE"'));
  assert.ok(src.includes('L"PYTHONDONTWRITEBYTECODE"'));
  assert.ok(src.includes('L"PYTHONUTF8"'));

  // 3. Isolated Python flags and Win32 Job Object + CREATE_NO_WINDOW | CREATE_SUSPENDED
  assert.ok(src.includes('L" -I -S -B "'));
  assert.ok(src.includes('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE'));
  assert.ok(src.includes('CREATE_NO_WINDOW | CREATE_SUSPENDED'));
  assert.ok(src.includes('AssignProcessToJobObject(job, pi.hProcess)'));
  assert.ok(src.includes('ResumeThread(pi.hThread)'));

  // 4. MSVCRT / CommandLineToArgvW backslash-doubling rule (only double slashes before quote or closing quote)
  assert.ok(src.includes('slashes * ((c == L\'"\' || c == 0) ? 2 : 1)'));
});
