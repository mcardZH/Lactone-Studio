import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DEV_RUNTIME_PY = path.join(ROOT, 'scripts/native/dev-runtime.py');

function isRunnablePython(candidate) {
  if (!candidate || !fs.existsSync(candidate)) return false;
  try {
    const out = execFileSync(
      candidate,
      [
        '-I',
        '-S',
        '-B',
        '-c',
        [
          'import sys',
          'exe = sys.executable.replace("\\\\", "/").rstrip("/")',
          'exe_dir = exe.rsplit("/", 1)[0]',
          'is_win = sys.platform == "win32"',
          'exe_root = exe_dir.rsplit("/", 1)[0] if (exe_dir.lower().endswith("/scripts" if is_win else "/bin") and "/" in exe_dir) else exe_dir',
          'pref = sys.prefix.replace("\\\\", "/").rstrip("/")',
          'base_pref = sys.base_prefix.replace("\\\\", "/").rstrip("/")',
          'base_exe = getattr(sys, "_base_executable", "").replace("\\\\", "/").rstrip("/")',
          'ok = (pref.lower() == exe_root.lower()) and (base_pref.lower() == pref.lower()) and (not base_exe or base_exe.lower() == exe.lower())',
          'print(exe if ok else "")'
        ].join('; ')
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }
    ).trim();
    return Boolean(out);
  } catch {
    return false;
  }
}

function lockedToolchainCandidates() {
  const hostId = `${process.platform}-${process.arch}`;
  const profileRelCandidates = [
    `desktop/packaging/native-profile.${hostId}.json`,
    'desktop/packaging/native-profile.json'
  ];
  const found = [];
  for (const rel of profileRelCandidates) {
    const profPath = path.join(ROOT, rel);
    if (!fs.existsSync(profPath)) continue;
    try {
      const prof = JSON.parse(fs.readFileSync(profPath, 'utf8'));
      if (typeof prof.toolchainLock === 'string') {
        const tcLockPath = path.join(ROOT, prof.toolchainLock);
        if (fs.existsSync(tcLockPath)) {
          const tcLock = JSON.parse(fs.readFileSync(tcLockPath, 'utf8'));
          if (typeof tcLock.root === 'string' && typeof tcLock.python === 'string') {
            found.push(path.join(ROOT, tcLock.root, tcLock.python));
          }
        }
      }
    } catch {
      // ignore malformed lock during candidate discovery
    }
  }
  return found;
}

function findPythonInterpreter() {
  const darwinArm64 = path.join(
    ROOT,
    '.local/toolchains/darwin-arm64/conda-py312-arm64/python/bin/python3'
  );
  const darwinX64 = path.join(
    ROOT,
    '.local/toolchains/darwin-x64/conda-py312-x64/python/bin/python3'
  );
  const darwinCandidates =
    process.arch === 'x64' ? [darwinX64, darwinArm64] : [darwinArm64, darwinX64];

  const candidates = [
    process.env.SCIYUE_PYTHON,
    ...lockedToolchainCandidates(),
    ...darwinCandidates,
    '/opt/anaconda3/envs/ester-studio/bin/python3',
    '/opt/anaconda3/bin/python3',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3'
  ].filter(Boolean);

  for (const c of candidates) {
    if (isRunnablePython(c)) return c;
  }

  for (const cmd of ['python', 'python3']) {
    try {
      const out = execFileSync(cmd, ['-c', 'import sys; print(sys.executable)'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      if (isRunnablePython(out)) return out;
    } catch {
      // continue
    }
  }
  return null;
}

function createPortableLink(targetPath, linkPath, options = {}) {
  try {
    fs.symlinkSync(targetPath, linkPath);
  } catch (err) {
    if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'ENOSYS')) {
      const junctionTarget = `${linkPath}-junction-target`;
      fs.mkdirSync(junctionTarget, { recursive: true });
      fs.symlinkSync(junctionTarget, linkPath, 'junction');
      if (options.dangling) {
        fs.rmSync(junctionTarget, { recursive: true, force: true });
      }
      return;
    }
    throw err;
  }
}

