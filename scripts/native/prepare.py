"""Verify stable locked inputs and record a model-free import/source probe."""
from __future__ import annotations
import os
import sys
sys.path.insert(0, os.path.dirname(__file__))
import common as c
from pathlib import Path


PROBE_PACKAGES = {
    'numpy': 'numpy', 'scipy': 'scipy', 'rdkit': 'rdkit', 'ase': 'ase',
    'spglib': 'spglib', 'cffi': 'cffi', 'openbabel.openbabel': 'openbabel-wheel',
    'tblite.library': 'tblite', 'PyInstaller': 'PyInstaller',
}


def probe_plan(config):
    """Apply only the profile's explicit exclusions to the known probe set."""
    profile = config.get('profile', {})
    normalize = lambda value: value.casefold().replace('_', '-')
    excluded = {normalize(name) for name in profile.get('excludedDistributions', [])}
    module_excludes = profile.get('excludes', [])
    omitted = {module for module, distribution in PROBE_PACKAGES.items()
               if normalize(distribution) in excluded or any(module == name or module.startswith(name + '.') for name in module_excludes)}
    excluded.update(normalize(PROBE_PACKAGES[module]) for module in omitted)
    return {'modules': {module: distribution for module, distribution in PROBE_PACKAGES.items() if module not in omitted},
            'excludedModules': sorted(omitted), 'excludedDistributions': sorted(excluded),
            'versions': {name: version for name, version in config['runtimeLock']['versions'].items() if normalize(name) not in excluded}}


def validate_prepare_options(command, reuse_verified, refresh_xtb):
    c.require(not reuse_verified or command == 'prepare', 'Verification reuse is only valid for prepare')
    c.require(not refresh_xtb or command == 'prepare' and reuse_verified, '--refresh-xtb requires prepare with --reuse-verified')


