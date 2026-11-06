"""Version-neutral native input identities, path admission and process setup."""
from __future__ import annotations
import os
import sys
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROFILE = 'desktop/packaging/native-profile.json'
DLL_HANDLES = []


def require(condition, message):
    if not condition:
        raise ValueError(message)


def linked(path):
    return path.is_symlink() or getattr(path, 'is_junction', lambda: False)()


def safe(root, target):
    root, target = Path(os.path.abspath(root)), Path(os.path.abspath(target))
    require(target.is_relative_to(root), 'Path escaped declared root: ' + str(target))
    cursor = target
    while cursor.is_relative_to(root):
        require(not linked(cursor), 'Linked input/output is not admitted: ' + str(cursor))
        if cursor == root:
            break
        cursor = cursor.parent
    return target


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def digest(path):
    import hashlib
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        before = os.fstat(stream.fileno())
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
        after = os.fstat(stream.fileno())
    require((before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns), 'Input changed during read')
    return value.hexdigest()


def identity(path, root=ROOT):
    path = safe(root, path)
    return {'path': path.relative_to(root).as_posix(), 'bytes': path.stat().st_size, 'sha256': digest(path)}


def check(row, root=ROOT):
    require(isinstance(row, dict) and set(row) == {'path', 'bytes', 'sha256'}, 'Exact file identity required')
    require(identity(safe(root, Path(root) / row['path']), root) == row, 'Identity changed: ' + row['path'])
    return safe(root, Path(root) / row['path'])


def write_new(path, value):
    path = safe(ROOT, path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False)
        stream.write('\n')


def inventory(root):
    return [identity(safe(root, p), root) for p in sorted(Path(root).rglob('*')) if p.is_file()]


def configuration():
    profile = read(ROOT / PROFILE)
    require(profile['schema'] == 'sciyue-native-profile-v1' and profile['platform'] == 'win32-x64', 'Unsupported native profile')
    result = {'profile': profile, 'profileIdentity': identity(ROOT / PROFILE)}
    for name, parent, schema in (('runtimeLock', '.local/dependencies/win-x64', 'sciyue-native-runtime-lock-v1'),
                                  ('toolchainLock', '.local/toolchains/win-x64', 'sciyue-native-toolchain-lock-v1'),
                                  ('xtbLock', '.local/dependencies/win-x64', 'sciyue-xtb-lock-v1')):
        path = safe(ROOT, ROOT / profile[name])
        value = read(path)
        require(value['schema'] == schema and value['platform'] == 'win32-x64', 'Wrong dependency/toolchain lock')
        root = safe(ROOT / parent, ROOT / value['root'])
        safe(ROOT, root)
        require(root != ROOT / parent, 'Content-specific dependency root required')
        if 'inventory' in value:
            inventory_path = check(value['inventory'])
            safe(root, inventory_path)
            inventory_value = read(inventory_path)
            require(inventory_value['schema'] == schema and inventory_value['root'] == value['root'] and inventory_value['lockId'] == value['lockId'], 'Stable inventory belongs to another lock/root')
            require('files' in inventory_value and 'inventory' not in inventory_value, 'Complete non-recursive stable inventory required')
            value = {**value, 'files': inventory_value['files']}
        result[name], result[name + 'Identity'], result[name + 'Root'] = value, identity(path), root
    return result


def activate(config, require_interpreter=True):
    runtime, toolchain = config['runtimeLockRoot'], config['toolchainLockRoot']
    python = toolchain / 'python'
    if require_interpreter:
        require(Path(sys.executable).resolve() == (python / 'python.exe').resolve(), 'Use the locked standalone Python executable')
        require(Path(sys.prefix).resolve() == python.resolve() and Path(sys.base_prefix).resolve() == python.resolve(), 'Python prefix escaped standalone toolchain')
    require(sys.version_info[:3] == tuple(map(int, config['toolchainLock']['pythonVersion'].split('.'))), 'Python version drift')
    if sys.platform == 'win32':
        for path in (runtime / 'python/Library/bin', python, python / 'DLLs'):
            DLL_HANDLES.append(os.add_dll_directory(str(safe(ROOT, path))))
    sys.path[:] = [str(toolchain / 'tools'), str(runtime / 'python/Lib/site-packages'), str(ROOT / 'scripts/native'),
                   str(python / 'Lib'), str(python / 'DLLs'), str(python)]
    return config


def verify_lock(value, root, full=True):
    files = value['files']
    require(len(files) == len({row['path'] for row in files}), 'Duplicate locked paths')
    if full:
        for row in files:
            check({key: row[key] for key in ('path', 'bytes', 'sha256')}, root)
        actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file() and p.parts[len(root.parts)] in value['contentDirectories']}
        require(actual == {row['path'] for row in files}, 'Stable dependency file membership changed')


def clean_environment(config, temp, threads=1):
    require(type(threads) is int and threads in (1, 2, 4, 8), 'Approved thread limit required')
    temp = safe(ROOT, temp)
    require(temp.is_dir() and temp.name == 'temp' and any(temp.is_relative_to(ROOT / name) for name in ('.cache/builds', '.cache/native-preparation')), 'Existing owned run temp directory required')
    system = Path(os.environ.get('SystemRoot', 'C:/Windows'))
    # Deliberately construct rather than inherit Python/Conda/PATH/compiler state.
    result = {key: os.environ[key] for key in ('SystemRoot', 'WINDIR', 'COMSPEC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE') if key in os.environ}
    result.update({'PATH': os.pathsep.join(map(str, (config['runtimeLockRoot'] / 'python/Library/bin', config['toolchainLockRoot'] / 'python', system / 'System32', system))),
                   'TEMP': str(temp), 'TMP': str(temp), 'USERPROFILE': str(temp), 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUTF8': '1',
                   'OMP_NUM_THREADS': str(threads), 'OPENBLAS_NUM_THREADS': str(threads), 'MKL_NUM_THREADS': str(threads), 'OMP_DYNAMIC': 'FALSE'})
    return result