test('scripts/native/dev-runtime.py enforces fixed parent roots, resists _PYTHON_HOST_PLATFORM spoofing, preserves .zip stdlib, and registers Windows DLL roots', () => {
  assert.equal(fs.existsSync(DEV_RUNTIME_PY), true);

  const pyExec = findPythonInterpreter();
  assert.ok(pyExec, 'Expected an available Python 3 interpreter to test dev-runtime.py');
  const pyVerNoDot = execFileSync(
    pyExec,
    ['-c', 'import sys; print(f"{sys.version_info.major}{sys.version_info.minor}")'],
    { encoding: 'utf8' }
  ).trim();

  const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'es-dev-rt-unit-'));
  try {
    // 1. Construct a mock win32-x64 project inside a parent directory named 'site-packages'
    const appDir = path.join(tmpDir, 'site-packages', 'my-app');
    const tcDir = path.join(appDir, '.local/toolchains/win-x64/tc-1');
    const depDir = path.join(appDir, '.local/dependencies/win-x64/dep-1');
    fs.mkdirSync(path.join(tcDir, 'python/DLLs'), { recursive: true });
    fs.mkdirSync(path.join(tcDir, 'python/Lib/site-packages'), { recursive: true });
    fs.mkdirSync(path.join(tcDir, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(depDir, 'python/Library/bin'), { recursive: true });
    fs.mkdirSync(path.join(depDir, 'python/Lib/site-packages'), { recursive: true });
    fs.mkdirSync(path.join(appDir, 'desktop/chemistry'), { recursive: true });
    fs.mkdirSync(path.join(appDir, 'desktop/packaging'), { recursive: true });
    fs.writeFileSync(path.join(tcDir, 'python/python.exe'), 'exe');
    fs.writeFileSync(path.join(tcDir, 'python/python312._pth'), 'Lib\nDLLs\n.\n');
    fs.writeFileSync(path.join(tcDir, 'python/python312.zip'), 'PK\x05\x06' + '\x00'.repeat(18));
    fs.writeFileSync(
      path.join(tcDir, `python/python${pyVerNoDot}.zip`),
      'PK\x05\x06' + '\x00'.repeat(18)
    );
    fs.writeFileSync(path.join(tcDir, 'tools/build_only_pkg.py'), 'BUILD_ONLY = True\n');
    fs.writeFileSync(
      path.join(depDir, 'python/Lib/site-packages/win_locked_pkg.py'),
      'WIN_OK = True\n'
    );
    fs.writeFileSync(
      path.join(appDir, 'desktop/chemistry/engine.py'),
      'import sys, win_locked_pkg; sys._ENGINE_RAN_OK = win_locked_pkg.WIN_OK\n'
    );
    fs.writeFileSync(
      path.join(appDir, 'desktop/packaging/native-profile.json'),
      JSON.stringify({
        schema: 'sciyue-native-profile-v1',
        platform: 'win32-x64',
        runtimeLock: 'desktop/packaging/nonexistent-legacy.lock.json',
        toolchainLock: 'desktop/packaging/native-toolchain.lock.json'
      })
    );
    fs.writeFileSync(
      path.join(appDir, 'desktop/packaging/native-profile.win32-x64.json'),
      JSON.stringify({
        schema: 'sciyue-native-profile-v1',
        platform: 'win32-x64',
        runtimeLock: 'desktop/packaging/native-runtime.lock.json',
        toolchainLock: 'desktop/packaging/native-toolchain.lock.json'
      })
    );
    fs.writeFileSync(
      path.join(appDir, 'desktop/packaging/native-runtime.lock.json'),
      JSON.stringify({
        schema: 'sciyue-native-runtime-lock-v1',
        platform: 'win32-x64',
        root: '.local/dependencies/win-x64/dep-1',
        contentDirectories: ['python']
      })
    );
    fs.writeFileSync(
      path.join(appDir, 'desktop/packaging/native-toolchain.lock.json'),
      JSON.stringify({
        schema: 'sciyue-native-toolchain-lock-v1',
        platform: 'win32-x64',
        root: '.local/toolchains/win-x64/tc-1',
        contentDirectories: ['python', 'tools'],
        python: 'python/python.exe'
      })
    );

    // Prepare a poison external directory with __future__.py and pkgutil.py, plus a poison toolchain parent directory
    const poisonDir = path.join(tmpDir, 'external-poison-pth');
    fs.mkdirSync(poisonDir, { recursive: true });
    fs.writeFileSync(
      path.join(poisonDir, '__future__.py'),
      'raise RuntimeError("POISON_EXTERNAL_FUTURE_IMPORTED")\n'
    );
    fs.writeFileSync(
      path.join(poisonDir, 'pkgutil.py'),
      'raise RuntimeError("POISON_EXTERNAL_PKGUTIL_IMPORTED")\n'
    );
    fs.writeFileSync(
      path.join(tcDir, 'pkgutil.py'),
      'raise RuntimeError("POISON_ANCESTOR_PKGUTIL_IMPORTED")\n'
    );

    // Prepare synthetic Mach-O binaries (arm64, x86_64, Universal2, and unknown format)
    const machoDir = path.join(tmpDir, 'macho-fixtures');
    fs.mkdirSync(machoDir, { recursive: true });
    const arm64Bin = path.join(machoDir, 'arm64-single');
    const x64Bin = path.join(machoDir, 'x64-single');
    const universalBin = path.join(machoDir, 'universal2');
    const unknownBin = path.join(machoDir, 'unknown-script');

    fs.writeFileSync(arm64Bin, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]));
    fs.writeFileSync(x64Bin, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]));

    const fatBuf = Buffer.alloc(48, 0);
    fatBuf.writeUInt32BE(0xcafebabe, 0);
    fatBuf.writeUInt32BE(2, 4);
    fatBuf.writeUInt32BE(0x01000007, 8);
    fatBuf.writeUInt32BE(0x0100000c, 28);
    fs.writeFileSync(universalBin, fatBuf);
    fs.writeFileSync(unknownBin, '#!/bin/sh\necho hi\n');

    // Prepare a project where a parent directory of contentDirectories is replaced with a symlink/junction
    const symlinkSwapApp = path.join(tmpDir, 'symlink-swap-app');
    const extTarget = path.join(tmpDir, 'external-python-dir');
    fs.mkdirSync(path.join(extTarget, 'Lib/site-packages'), { recursive: true });
    fs.writeFileSync(path.join(extTarget, 'Lib/site-packages/ext_mod.py'), 'EXT = 1\n');
    const swapTc = path.join(symlinkSwapApp, '.local/toolchains/win-x64/tc-1');
    const swapDep = path.join(symlinkSwapApp, '.local/dependencies/win-x64/dep-1');
    fs.mkdirSync(path.join(swapTc, 'python/DLLs'), { recursive: true });
    fs.mkdirSync(swapDep, { recursive: true });
    fs.symlinkSync(
      extTarget,
      path.join(swapDep, 'python'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    fs.mkdirSync(path.join(symlinkSwapApp, 'desktop/chemistry'), { recursive: true });
    fs.mkdirSync(path.join(symlinkSwapApp, 'desktop/packaging'), { recursive: true });
    fs.writeFileSync(path.join(swapTc, 'python/python.exe'), 'exe');
    fs.writeFileSync(path.join(symlinkSwapApp, 'desktop/chemistry/engine.py'), '# engine\n');
    fs.writeFileSync(
      path.join(symlinkSwapApp, 'desktop/packaging/native-profile.win32-x64.json'),
      JSON.stringify({
        schema: 'sciyue-native-profile-v1',
        platform: 'win32-x64',
        runtimeLock: 'desktop/packaging/native-runtime.lock.json',
        toolchainLock: 'desktop/packaging/native-toolchain.lock.json'
      })
    );
    fs.writeFileSync(
      path.join(symlinkSwapApp, 'desktop/packaging/native-runtime.lock.json'),
      JSON.stringify({
        schema: 'sciyue-native-runtime-lock-v1',
        platform: 'win32-x64',
        root: '.local/dependencies/win-x64/dep-1',
        contentDirectories: ['python/Lib/site-packages']
      })
    );
    fs.writeFileSync(
      path.join(symlinkSwapApp, 'desktop/packaging/native-toolchain.lock.json'),
      JSON.stringify({
        schema: 'sciyue-native-toolchain-lock-v1',
        platform: 'win32-x64',
        root: '.local/toolchains/win-x64/tc-1',
        contentDirectories: ['python'],
        python: 'python/python.exe'
      })
    );

    // Prepare a project where native-profile.<platform>.json is a dangling link
    const danglingProfApp = path.join(tmpDir, 'dangling-prof-app');
    fs.mkdirSync(path.join(danglingProfApp, 'desktop/packaging'), { recursive: true });
    fs.writeFileSync(
      path.join(danglingProfApp, 'desktop/packaging/native-profile.json'),
      JSON.stringify({
        schema: 'sciyue-native-profile-v1',
        platform: 'win32-x64',
        runtimeLock: 'desktop/packaging/native-runtime.lock.json',
        toolchainLock: 'desktop/packaging/native-toolchain.lock.json'
      })
    );
    createPortableLink(
      path.join(tmpDir, 'nonexistent-profile.json'),
      path.join(danglingProfApp, 'desktop/packaging/native-profile.win32-x64.json'),
      { dangling: true }
    );

    // Construct an invalid project where toolchainLock.root points outside .local/toolchains/<platform>
    const badAppDir = path.join(tmpDir, 'bad-root-app');
    fs.mkdirSync(path.join(badAppDir, 'custom-tc/python/bin'), { recursive: true });
    fs.mkdirSync(path.join(badAppDir, '.local/dependencies/darwin-arm64/dep-1/python'), {
      recursive: true
    });
    fs.mkdirSync(path.join(badAppDir, 'desktop/chemistry'), { recursive: true });
    fs.mkdirSync(path.join(badAppDir, 'desktop/packaging'), { recursive: true });
    fs.writeFileSync(path.join(badAppDir, 'custom-tc/python/bin/python3'), 'py');
    fs.writeFileSync(path.join(badAppDir, 'desktop/chemistry/engine.py'), '# engine\n');
    fs.writeFileSync(
      path.join(badAppDir, 'desktop/packaging/native-profile.darwin-arm64.json'),
      JSON.stringify({
        schema: 'sciyue-native-profile-v1',
        platform: 'darwin-arm64',
        runtimeLock: 'desktop/packaging/native-runtime.darwin-arm64.lock.json',
        toolchainLock: 'desktop/packaging/native-toolchain.darwin-arm64.lock.json'
      })
    );
    fs.writeFileSync(
      path.join(badAppDir, 'desktop/packaging/native-runtime.darwin-arm64.lock.json'),
      JSON.stringify({
        schema: 'sciyue-native-runtime-lock-v1',
        platform: 'darwin-arm64',
        root: '.local/dependencies/darwin-arm64/dep-1',
        contentDirectories: ['python']
      })
    );
    fs.writeFileSync(
      path.join(badAppDir, 'desktop/packaging/native-toolchain.darwin-arm64.lock.json'),
      JSON.stringify({
        schema: 'sciyue-native-toolchain-lock-v1',
        platform: 'darwin-arm64',
        root: 'custom-tc',
        contentDirectories: ['python'],
        python: 'python/bin/python3'
      })
    );

    const probeCode = [
      'import importlib.util, json, os, pathlib, sys',
      'orig_uname = getattr(os, "uname", None)',
      'def raising_uname():',
      '    raise PermissionError("sandbox blocked uname")',
      'if orig_uname is not None:',
      '    os.uname = raising_uname',
      'os.environ["_PYTHON_HOST_PLATFORM"] = "darwin-arm64"',
      `spec = importlib.util.spec_from_file_location("dev_runtime", ${JSON.stringify(DEV_RUNTIME_PY)})`,
      'mod = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(mod)',
      // Verify os.uname was NOT globally overwritten on module import
      'uname_not_monkeypatched = (getattr(os, "uname", None) is raising_uname) if orig_uname is not None else True',
      'env_host_plat_cleared = "_PYTHON_HOST_PLATFORM" not in os.environ',
      'orig_plat = sys.platform',
      'orig_exe = sys.executable',
      'orig_base_exe = getattr(sys, "_base_executable", "")',
      'orig_prefix = sys.prefix',
      'orig_base_prefix = sys.base_prefix',
      'sys.platform = "darwin"',
      `sys.executable = ${JSON.stringify(arm64Bin)}`,
      'uname_fallback_worked = (mod.detect_host_platform() == "darwin-arm64")',
      // Test Universal 2 Mach-O fallback WHILE os.uname is raising PermissionError AND ctypes is not yet in sys.modules
      'if orig_plat == "darwin":',
      '    sys.modules.pop("ctypes", None)',
      `    universal_active = mod._infer_darwin_arch_without_uname(${JSON.stringify(universalBin)}, allow_process_probe=True)`,
      '    python_process_arch = mod._probe_active_darwin_process_arch()',
      '    uname_restored_after_probe = (getattr(os, "uname", None) is raising_uname)',
      'else:',
      '    universal_active = "skipped-non-darwin"',
      '    python_process_arch = "skipped-non-darwin"',
      '    uname_restored_after_probe = True',
      'if hasattr(os, "uname") and hasattr(os, "uname_result"):',
      '    os.uname = lambda: os.uname_result(("Darwin", "mac", "24.0.0", "Darwin", "x86_64"))',
      'else:',
      '    class _U: machine = "x86_64"',
      '    os.uname = lambda: _U()',
      'x64_detected = mod.detect_host_platform()',
      'if hasattr(os, "uname") and hasattr(os, "uname_result"):',
      '    os.uname = lambda: os.uname_result(("Darwin", "mac", "24.0.0", "Darwin", "arm64"))',
      'else:',
      '    class _U2: machine = "arm64"',
      '    os.uname = lambda: _U2()',
      'arm64_detected = mod.detect_host_platform()',
      // Test _infer_darwin_arch_without_uname directly on synthetic Mach-O files
      `macho_arm64 = mod._infer_darwin_arch_without_uname(${JSON.stringify(arm64Bin)}, allow_process_probe=False)`,
      `macho_x64 = mod._infer_darwin_arch_without_uname(${JSON.stringify(x64Bin)}, allow_process_probe=False)`,
      'universal_no_probe_rejected = False',
      'try:',
      `    mod._infer_darwin_arch_without_uname(${JSON.stringify(universalBin)}, allow_process_probe=False)`,
      'except RuntimeError as e:',
      '    universal_no_probe_rejected = "Ambiguous multi-architecture" in str(e)',
      'unknown_bin_rejected = False',
      'try:',
      `    mod._infer_darwin_arch_without_uname(${JSON.stringify(unknownBin)}, allow_process_probe=False)`,
      'except RuntimeError as e:',
      '    unknown_bin_rejected = "DEV_RUNTIME_PLATFORM_UNSUPPORTED" in str(e)',
      // Restore real interpreter platform and executable before testing _bootstrap_scrub_initial_sys_path
      'sys.platform = orig_plat',
      'sys.executable = orig_exe',
      'sys._base_executable = orig_base_exe',
      'sys.prefix = orig_prefix',
      'sys.base_prefix = orig_base_prefix',
      // Test _bootstrap_scrub_initial_sys_path with mixed external + ancestor + stdlib paths, with ONLY external + ancestor paths (0 matching stdlib entries), and with pyvenv.cfg-style escaped base_prefix/_base_executable
      `poison_dir = ${JSON.stringify(poisonDir)}`,
      `ancestor_tc_dir = ${JSON.stringify(tcDir)}`,
      'orig_sys_path = list(sys.path)',
      'sys.path[:] = [poison_dir, ancestor_tc_dir, *orig_sys_path]',
      'mod._bootstrap_scrub_initial_sys_path()',
      'poison_scrubbed = (poison_dir not in sys.path) and (ancestor_tc_dir not in sys.path) and (len(sys.path) > 0)',
      'empty_match_rejected = False',
      'sys.path[:] = [poison_dir, ancestor_tc_dir]',
      'try:',
      '    mod._bootstrap_scrub_initial_sys_path()',
      'except RuntimeError as e:',
      '    empty_match_rejected = ("DEV_RUNTIME_LOCK_INVALID" in str(e)) and (len(sys.path) == 0)',
      'venv_escape_rejected = False',
      'sys.path[:] = list(orig_sys_path)',
      'sys._base_executable = "/external/venv/bin/python3"',
      'try:',
      '    mod._bootstrap_scrub_initial_sys_path()',
      'except RuntimeError as e:',
      '    venv_escape_rejected = ("DEV_RUNTIME_PREFIX_ESCAPED" in str(e)) and (len(sys.path) == 0)',
      'sys._base_executable = orig_base_exe',
      'sys.path[:] = orig_sys_path',
      // Test non-.local/toolchains root rejection on badAppDir (explicitly set sys.platform = "darwin" to match badAppDir's darwin-arm64 profile on any host)
      'sys.platform = "darwin"',
      `bad_app = pathlib.Path(${JSON.stringify(badAppDir)}).resolve()`,
      'sys.executable = str(bad_app / "custom-tc/python/bin/python3")',
      'sys.prefix = str(bad_app / "custom-tc/python")',
      'sys.base_prefix = sys.prefix',
      'bad_root_rejected = False',
      'try:',
      '    mod.configure_isolated_paths(bad_app)',
      'except RuntimeError as e:',
      '    bad_root_rejected = "DEV_RUNTIME_LOCK_INVALID" in str(e)',
      // Test dangling native-profile.<platform>.json rejection (no fallback to native-profile.json)
      `dangling_app = pathlib.Path(${JSON.stringify(danglingProfApp)}).resolve()`,
      'dangling_prof_rejected = False',
      'try:',
      '    mod.load_active_profile(dangling_app, "win32-x64")',
      'except RuntimeError as e:',
      '    dangling_prof_rejected = "DEV_RUNTIME_LOCK_INVALID" in str(e)',
      // Test symlinked parent directory under dep_root rejection on symlinkSwapApp
      'sys.platform = "win32"',
      `swap_app = pathlib.Path(${JSON.stringify(symlinkSwapApp)}).resolve()`,
      'sys.executable = str(swap_app / ".local/toolchains/win-x64/tc-1/python/python.exe")',
      'sys.prefix = str(swap_app / ".local/toolchains/win-x64/tc-1/python")',
      'sys.base_prefix = sys.prefix',
      'symlink_parent_rejected = False',
      'try:',
      '    mod.configure_isolated_paths(swap_app)',
      'except RuntimeError as e:',
      '    symlink_parent_rejected = "DEV_RUNTIME_LOCK_INVALID" in str(e)',
      // Test Windows configure_isolated_paths + DLL registration + python312.zip preservation + non-stdlib tools exclusion + ._pth validation + site-packages parent directory + platform profile priority
      'win_host = mod.detect_host_platform()',
      `tmp_app = pathlib.Path(${JSON.stringify(appDir)}).resolve()`,
      'sys.executable = str(tmp_app / ".local/toolchains/win-x64/tc-1/python/python.exe")',
      'sys.prefix = str(tmp_app / ".local/toolchains/win-x64/tc-1/python")',
      'sys.base_prefix = sys.prefix',
      `sys.path[:] = [str(tmp_app / ".local/toolchains/win-x64/tc-1/python/python312.zip"), str(tmp_app / ".local/toolchains/win-x64/tc-1/python/python${pyVerNoDot}.zip"), str(tmp_app / ".local/toolchains/win-x64/tc-1/python/DLLs"), str(tmp_app / ".local/toolchains/win-x64/tc-1/python/Lib"), str(tmp_app / ".local/toolchains/win-x64/tc-1/python/Lib/site-packages"), str(tmp_app / ".local/toolchains/win-x64/tc-1/tools")]`,
      'os.environ["rdbase"] = "/bad/ambient/rdbase"',
      'added_dlls = []',
      'os.add_dll_directory = lambda p: added_dlls.append(p) or p',
      'chem_dir, dep_root = mod.configure_isolated_paths(tmp_app)',
      `zip_preserved = (str((tmp_app / ".local/toolchains/win-x64/tc-1/python/python312.zip").resolve()) in sys.path) and (str((tmp_app / ".local/toolchains/win-x64/tc-1/python/python${pyVerNoDot}.zip").resolve()) in sys.path)`,
      'stdlib_preserved = str((tmp_app / ".local/toolchains/win-x64/tc-1/python/DLLs").resolve()) in sys.path',
      'tc_site_dropped = str((tmp_app / ".local/toolchains/win-x64/tc-1/python/Lib/site-packages").resolve()) not in sys.path',
      'tc_tools_dropped = str((tmp_app / ".local/toolchains/win-x64/tc-1/tools").resolve()) not in sys.path',
      'mod.resolve_app_path = lambda: tmp_app',
      'mod.main()',
      'engine_ran_ok = getattr(sys, "_ENGINE_RAN_OK", False)',
      // Verify invalid ._pth content and nested tools/venv/pyvenv.cfg are rejected by configure_isolated_paths
      '(tmp_app / ".local/toolchains/win-x64/tc-1/python/python312._pth").write_text("../tools\\n", encoding="utf-8")',
      'bad_pth_rejected = False',
      'try:',
      '    mod.configure_isolated_paths(tmp_app)',
      'except RuntimeError as e:',
      '    bad_pth_rejected = "DEV_RUNTIME_LOCK_INVALID" in str(e)',
      '(tmp_app / ".local/toolchains/win-x64/tc-1/python/python312._pth").write_text("Lib\\nDLLs\\n.\\n", encoding="utf-8")',
      '(tmp_app / ".local/toolchains/win-x64/tc-1/tools/venv").mkdir(parents=True, exist_ok=True)',
      '(tmp_app / ".local/toolchains/win-x64/tc-1/tools/venv/pyvenv.cfg").write_text("home = C:/Python312\\n", encoding="utf-8")',
      'nested_pyvenv_rejected = False',
      'try:',
      '    mod.configure_isolated_paths(tmp_app)',
      'except RuntimeError as e:',
      '    nested_pyvenv_rejected = ("DEV_RUNTIME_LOCK_INVALID" in str(e)) and ("pyvenv.cfg" in str(e))',
      'print(json.dumps({',
      '    "uname_not_monkeypatched": uname_not_monkeypatched,',
      '    "uname_restored_after_probe": uname_restored_after_probe,',
      '    "uname_fallback_worked": uname_fallback_worked,',
      '    "env_host_plat_cleared": env_host_plat_cleared,',
      '    "x64_detected": x64_detected,',
      '    "arm64_detected": arm64_detected,',
      '    "macho_arm64": macho_arm64,',
      '    "macho_x64": macho_x64,',
      '    "universal_no_probe_rejected": universal_no_probe_rejected,',
      '    "unknown_bin_rejected": unknown_bin_rejected,',
      '    "universal_active": universal_active,',
      '    "python_process_arch": python_process_arch,',
      '    "poison_scrubbed": poison_scrubbed,',
      '    "empty_match_rejected": empty_match_rejected,',
      '    "venv_escape_rejected": venv_escape_rejected,',
      '    "bad_root_rejected": bad_root_rejected,',
      '    "dangling_prof_rejected": dangling_prof_rejected,',
      '    "symlink_parent_rejected": symlink_parent_rejected,',
      '    "win_host": win_host,',
      '    "added_dll_count": len(getattr(sys, "_sciyue_dll_handles", [])),',
      '    "zip_preserved": zip_preserved,',
      '    "stdlib_preserved": stdlib_preserved,',
      '    "tc_site_dropped": tc_site_dropped,',
      '    "tc_tools_dropped": tc_tools_dropped,',
      '    "bad_pth_rejected": bad_pth_rejected,',
      '    "nested_pyvenv_rejected": nested_pyvenv_rejected,',
      '    "engine_ran_ok": engine_ran_ok,',
      '    "rdbase_after": os.environ.get("rdbase") or os.environ.get("RDBASE"),',
      '    "omp": os.environ.get("OMP_NUM_THREADS")',
      '}))'
    ].join('\n');

    const out = execFileSync(pyExec, ['-I', '-S', '-B', '-c', probeCode], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.uname_not_monkeypatched, true);
    assert.equal(parsed.uname_restored_after_probe, true);
    assert.equal(parsed.uname_fallback_worked, true);
    assert.equal(parsed.env_host_plat_cleared, true);
    assert.equal(parsed.x64_detected, 'darwin-x64');
    assert.equal(parsed.arm64_detected, 'darwin-arm64');
    assert.equal(parsed.macho_arm64, 'arm64');
    assert.equal(parsed.macho_x64, 'x86_64');
    assert.equal(parsed.universal_no_probe_rejected, true);
    assert.equal(parsed.unknown_bin_rejected, true);
    if (process.platform === 'darwin') {
      assert.ok(parsed.python_process_arch === 'arm64' || parsed.python_process_arch === 'x86_64');
      assert.equal(parsed.universal_active, parsed.python_process_arch);
    }
    assert.equal(parsed.poison_scrubbed, true);
    assert.equal(parsed.empty_match_rejected, true);
    assert.equal(parsed.venv_escape_rejected, true);
    assert.equal(parsed.bad_root_rejected, true);
    assert.equal(parsed.dangling_prof_rejected, true);
    assert.equal(parsed.symlink_parent_rejected, true);
    assert.equal(parsed.win_host, 'win32-x64');
    assert.equal(parsed.added_dll_count, 3);
    assert.equal(parsed.zip_preserved, true);
    assert.equal(parsed.stdlib_preserved, true);
    assert.equal(parsed.tc_site_dropped, true);
    assert.equal(parsed.tc_tools_dropped, true);
    assert.equal(parsed.bad_pth_rejected, true);
    assert.equal(parsed.nested_pyvenv_rejected, true);
    assert.equal(parsed.engine_ran_ok, true);
    assert.equal(parsed.rdbase_after, null);
    assert.equal(parsed.omp, '1');

    // Verify top-level execution of dev-runtime.py:
    // (a) when initial sys.path has poisonDir + ancestor tcDir + stdlib: scrubs poisonDir & tcDir before importing __future__/pkgutil
    // (b) when initial sys.path has ONLY poisonDir + ancestor tcDir (no stdlib): clears sys.path and raises DEV_RUNTIME_LOCK_INVALID without importing __future__/pkgutil
    const topLevelExecCode = [
      'import sys',
      'orig_std = list(sys.path)',
      `sys.path[:] = [${JSON.stringify(poisonDir)}, ${JSON.stringify(tcDir)}, *orig_std]`,
      'sys.modules.pop("__future__", None)',
      'sys.modules.pop("pkgutil", None)',
      `with open(${JSON.stringify(DEV_RUNTIME_PY)}, "rb") as f:`,
      `    code = compile(f.read(), ${JSON.stringify(DEV_RUNTIME_PY)}, "exec")`,
      'ns = {"__name__": "__not_main__", "__file__": ' + JSON.stringify(DEV_RUNTIME_PY) + '}',
      'exec(code, ns)',
      `assert ${JSON.stringify(poisonDir)} not in sys.path`,
      `assert ${JSON.stringify(tcDir)} not in sys.path`,
      `sys.path[:] = [${JSON.stringify(poisonDir)}, ${JSON.stringify(tcDir)}]`,
      'sys.modules.pop("__future__", None)',
      'sys.modules.pop("pkgutil", None)',
      'rejected_only_external = False',
      'try:',
      '    exec(code, {"__name__": "__not_main__", "__file__": ' + JSON.stringify(DEV_RUNTIME_PY) + '})',
      'except RuntimeError as e:',
      '    rejected_only_external = ("DEV_RUNTIME_LOCK_INVALID" in str(e)) and (len(sys.path) == 0)',
      'assert rejected_only_external',
      'print("TOP_LEVEL_SCRUB_OK")'
    ].join('\n');
    const topOut = execFileSync(pyExec, ['-I', '-S', '-B', '-c', topLevelExecCode], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    assert.equal(topOut.trim(), 'TOP_LEVEL_SCRUB_OK');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function prepareStandalonePythonCopy(pyExec, targetPyDir) {
  const pyInfo = JSON.parse(
    execFileSync(
      pyExec,
      [
        '-I',
        '-S',
        '-B',
        '-c',
        'import json, sys; print(json.dumps({"prefix": sys.prefix, "ver_dot": f"{sys.version_info.major}.{sys.version_info.minor}", "ver_nodot": f"{sys.version_info.major}{sys.version_info.minor}"}))'
      ],
      { encoding: 'utf8' }
    ).trim()
  );
  const isWin = process.platform === 'win32';
  const binDir = isWin ? targetPyDir : path.join(targetPyDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const copiedPy = path.join(binDir, isWin ? 'python.exe' : 'python3');
  fs.copyFileSync(pyExec, copiedPy);

  if (isWin) {
    const srcExeDir = path.dirname(pyExec);
    for (const entry of fs.readdirSync(srcExeDir)) {
      if (entry.toLowerCase().endsWith('.dll')) {
        fs.copyFileSync(path.join(srcExeDir, entry), path.join(binDir, entry));
      }
    }
  }

  const srcStdlibDir = isWin
    ? path.join(pyInfo.prefix, 'Lib')
    : path.join(pyInfo.prefix, 'lib', `python${pyInfo.ver_dot}`);
  const pthFilePath = isWin
    ? path.join(binDir, `python${pyInfo.ver_nodot}._pth`)
    : path.join(binDir, 'python3._pth');
  const pyvenvCfgPath = path.join(targetPyDir, 'pyvenv.cfg');

  return { pyInfo, isWin, binDir, copiedPy, srcStdlibDir, pthFilePath, pyvenvCfgPath };
}

function populateMinimalBootStdlib(srcStdlibDir, pyPrefix, isWin, verNoDot, destStdlibDir) {
  fs.mkdirSync(destStdlibDir, { recursive: true });
  const encPath = path.join(srcStdlibDir, 'encodings');
  const codecsPath = path.join(srcStdlibDir, 'codecs.py');
  if (fs.existsSync(encPath) && fs.existsSync(codecsPath)) {
    fs.symlinkSync(
      encPath,
      path.join(destStdlibDir, 'encodings'),
      isWin ? 'junction' : 'dir'
    );
    fs.copyFileSync(codecsPath, path.join(destStdlibDir, 'codecs.py'));
  } else {
    const zipCandidate = path.join(pyPrefix, `python${verNoDot}.zip`);
    assert.equal(
      fs.existsSync(zipCandidate),
      true,
      `Expected either filesystem encodings or ${zipCandidate} in Python installation`
    );
    execFileSync(
      process.platform === 'win32' ? 'tar.exe' : 'unzip',
      process.platform === 'win32'
        ? ['-xf', zipCandidate, '-C', destStdlibDir, 'encodings', 'codecs.py', 'codecs.pyc']
        : ['-q', zipCandidate, 'encodings/*', 'codecs.*', '-d', destStdlibDir],
      { stdio: 'ignore' }
    );
  }
  const dynloadSrc = path.join(srcStdlibDir, 'lib-dynload');
  if (fs.existsSync(dynloadSrc)) {
    fs.symlinkSync(
      dynloadSrc,
      path.join(destStdlibDir, 'lib-dynload'),
      isWin ? 'junction' : 'dir'
    );
  }
}

test('scripts/native/dev-runtime.py subprocess rejects external ._pth before importing __future__ or pkgutil', () => {
  const pyExec = findPythonInterpreter();
  assert.ok(pyExec, 'Expected a self-contained Python 3 interpreter to test ._pth subprocess');

  const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'es-dev-rt-pth-sub-'));
  try {
    const tcDir = path.join(tmpDir, 'pth-subproc-tc');
    const targetPyDir = path.join(tcDir, 'python');
    const { pyInfo, isWin, copiedPy, srcStdlibDir, pthFilePath } = prepareStandalonePythonCopy(
      pyExec,
      targetPyDir
    );

    const extStdlib = path.join(tmpDir, 'ext-stdlib-poison');
    populateMinimalBootStdlib(srcStdlibDir, pyInfo.prefix, isWin, pyInfo.ver_nodot, extStdlib);
    fs.writeFileSync(
      path.join(extStdlib, '__future__.py'),
      'raise RuntimeError("POISON_SUBPROC_FUTURE_EXECUTED")\n'
    );
    fs.writeFileSync(
      path.join(extStdlib, 'pkgutil.py'),
      'raise RuntimeError("POISON_SUBPROC_PKGUTIL_EXECUTED")\n'
    );
    fs.writeFileSync(
      path.join(tcDir, 'pkgutil.py'),
      'raise RuntimeError("POISON_ANCESTOR_PKGUTIL_IMPORTED")\n'
    );
    const pthLines = [extStdlib];
    if (fs.existsSync(path.join(extStdlib, 'lib-dynload'))) {
      pthLines.push(path.join(extStdlib, 'lib-dynload'));
    }
    pthLines.push(tcDir);
    fs.writeFileSync(pthFilePath, pthLines.join('\n') + '\n');

    assert.throws(
      () =>
        execFileSync(copiedPy, ['-I', '-S', '-B', DEV_RUNTIME_PY], {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: 'pipe'
        }),
      (err) => {
        const stderr = String(err.stderr || '');
        assert.equal(stderr.includes('POISON_SUBPROC_FUTURE_EXECUTED'), false);
        assert.equal(stderr.includes('POISON_SUBPROC_PKGUTIL_EXECUTED'), false);
        assert.equal(stderr.includes('POISON_ANCESTOR_PKGUTIL_IMPORTED'), false);
        assert.equal(
          stderr.includes(
            'DEV_RUNTIME_LOCK_INVALID: No admitted standard library path in initial sys.path.'
          ),
          true,
          `Unexpected stderr: ${stderr}`
        );
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scripts/native/dev-runtime.py subprocess rejects pyvenv.cfg before importing external stdlib json or pkgutil', () => {
  const pyExec = findPythonInterpreter();
  assert.ok(pyExec, 'Expected a self-contained Python 3 interpreter to test pyvenv.cfg subprocess');

  const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'es-dev-rt-venv-sub-'));
  try {
    const tcDir = path.join(tmpDir, 'venv-subproc-tc');
    const targetPyDir = path.join(tcDir, 'python');
    const { pyInfo, isWin, copiedPy, srcStdlibDir, pyvenvCfgPath } = prepareStandalonePythonCopy(
      pyExec,
      targetPyDir
    );

    const extVenvHome = path.join(tmpDir, 'ext-venv-home');
    const extVenvBin = isWin ? extVenvHome : path.join(extVenvHome, 'bin');
    const extVenvLib = isWin
      ? path.join(extVenvHome, 'Lib')
      : path.join(extVenvHome, 'lib', `python${pyInfo.ver_dot}`);
    fs.mkdirSync(extVenvBin, { recursive: true });
    populateMinimalBootStdlib(srcStdlibDir, pyInfo.prefix, isWin, pyInfo.ver_nodot, extVenvLib);
    fs.writeFileSync(
      path.join(extVenvLib, 'json.py'),
      'raise RuntimeError("POISON_VENV_JSON_EXECUTED")\n'
    );
    fs.writeFileSync(
      path.join(extVenvLib, 'pkgutil.py'),
      'raise RuntimeError("POISON_VENV_PKGUTIL_EXECUTED")\n'
    );
    fs.writeFileSync(
      pyvenvCfgPath,
      `home = ${extVenvBin}\ninclude-system-site-packages = false\n`
    );

    assert.throws(
      () =>
        execFileSync(copiedPy, ['-I', '-S', '-B', DEV_RUNTIME_PY], {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: 'pipe'
        }),
      (err) => {
        const stderr = String(err.stderr || '');
        assert.equal(stderr.includes('POISON_VENV_JSON_EXECUTED'), false);
        assert.equal(stderr.includes('POISON_VENV_PKGUTIL_EXECUTED'), false);
        assert.equal(
          stderr.includes('DEV_RUNTIME_PREFIX_ESCAPED'),
          true,
          `Unexpected stderr: ${stderr}`
        );
        return true;
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