def reuse_verification(config, previous_path, refresh_xtb=False):
    """Reuse only identical runtime/toolchain inputs at the same physical roots."""
    previous_path = c.safe(c.ROOT, previous_path.absolute())
    previous = c.read(previous_path)
    c.require(previous['schema'] == 'sciyue-native-preparation-v1' and previous['passed'] is True and previous['scienceExecuted'] is False,
              'Successful prior verification and its actual probe are required')
    components = {}
    for name in ('runtimeLock', 'toolchainLock'):
        c.check(config[name + 'Identity'])
        inventory = config[name]['inventory']
        inventory_path = c.check(inventory)
        c.safe(config[name + 'Root'], inventory_path)
        inventory_data = c.read(inventory_path)
        c.require(all(inventory_data[key] == config[name][key] for key in ('schema', 'root', 'lockId')), 'Current inventory metadata belongs to another lock/root')
        c.require('files' in inventory_data and 'inventory' not in inventory_data, 'Complete non-recursive inventory metadata required')
        if previous[name] == config[name + 'Identity']:
            mode = 'reused-current-declaration'
        else:
            c.require(all(previous[name][key] == inventory[key] for key in ('bytes', 'sha256')), 'Previous verified runtime/toolchain identity differs from current inputs')
            mode = 'reused-preserved-inventory'
        components[name] = {'mode': mode}
    prior_probe = c.read(c.check(previous['importProbe']))
    c.require(prior_probe['schema'] == 'sciyue-native-import-probe-v1' and prior_probe['passed'] is True and prior_probe['scienceExecuted'] is False,
              'Successful actual prior import/source probe required')
    for name in ('runtimeLock', 'toolchainLock', 'xtbLock'):
        c.require(prior_probe[name] == previous[name], 'Prior probe is not bound to its preparation locks')
    plan = probe_plan(config)
    c.require(prior_probe['versions'] in (config['runtimeLock']['versions'], plan['versions']) and prior_probe['toolVersions'] == config['toolchainLock']['versions'],
              'Prior probe versions differ from the current unchanged runtime/toolchain')
    python = config['toolchainLockRoot'] / config['toolchainLock']['python']
    c.safe(c.ROOT, python)
    c.require(python.is_file(), 'The declared existing interpreter is required')
    c.require(Path(prior_probe['executable']).resolve() == python.resolve() and
              Path(prior_probe['prefix']).resolve() == python.parent.resolve() and
              Path(prior_probe['basePrefix']).resolve() == python.parent.resolve(), 'Cannot reuse verification across physical interpreter roots')
    roots = (config['runtimeLockRoot'], config['toolchainLockRoot'])
    paths = prior_probe['packagePaths']
    required_packages = set(plan['modules'])
    c.require(isinstance(paths, dict) and required_packages <= set(paths) and set(paths) - required_packages <= set(plan['excludedModules']),
              'Complete actual prior package source paths are required; only explicitly excluded known modules may be extra')
    excluded_sources = []
    for name, raw_path in paths.items():
        path = Path(raw_path)
        c.require(path.is_absolute(), 'Prior package source must be an absolute physical path')
        c.safe(c.ROOT, path)
        c.require(path.is_file() and any(path.resolve().is_relative_to(root) for root in roots), 'Prior module source escaped current physical roots')
        owner = config['toolchainLockRoot'] if name == 'PyInstaller' else config['runtimeLockRoot']
        c.require(path.resolve().is_relative_to(owner), 'Prior package source belongs to the wrong declared root')
        if name not in required_packages:
            relative = path.relative_to(owner).as_posix()
            row = next((row for row in config['runtimeLock']['files'] if row['path'] == relative), None)
            c.require(row, 'Excluded prior module has no exact locked source identity')
            source = {'path': path.relative_to(c.ROOT).as_posix(), 'bytes': row['bytes'], 'sha256': row['sha256']}
            c.check(source)
            excluded_sources.append({'module': name, 'source': source})
    if plan['excludedModules'] or plan['excludedDistributions']:
        components['runtimeLock']['probeSelection'] = {
            'priorProbe': previous['importProbe'], 'excludedDistributions': plan['excludedDistributions'],
            'excludedModules': plan['excludedModules'], 'excludedPriorSources': excluded_sources,
            'freshSelectedImportProbeRequired': True,
        }
    allowed_paths = (*roots, c.ROOT / 'scripts/native')
    c.require(prior_probe['sysPath'] and all(Path(path).is_absolute() and any(Path(path).resolve().is_relative_to(root) for root in allowed_paths) for path in prior_probe['sysPath']),
              'Prior Python search path belongs to another physical root')
    windows = Path(os.environ.get('SystemRoot', 'C:/Windows')).resolve()
    c.require(prior_probe['loadedModules'] and all(Path(path).is_absolute() and any(Path(path).resolve().is_relative_to(root) for root in (*roots, windows)) for path in prior_probe['loadedModules']),
              'Prior loaded DLL sources escaped current physical roots/Windows')
    if refresh_xtb:
        xtb = config['xtbLock']
        c.check(config['xtbLockIdentity'])
        c.require(xtb['schema'] == 'sciyue-xtb-lock-v1' and xtb['scope'] == 'local-experimental' and xtb['localUseReady'] is True,
                  'Only the approved ready current xTB lock may be refreshed')
        c.require(xtb['publicRedistributionReviewed'] is False and xtb['distributionLicenseReady'] is False,
                  'The local experimental redistribution boundary changed')
        c.require(xtb['entry'] == 'xtb/bin/xtb.exe' and xtb['dataDirectory'] == 'xtb/share/xtb',
                  'The fixed current xTB entry/data directory is required')
        members = {row['path'] for row in xtb['files']}
        c.require({'xtb/bin/xtb.exe', 'xtb/runtime.json', 'xtb/share/xtb/param_gfn0-xtb.txt',
                   'xtb/share/xtb/param_gfn1-xtb.txt', 'xtb/share/xtb/param_gfn2-xtb.txt',
                   'xtb/share/xtb/.param_gfnff.xtb'} <= members,
                  'The executable, runtime descriptor and all supported-method parameters are required')
        inventory_path = c.check(xtb['inventory'])
        c.safe(config['xtbLockRoot'], inventory_path)
        inventory_data = c.read(inventory_path)
        c.require(all(inventory_data[key] == xtb[key] for key in ('schema', 'root', 'lockId')) and inventory_data['files'] == xtb['files'], 'Current xTB inventory metadata differs')
        c.verify_lock(xtb, config['xtbLockRoot'])
        components['xtbLock'] = {'mode': 'fresh-current-locked-members', 'memberCount': len(xtb['files'])}
    else:
        c.require(previous['xtbLock'] == config['xtbLockIdentity'], 'xTB input lock changed; use the explicit --refresh-xtb route')
        components['xtbLock'] = {'mode': 'reused-current-declaration'}
    return c.identity(previous_path), components