def _isolated_dll_bootstrap(directories):
    """Runs before the original function in a PyInstaller isolated process."""
    import os
    import sys
    if sys.platform != 'win32' or not all(os.path.isdir(path) for path in directories):
        raise ValueError('Existing declared Windows DLL roots required')
    handles = [os.add_dll_directory(path) for path in directories]
    # The interpreter owns these handles until process exit; returning from this
    # function must not revoke the DLL roots before the original function runs.
    sys._sciyue_isolated_dll_handles = handles
    return {'pid': os.getpid(), 'executable': sys.executable, 'prefix': sys.prefix,
            'registeredDllRoots': list(directories), 'pythonPathEnvironment': os.environ.get('PYTHONPATH'),
            'userProfile': os.environ.get('USERPROFILE')}


def initialize_pyinstaller_children(config, evidence_directory):
    """Adapt the public isolated API, without editing upstream code or functions.

    Public Python and the internal class used by call/decorate are aliases in
    this locked PyInstaller version. Both must use this same scoped initializer.
    """
    from PyInstaller import isolated
    from PyInstaller.isolated import _parent
    require(isolated.Python is _parent.Python, 'PyInstaller isolated entrypoint aliases drifted')
    original = _parent.Python
    require(not getattr(original, '_sciyue_scoped_initializer', False), 'Isolated initializer is already installed')
    directories = [str(safe(ROOT, path)) for path in (config['runtimeLockRoot'] / 'python/Library/bin',
                   config['toolchainLockRoot'] / 'python', config['toolchainLockRoot'] / 'python/DLLs')]
    evidence_directory = safe(ROOT, evidence_directory)
    require(not evidence_directory.exists(), 'Isolated evidence directory is immutable')
    evidence_directory.mkdir(parents=True)
    sequence = [0]

    class ScopedPython(original):
        _sciyue_scoped_initializer = True

        def __enter__(self):
            super().__enter__()
            if not self._already_isolated:
                try:
                    bootstrap = self.call(_isolated_dll_bootstrap, directories)
                    require(Path(bootstrap['executable']).resolve() == (config['toolchainLockRoot'] / config['toolchainLock']['python']).resolve(), 'Isolated child interpreter escaped the lock')
                    sequence[0] += 1
                    write_new(evidence_directory / ('child-' + str(sequence[0]) + '.json'),
                              {'schema': 'sciyue-native-isolated-child-bootstrap/v1', 'bootstrap': bootstrap,
                               'command': list(self._child.args), 'originalFunctionsUnmodified': True})
                except BaseException:
                    super().__exit__(*sys.exc_info())
                    raise
            return self

    isolated.Python = _parent.Python = ScopedPython
    return {'entrypoints': ['PyInstaller.isolated.Python', 'PyInstaller.isolated._parent.Python'],
            'registeredDllRoots': directories, 'upstreamFilesModified': False}


def windows_modules():
    import ctypes
    psapi, kernel = ctypes.WinDLL('psapi', use_last_error=True), ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    process = kernel.GetCurrentProcess()
    array, needed = (ctypes.c_void_p * 4096)(), ctypes.c_ulong()
    psapi.EnumProcessModules.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong)]
    require(psapi.EnumProcessModules(process, array, ctypes.sizeof(array), ctypes.byref(needed)), 'EnumProcessModules failed')
    require(needed.value <= ctypes.sizeof(array), 'Native module inventory incomplete')
    psapi.GetModuleFileNameExW.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_ulong]
    result = []
    for module in array[:needed.value // ctypes.sizeof(ctypes.c_void_p)]:
        buffer = ctypes.create_unicode_buffer(32768)
        require(0 < psapi.GetModuleFileNameExW(process, module, buffer, len(buffer)) < len(buffer), 'Native path inspection failed')
        result.append(str(Path(buffer.value).resolve()))
    return sorted(set(result), key=str.casefold)


def native_graph(root):
    import pefile
    result = []
    for path in sorted(Path(root).rglob('*')):
        if not path.is_file() or path.suffix.lower() not in ('.exe', '.dll', '.pyd', '.obf'):
            continue
        require(not path.name.lower().startswith('mkl'), 'MKL compute DLL is not admitted')
        pe = pefile.PE(str(path), fast_load=True)
        pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_IMPORT'], pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT']])
        imports = []
        for name, kind in (('DIRECTORY_ENTRY_IMPORT', 'import'), ('DIRECTORY_ENTRY_DELAY_IMPORT', 'delay-import')):
            for row in getattr(pe, name, []):
                dll = row.dll.decode('ascii')
                require(not dll.lower().startswith('mkl'), 'Native MKL import is not admitted')
                imports.append({'dll': dll, 'kind': kind})
        pe.close()
        result.append({'path': path.relative_to(root).as_posix(), 'imports': imports})
    return result