def probe(config, output):
    c.activate(config)
    import importlib
    import importlib.metadata as metadata
    plan = probe_plan(config)
    imported = {name: importlib.import_module(name) for name in plan['modules']}
    from numpy.linalg import _umath_linalg
    from scipy.linalg import _fblas, _flapack
    from scipy.optimize import _lbfgsb, _slsqplib
    from tblite import library
    from tblite.interface import Calculator
    import threadpoolctl
    from pathlib import Path
    capability_modules = {}
    if 'ase-mep' in config['runtimeLock'].get('capabilities', []):
        from ase.mep import NEB, DimerControl, MinModeAtoms, MinModeTranslate, idpp_interpolate
        from tblite.ase import TBLite
        import inspect
        members = {row['path'] for row in config['runtimeLock']['files']}
        for name, module in list(sys.modules.items()):
            if name.startswith('ase.') and getattr(module, '__file__', None):
                path = Path(module.__file__).resolve()
                c.require(path.is_relative_to(config['runtimeLockRoot']), 'ASE capability module escaped the new runtime')
                c.require(path.relative_to(config['runtimeLockRoot']).as_posix() in members, 'Uninventoried ASE capability module')
                capability_modules[name] = str(path)
        c.require(all(name in capability_modules for name in ('ase.mep.neb', 'ase.mep.dimer', 'ase.mep.autoneb', 'ase.mep.dyneb')), 'Incomplete actual MEP module closure')
        c.require(all(callable(value) for value in (NEB, DimerControl, MinModeAtoms, MinModeTranslate, idpp_interpolate)), 'Callable MEP operations required')
        c.require({'energy', 'forces'} <= set(TBLite.implemented_properties), 'Energy/force calculator interface required')
        c.require('climb' in inspect.signature(NEB).parameters and 'method' in inspect.signature(NEB.interpolate).parameters, 'Expected same-version NEB/IDPP API required')
    expected = plan['versions']
    versions = {name: metadata.version(name) for name in expected}
    c.require(versions == expected, 'Locked runtime package version mismatch')
    tool_versions = {name: metadata.version(name) for name in config['toolchainLock']['versions']}
    c.require(tool_versions == config['toolchainLock']['versions'], 'Locked build-tool package version mismatch')
    c.require(library.get_version() == (0, 7, 0), 'tblite shared-library API version mismatch')
    paths = {name: str(Path(module.__file__).resolve()) for name, module in imported.items()}
    for name in plan['excludedModules']:
        root_module = name.split('.')[0]
        c.require(not any(module == root_module or module.startswith(root_module + '.') for module in sys.modules),
                  'Explicitly excluded probe module was imported: ' + root_module)
    roots = (config['runtimeLockRoot'], config['toolchainLockRoot'])
    c.require(all(any(Path(path).is_relative_to(root) for root in roots) for path in paths.values()), 'Python package source escaped stable inputs')
    modules = c.windows_modules()
    windows = Path(os.environ.get('SystemRoot', 'C:/Windows')).resolve()
    c.require(all(any(Path(path).is_relative_to(root) for root in (*roots, windows)) for path in modules), 'Loaded native module escaped stable inputs/Windows OS')
    pools = threadpoolctl.threadpool_info()
    c.require(pools and all(p['internal_api'] == 'openblas' and p['num_threads'] == 1 for p in pools if p['user_api'] == 'blas'), 'OpenBLAS import/thread contract mismatch')
    c.require(all(Path(p['filepath']).is_relative_to(config['runtimeLockRoot']) for p in pools), 'Thread library source escaped runtime')
    result = {'schema': 'sciyue-native-import-probe-v1', 'passed': True, 'scienceExecuted': False,
              'python': sys.version, 'executable': str(Path(sys.executable).resolve()), 'prefix': sys.prefix, 'basePrefix': sys.base_prefix,
              'sysPath': sys.path, 'runtimeLock': config['runtimeLockIdentity'], 'toolchainLock': config['toolchainLockIdentity'],
              'xtbLock': config['xtbLockIdentity'], 'versions': versions, 'toolVersions': tool_versions,
              'packagePaths': paths, 'loadedModules': modules, 'threadPools': pools,
              'excludedDistributions': plan['excludedDistributions'], 'excludedModules': plan['excludedModules'],
              'capabilities': config['runtimeLock'].get('capabilities', []), 'capabilityModules': capability_modules}
    c.write_new(output, result)


def prepare(config, run_id, reuse_verified=None, refresh_xtb=False):
    import subprocess
    from datetime import datetime, timezone
    reused = None
    if reuse_verified:
        reused, components = reuse_verification(config, reuse_verified, refresh_xtb)
    else:
        c.require(not refresh_xtb, '--refresh-xtb requires --reuse-verified')
        components = {}
        for name in ('runtimeLock', 'toolchainLock', 'xtbLock'):
            c.verify_lock(config[name], config[name + 'Root'])
            components[name] = {'mode': 'fresh-current-locked-members', 'memberCount': len(config[name]['files'])}
    runtime = config['runtimeLockRoot']
    run = c.safe(c.ROOT / '.cache/native-preparation', c.ROOT / '.cache/native-preparation' / run_id)
    c.require(not run.exists(), 'Previous preparation execution is protected; use a fresh run ID')
    probe_path = run / 'import-probe.json'
    preparation_path = runtime / ('preparation-' + run_id + '.json')
    c.require(not probe_path.exists() and not preparation_path.exists(), 'Existing preparation/probe is immutable')
    temp = run / 'temp'
    temp.mkdir(parents=True)
    python = config['toolchainLockRoot'] / config['toolchainLock']['python']
    environment = c.clean_environment(config, temp)
    command = [str(python), '-I', '-B', str(c.ROOT / 'scripts/native/prepare.py'), '_probe', '--run-id', run_id, '--output', str(probe_path)]
    started = datetime.now(timezone.utc).isoformat()
    process = subprocess.run(command, cwd=temp, env=environment, capture_output=True, text=True, encoding='utf-8')
    execution = {'command': command, 'environment': environment, 'startedAt': started, 'closedAt': datetime.now(timezone.utc).isoformat(),
                 'returnCode': process.returncode, 'stdout': process.stdout, 'stderr': process.stderr}
    c.write_new(run / 'probe-execution.json', execution)
    c.require(process.returncode == 0, 'Stable standalone import failed; exact diagnostics preserved')
    # This runs no compiler workload; it checks the explicit existing tool binary.
    compiler = config['toolchainLockRoot'] / config['toolchainLock']['compiler']
    started = datetime.now(timezone.utc).isoformat()
    version = subprocess.run([str(compiler), 'version'], cwd=temp, env=environment, capture_output=True, text=True, encoding='utf-8')
    c.write_new(run / 'compiler-version-execution.json', {'command': [str(compiler), 'version'], 'environment': environment,
                'startedAt': started, 'closedAt': datetime.now(timezone.utc).isoformat(),
                'returnCode': version.returncode, 'stdout': version.stdout, 'stderr': version.stderr})
    c.require(version.returncode == 0 and version.stdout.strip() == config['toolchainLock']['compilerVersion'], 'Compiler version identity mismatch')
    c.write_new(preparation_path, {'schema': 'sciyue-native-preparation-v1', 'passed': True, 'status': 'prepared-import-validated-not-science-validated',
                                'runtimeLock': config['runtimeLockIdentity'], 'toolchainLock': config['toolchainLockIdentity'], 'xtbLock': config['xtbLockIdentity'],
                                'importProbe': c.identity(probe_path), 'execution': c.identity(run / 'probe-execution.json'),
                                'compilerVersionExecution': c.identity(run / 'compiler-version-execution.json'),
                                'fileVerificationReusedFrom': reused, 'fileInventoriesUnchanged': bool(reused) and not refresh_xtb,
                                'componentVerification': components,
                                'globalEnvironmentModified': False, 'historicalInputsRead': False, 'scienceExecuted': False, 'buildExecuted': False})
    print(__import__('json').dumps({'preparation': c.identity(preparation_path), 'importProbe': c.identity(probe_path)}))


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('prepare', 'verify', '_probe'))
    parser.add_argument('--output', type=__import__('pathlib').Path)
    parser.add_argument('--run-id', default='import-a01')
    parser.add_argument('--reuse-verified', type=__import__('pathlib').Path)
    parser.add_argument('--refresh-xtb', action='store_true')
    args = parser.parse_args()
    validate_prepare_options(args.command, args.reuse_verified, args.refresh_xtb)
    config = c.configuration()
    c.require(__import__('re').fullmatch('[a-z][a-z0-9-]{0,63}', args.run_id), 'ASCII preparation run ID required')
    if args.command == '_probe':
        c.require(args.output == c.ROOT / '.cache/native-preparation' / args.run_id / 'import-probe.json', 'Fixed probe output required')
        probe(config, args.output)
    elif args.command == 'prepare':
        prepare(config, args.run_id, args.reuse_verified, args.refresh_xtb)
    else:
        for name in ('runtimeLock', 'toolchainLock', 'xtbLock'):
            c.verify_lock(config[name], config[name + 'Root'])
        print('Stable lock contents verified; no import/build/science executed')
