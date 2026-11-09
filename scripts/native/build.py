"""Build the current native sources directly from stable upstream content locks.

Contract generation is read-only unless --output is explicitly supplied. A build
requires a source review approved by Main; internal-development reviews remain
explicitly distinct from independent release reviews. It performs no
installation, dependency migration, science task, promotion or delivery.
"""
from __future__ import annotations
import os
import sys
sys.path.insert(0, os.path.dirname(__file__))
import common as c
import runtime_pruning
from pathlib import Path

BUILDERS = ('scripts/native/build.py', 'scripts/native/common.py', 'scripts/native/prepare.py', 'desktop/packaging/native-engine.spec',
            'scripts/native/runtime_pruning.py', runtime_pruning.RECIPE, 'src/data/conformer-solvation.json')

# These package-owned locations are part of the locked wheels' DLL loaders.
# Keep both BLAS ABIs and differently named CRT files; only omit root copies.
BINARY_DUPLICATE_TARGETS = (
    ('libscipy_openblas64_-63c857e738469261263c764a36be9436.dll', 'numpy.libs/libscipy_openblas64_-63c857e738469261263c764a36be9436.dll'),
    ('libscipy_openblas-64eda39e79589aedb16f58e5547eb599.dll', 'scipy.libs/libscipy_openblas-64eda39e79589aedb16f58e5547eb599.dll'),
    ('symspg.dll', 'spglib/symspg.dll'),
    ('msvcp140-a4c2229bdc2a2a630acdc095b4d86008.dll', 'numpy.libs/msvcp140-a4c2229bdc2a2a630acdc095b4d86008.dll'),
)

RDKIT_PATHS_INPUT = {'path': 'python/Lib/site-packages/rdkit/RDPaths.py', 'bytes': 481,
                     'sha256': '4754ba6e5d9b53f865b9fe18638241dddf1b76e46e2ef40261610121af15acb1'}
RDKIT_CTEST_INPUT = {'path': 'python/Lib/site-packages/rdkit/CTestTestfile.cmake', 'bytes': 761,
                     'sha256': 'ed2872e475acd4c43e2a160ba03a1b2765a31a87dbee3a226cc20e8dc6ed07de'}
RDKIT_FREEZE_RULE = 'rdkit-2025.3.6-package-relative-paths-v1'


def portable_rdkit_paths_source(raw):
    """Transform only the reviewed RDPaths input; never modify its locked file."""
    import hashlib
    c.require(len(raw) == RDKIT_PATHS_INPUT['bytes'] and hashlib.sha256(raw).hexdigest() == RDKIT_PATHS_INPUT['sha256'],
              'Unreviewed RDKit path source; an explicit new transform review is required')
    replacements = {'RDCodeDir=': 'RDCodeDir=os.path.dirname(os.path.abspath(__file__))',
                    '_share = ': '_share = RDCodeDir'}
    lines = raw.decode('utf-8').splitlines()
    for prefix, replacement in replacements.items():
        matches = [index for index, line in enumerate(lines) if line.startswith(prefix)]
        c.require(len(matches) == 1, 'RDKit path assignment changed: ' + prefix)
        lines[matches[0]] = replacement
    return ('\n'.join(lines) + '\n').encode('utf-8')


def _rdkit_locked_input(config, expected):
    rows = [row for row in config['runtimeLock']['files'] if row['path'] == expected['path']]
    c.require(len(rows) == 1 and all(rows[0].get(key) == value for key, value in expected.items()),
              'RDKit freeze input differs from the reviewed lock pin')
    path = c.safe(config['runtimeLockRoot'], config['runtimeLockRoot'] / expected['path'])
    c.require(c.identity(path, config['runtimeLockRoot']) == expected, 'RDKit locked source changed')
    return path


def freeze_rdkit_paths(config, pure, datas, rows, run):
    """Bind admitted original inputs and a separate, explicitly transformed PYZ source."""
    source = _rdkit_locked_input(config, RDKIT_PATHS_INPUT)
    ctest = _rdkit_locked_input(config, RDKIT_CTEST_INPUT)
    modules = [row for row in pure if row[0] == 'rdkit.RDPaths']
    omitted = [row for row in datas if str(row[0]).replace('\\', '/') == 'rdkit/CTestTestfile.cmake']
    c.require(len(modules) == len(omitted) == 1, 'Exact RDKit module and root CTest data required')
    c.require(modules[0][2] == 'PYMODULE' and Path(modules[0][1]).resolve() == source.resolve(), 'RDPaths source/type mismatch')
    c.require(omitted[0][2] == 'DATA' and Path(omitted[0][1]).resolve() == ctest.resolve(), 'RDKit CTest source/type mismatch')
    for target, path, kind in (modules[0], omitted[0]):
        admitted = [row for row in rows if row['target'] == target]
        identity = c.identity(path)
        c.require(len(admitted) == 1 and admitted[0]['kind'] == kind and
                  all(admitted[0].get(key) == value for key, value in {'source': identity['path'], 'bytes': identity['bytes'], 'sha256': identity['sha256']}.items()),
                  'RDKit transform input must first pass locked Analysis admission')
    output = c.safe(run, run / 'freeze-transforms/rdkit/RDPaths.py')
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('xb') as stream:
        stream.write(portable_rdkit_paths_source(source.read_bytes()))
    transform = {'module': 'rdkit.RDPaths', 'rule': RDKIT_FREEZE_RULE, 'input': c.identity(source), 'output': c.identity(output)}
    omission = {'target': 'rdkit/CTestTestfile.cmake', 'kind': 'DATA', 'input': c.identity(ctest),
                'reason': 'CMake test registration is not runtime data'}
    new_pure = [(name, str(output) if name == 'rdkit.RDPaths' else path, kind) for name, path, kind in pure]
    new_datas = [row for row in datas if row != omitted[0]]
    new_rows = [{**row, 'freezeTransform': transform} if row['target'] == 'rdkit.RDPaths' else row
                for row in rows if str(row['target']).replace('\\', '/') != omission['target']]
    return new_pure, new_datas, new_rows, {'schema': 'sciyue-native-frozen-dependency-adaptations-v1',
                                         'sourceTransforms': [transform], 'dataOmissions': [omission]}


def validate_frozen_dependency_adaptations(config, run, rows, evidence):
    """Reject stale, unpinned, or undisclosed dependency transformations."""
    source = _rdkit_locked_input(config, RDKIT_PATHS_INPUT)
    ctest = _rdkit_locked_input(config, RDKIT_CTEST_INPUT)
    output = c.safe(run, run / 'freeze-transforms/rdkit/RDPaths.py')
    c.require(output.read_bytes() == portable_rdkit_paths_source(source.read_bytes()), 'Frozen RDPaths output differs from exact rule')
    expected = {'schema': 'sciyue-native-frozen-dependency-adaptations-v1',
                'sourceTransforms': [{'module': 'rdkit.RDPaths', 'rule': RDKIT_FREEZE_RULE, 'input': c.identity(source), 'output': c.identity(output)}],
                'dataOmissions': [{'target': 'rdkit/CTestTestfile.cmake', 'kind': 'DATA', 'input': c.identity(ctest),
                                  'reason': 'CMake test registration is not runtime data'}]}
    c.require(evidence == expected, 'Dependency adaptation evidence changed')
    adapted = [row for row in rows if row['target'] == 'rdkit.RDPaths']
    c.require(len(adapted) == 1 and adapted[0].get('freezeTransform') == expected['sourceTransforms'][0], 'RDPaths Analysis/output binding missing')
    c.require(not any(str(row['target']).replace('\\', '/') == 'rdkit/CTestTestfile.cmake' for row in rows), 'CTest test data remains in frozen closure')
    return expected


def packaged_dependency_metadata(config):
    """Retain the preparation lock, but omit explicitly removed distributions."""
    excluded = {name.casefold().replace('_', '-') for name in config['profile'].get('excludedDistributions', [])}
    retained = lambda name: name.casefold().replace('_', '-') not in excluded
    versions = {name: version for name, version in config['runtimeLock']['versions'].items() if retained(name)}
    packages = {key: package for key, package in config['runtimeLock']['packages'].items() if retained(package['name'])}
    return versions, packages


def current_contract(config):
    return {'schema': 'sciyue-native-build-contract-v2', 'productVersion': c.read(c.ROOT / 'package.json')['version'],
            'sourceFiles': [c.identity(c.ROOT / name) for name in config['profile']['nativeSources']],
            'builderSources': [c.identity(c.ROOT / name) for name in BUILDERS],
            **{key: config[key + 'Identity'] for key in ('runtimeLock', 'toolchainLock', 'xtbLock')}, 'profile': config['profileIdentity']}


def validate_native_source_presence(profile, source_files, rows):
    c.require([row['path'] for row in source_files] == profile['nativeSources'], 'Reviewed native source list differs from the profile')
    for source in source_files:
        matches = [row for row in rows if row['target'] == Path(source['path']).stem]
        if source['path'] == profile['entry']:
            kinds = sorted(row['kind'] for row in matches)
            c.require(kinds in (['PYSOURCE'], ['PYMODULE', 'PYSOURCE']), 'Entry must have one script and at most one matching module')
        else:
            c.require(len(matches) == 1 and matches[0]['kind'] == 'PYMODULE', 'Required native module must have exactly one module entry: ' + source['path'])
        c.require(all(row.get('source') == source['path'] and row.get('bytes') == source['bytes'] and row.get('sha256') == source['sha256'] for row in matches), 'Native entry source/type identity differs: ' + source['path'])
    for name in profile.get('nativeDataSources', []):
        c.require(name in BUILDERS and name == 'src/data/conformer-solvation.json', 'Native data is not an explicitly bound build input')
        source = c.identity(c.ROOT / name)
        matches = [row for row in rows if row['target'] == Path(name).name]
        c.require(len(matches) == 1 and matches[0]['kind'] == 'DATA', 'Required native data is missing or ambiguous: ' + name)
        c.require(all(matches[0].get(key) == value for key, value in {'source': name, 'bytes': source['bytes'], 'sha256': source['sha256']}.items()), 'Native data identity differs: ' + name)


def review_kind(review):
    if review.get('schema') == 'sciyue-native-development-review-v1':
        c.require(review.get('passed') is True and review.get('independentReview') is False
                  and review.get('purpose') == 'internal-development'
                  and review.get('reviewer') == 'Main', 'Explicit Main internal-development review required')
        return 'internal-development'
    c.require(review.get('schema') == 'sciyue-native-source-review-v2' and review.get('passed') is True and review.get('independentReview') is True,
              'Independent current-source review required')
    c.require(isinstance(review.get('reviewer'), str) and review['reviewer'].strip() and review['reviewer'].rsplit('/', 1)[-1] not in {'native_packaging', 'native_build'}, 'Independent reviewer identity required')
    return 'release-candidate'


def inputs(config, contract_path, review_path, review_sha, full=False):
    contract, review = c.read(contract_path), c.read(review_path)
    c.require(contract == current_contract(config), 'Current source/configuration differs from the frozen native contract')
    c.require(c.digest(review_path) == review_sha, 'Source-review identity mismatch')
    purpose = review_kind(review)
    c.require(review['approvedForBuild'] is True and review['approvedBy'] == 'Main', 'Main source-review approval required')
    from datetime import datetime
    c.require(datetime.fromisoformat(review['reviewedAt'].replace('Z', '+00:00')).tzinfo is not None, 'Review timestamp needs timezone')
    c.require(review['buildContract'] == c.identity(contract_path), 'Review must bind the exact current native contract')
    c.require(review['sourceFiles'] == contract['sourceFiles'] and review['builderSources'] == contract['builderSources'], 'Review source/tool identities differ')
    c.require(review['existingExplicitGraphsPreserved'] is True and review['scientificBoundaryReviewPassed'] is True, 'Source scientific/boundary review required')
    c.require(isinstance(review['evidence'], list) and review['evidence'], 'Actual source review evidence is required')
    for row in review['evidence']:
        c.check(row)
    preparation_path = c.check(config['profile']['preparation'])
    preparation = c.read(preparation_path)
    c.require(preparation['schema'] == 'sciyue-native-preparation-v1' and preparation['passed'] is True and not preparation['scienceExecuted'], 'New stable preparation required')
    for key in ('runtimeLock', 'toolchainLock', 'xtbLock'):
        c.require(preparation[key] == config[key + 'Identity'], 'Preparation lock changed')
        if full:
            c.verify_lock(config[key], config[key + 'Root'])
    probe_path = c.check(preparation['importProbe'])
    probe = c.read(probe_path)
    c.require(probe['schema'] == 'sciyue-native-import-probe-v1' and probe['passed'] is True and not probe['scienceExecuted'], 'New stable import/source probe required')
    c.require(probe['runtimeLock'] == contract['runtimeLock'] and probe['toolchainLock'] == contract['toolchainLock'], 'Import probe belongs to other locks')
    python = config['toolchainLockRoot'] / config['toolchainLock']['python']
    c.require(Path(probe['executable']).resolve() == python.resolve() and Path(probe['prefix']).resolve() == python.parent.resolve(), 'Import probe belongs to another physical stage')
    c.require(all(any(Path(path).resolve().is_relative_to(config[name + 'Root']) for name in ('runtimeLock', 'toolchainLock')) for path in probe['packagePaths'].values()), 'Import probe package paths belong to another physical stage')
    return {'contract': contract, 'buildContract': c.identity(contract_path), 'sourceReview': c.identity(review_path),
            **({'buildPurpose': purpose, 'independentSourceReview': False} if purpose == 'internal-development' else {}),
            'preparation': c.identity(preparation_path), 'importProbe': preparation['importProbe']}


def analysis_rows(config, rows, namespaces, run, contract):
    allowed = {}
    for name in ('runtimeLock', 'toolchainLock'):
        root = config[name + 'Root']
        for row in config[name]['files']:
            if name == 'toolchainLock' and not row['path'].startswith(('python/', 'tools/')):
                continue
            allowed[os.path.normcase(str(root / row['path']))] = {**row, 'root': root}
    sources = {str((c.ROOT / row['path']).resolve()).casefold(): row for row in contract['sourceFiles']}
    # Non-executable application data is bound to the same exact build contract.
    # Only the declared canonical solvation table is admitted by this route.
    data_sources = {str((c.ROOT / row['path']).resolve()).casefold(): row
                    for row in contract.get('builderSources', [])
                    if row['path'] == 'src/data/conformer-solvation.json'}
    result = []
    for target, source, kind in rows:
        c.require(not str(target).casefold().startswith(('mkl', '_internal/mkl')), 'MKL compute target in Analysis')
        if source in (None, '-'):
            evidence = namespaces.get(target)
            c.require(kind == 'PYMODULE' and evidence and evidence['nodeType'] == 'NamespacePackage', 'Unproved source-free module')
            paths = evidence['paths']
            c.require(paths and all(any(Path(path).resolve().is_relative_to(config[name + 'Root']) for name in ('runtimeLock', 'toolchainLock')) for path in paths), 'Namespace escaped stable source roots')
            result.append({'target': target, 'source': None, 'kind': kind, 'namespacePaths': paths})
            continue
        path = Path(source).absolute()
        key = os.path.normcase(str(path))
        if key in allowed:
            row = allowed[key]
            c.safe(row['root'], path)
            c.require(path.stat().st_size == row['bytes'] and c.digest(path) == row['sha256'], 'Analysis dependency source changed')
        elif key in sources:
            c.require(c.identity(c.safe(c.ROOT, path)) == sources[key], 'Reviewed native source changed')
        elif key in data_sources:
            c.require(kind == 'DATA' and target == 'conformer-solvation.json', 'Native application data target/type differs')
            c.require(c.identity(c.safe(c.ROOT, path)) == data_sources[key], 'Reviewed native application data changed')
        elif target == 'base_library.zip' and kind == 'DATA' and path == run / 'work/native-engine/base_library.zip':
            c.safe(run, path)
            c.require(path.is_file(), 'Generated base library is missing')
        else:
            raise ValueError('Analysis source outside current declared inputs: ' + str(path))
        result.append({'target': str(target), 'source': c.identity(path)['path'], 'kind': kind, 'bytes': path.stat().st_size, 'sha256': c.digest(path)})
    return result


def deduplicate_binaries(config, binaries, run, contract):
    """Omit only the declared proved, same-name root copies after Analysis resolution.

    Both sources still pass the normal locked-input admission check and remain
    in the closure evidence. This never mutates an input or an existing bundle.
    Missing/ambiguous/different copies fail instead of guessing another loader.
    """
    indexed = {}
    for row in binaries:
        indexed.setdefault(str(row[0]).replace('\\', '/').casefold(), []).append(row)
    omitted_targets, evidence = set(), []
    for omitted_target, retained_target in BINARY_DUPLICATE_TARGETS:
        pair = []
        for target in (omitted_target, retained_target):
            matches = indexed.get(target.casefold(), [])
            c.require(len(matches) == 1 and matches[0][2] == 'BINARY', 'Exact binary duplicate target required: ' + target)
            pair.append(matches[0])
        c.require(Path(omitted_target).name.casefold() == Path(retained_target).name.casefold(), 'Binary duplicate basenames differ')
        admitted = analysis_rows(config, pair, {}, run, contract)
        omitted, retained = admitted
        c.require((omitted['bytes'], omitted['sha256']) == (retained['bytes'], retained['sha256']), 'Binary duplicate content differs: ' + omitted_target)
        omitted_targets.add(omitted_target.casefold())
        evidence.append({'omitted': omitted, 'retained': retained})
    kept = [row for row in binaries if str(row[0]).replace('\\', '/').casefold() not in omitted_targets]
    return kept, {'schema': 'sciyue-native-binary-deduplication/v1', 'files': evidence,
                  'logicalBytesAvoided': sum(row['omitted']['bytes'] for row in evidence)}


def worker(config, run, contract_path, review_path, review_sha):
    c.activate(config)
    context = inputs(config, contract_path, review_path, review_sha)
    c.require((run / 'temp').is_dir() and not (run / 'native').exists(), 'Fresh parent-created build directory required')
    os.environ.update({'SCIYUE_NATIVE_RUN': str(run), 'SCIYUE_NATIVE_CONTRACT': str(contract_path), 'SCIYUE_NATIVE_REVIEW': str(review_path), 'SCIYUE_NATIVE_REVIEW_SHA256': review_sha})
    import PyInstaller.__main__
    c.initialize_pyinstaller_children(config, run / 'isolated-children')
    PyInstaller.__main__.run([str(c.ROOT / config['profile']['spec']), '--distpath', str(run / 'native'), '--workpath', str(run / 'work'), '--log-level', 'INFO'])
    c.require(context['contract'] == current_contract(config), 'Build inputs changed during freeze')


def ownership(config, bundle, closure, graph):
    import shutil
    runtime_root, toolchain_root = config['runtimeLockRoot'], config['toolchainLockRoot']
    _, packages = packaged_dependency_metadata(config)
    excluded_licenses = {row['path'] for key, package in config['runtimeLock']['packages'].items() if key not in packages
                         for row in package.get('licenseFiles', [])}
    licenses = []
    for row in config['runtimeLock']['files']:
        if row['path'].startswith('licenses/') and row['path'] not in excluded_licenses:
            source = runtime_root / row['path']
            c.require(c.digest(source) == row['sha256'], 'Stable license content changed')
            target = bundle / row['path']
            c.require(not target.exists(), 'License output collision')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            licenses.append({**c.identity(target, bundle), 'source': c.identity(source)})
    source_owners = {}
    for name in ('runtimeLock', 'toolchainLock'):
        for row in config[name]['files']:
            path = config[name + 'Root'] / row['path']
            owner = row.get('owner')
            if not owner:
                continue
            if owner not in packages:
                matches = [r['owner'] for r in config['runtimeLock']['files'] if 'owner' in r and Path(r['path']).name.casefold() == path.name.casefold() and r['sha256'] == row['sha256']]
                owner = matches[0] if matches else next((k for k, p in packages.items() if p['name'].casefold() == 'python'), None)
            source_owners[path.relative_to(c.ROOT).as_posix().casefold()] = owner
    analysis = {row['target'].replace('\\', '/'): row for row in closure['files']}
    native = []
    for node in graph:
        target = node['path'].removeprefix('_internal/')
        source = analysis.get(target, {}).get('source')
        if node['path'] == 'engine.exe':
            owner = next(k for k, p in packages.items() if p['name'].casefold() == 'pyinstaller')
            source = 'PyInstaller-generated engine container'
        else:
            c.require(source, 'Native output has no Analysis source: ' + target)
            owner = source_owners.get(source.casefold())
        c.require(owner in packages, 'Native output has no locked upstream ownership: ' + target)
        c.require(packages[owner]['licenseFiles'], 'Used native package has no source license')
        for license_row in packages[owner]['licenseFiles']:
            c.require(c.digest(bundle / license_row['path']) == license_row['sha256'], 'Used native package license missing/changed')
        native.append({**c.identity(bundle / node['path'], bundle), 'target': target, 'source': source, 'owner': owner})
    return {'packages': packages, 'nativeFiles': native, 'licenseFiles': licenses, 'unresolvedNative': [], 'missingLicenseCopies': []}


def build(config, run, contract_path, review_path, review_sha):
    import subprocess
    import re
    from datetime import datetime, timezone
    context = inputs(config, contract_path, review_path, review_sha, full=True)
    c.require(not run.exists(), 'Existing build/failure is protected; select a fresh run ID')
    (run / 'temp').mkdir(parents=True)
    environment = c.clean_environment(config, run / 'temp')
    environment['PYINSTALLER_CONFIG_DIR'] = str(run / 'pyinstaller-cache')
    python = config['toolchainLockRoot'] / config['toolchainLock']['python']
    command = [str(python), '-I', '-B', str(c.ROOT / 'scripts/native/build.py'), '_worker', '--run-id', run.name,
               '--contract', str(contract_path), '--source-review', str(review_path), '--source-review-sha256', review_sha]
    started = datetime.now(timezone.utc).isoformat()
    with (run / 'stdout.log').open('x', encoding='utf-8') as stdout, (run / 'stderr.log').open('x', encoding='utf-8') as stderr:
        process = subprocess.run(command, cwd=run, env=environment, stdout=stdout, stderr=stderr)
    c.write_new(run / 'execution.json', {'command': command, 'environment': environment, 'startedAt': started,
                                      'closedAt': datetime.now(timezone.utc).isoformat(), 'returnCode': process.returncode, **context})
    c.require(process.returncode == 0, 'Build failed; exact execution/stdout/stderr preserved')
    c.require(inputs(config, contract_path, review_path, review_sha) == context, 'Build source/configuration changed')
    c.activate(config)
    bundle = c.safe(run, run / 'native/engine')
    closure_path = run / 'analysis-closure.json'
    closure = c.read(closure_path)
    c.require(closure['buildContract'] == context['buildContract'] and closure['sourceFiles'] == context['contract']['sourceFiles'], 'Analysis source/contract binding changed')
    validate_native_source_presence(config['profile'], context['contract']['sourceFiles'], closure['files'])
    frozen_adaptations = validate_frozen_dependency_adaptations(config, run, closure['files'], closure['frozenDependencyAdaptations'])
    runtime_recipe_path = c.ROOT / runtime_pruning.RECIPE
    runtime_recipe = runtime_pruning.validate_recipe(c.read(runtime_recipe_path))
    runtime_pruning.validate_pruning(config, runtime_recipe, closure['runtimePruning'], c.identity(runtime_recipe_path))
    graph = c.native_graph(bundle)
    stderr = (run / 'stderr.log').read_text(encoding='utf-8')
    unresolved = [{'dll': dll, 'dependentSource': source.replace('\\\\', '\\')} for dll, source in re.findall(r"Library not found: could not resolve '([^']+)', dependency of '([^']+)'", stderr)]
    observed = sorted((r['dll'].casefold(), Path(r['dependentSource']).name.casefold()) for r in unresolved)
    expected = sorted((r['dll'].casefold(), r['dependent'].casefold()) for r in
                      runtime_pruning.expected_unresolved_imports(config['profile'], runtime_recipe, closure['runtimePruning']))
    c.require(observed == expected, 'Unresolved DLL set differs from the explicit experimental profile')
    for row in unresolved:
        source = Path(row['dependentSource'])
        c.safe(config['runtimeLockRoot'], source)
        row['dependentSource'] = c.identity(source)
    versions, _ = packaged_dependency_metadata(config)
    provenance = {'schema': 'sciyue-native-dependency-manifest-v1', **context, 'runtimeLock': config['runtimeLockIdentity'],
                  'toolchainLock': config['toolchainLockIdentity'], 'profile': config['profileIdentity'], 'backend': 'OpenBLAS',
                  'versions': versions, 'analyzedFiles': closure['files'], 'nativeImportGraph': graph,
                  'unresolvedImportedDlls': unresolved, 'runtimePruning': closure['runtimePruning'],
                  'frozenDependencyAdaptations': frozen_adaptations, **ownership(config, bundle, closure, graph)}
    manifest = run / 'dependency-manifest.json'
    c.write_new(manifest, provenance)
    files = c.inventory(bundle)
    runtime_output_check = runtime_pruning.validate_output(files, runtime_recipe)
    candidate = {'schema': 'sciyue-native-candidate-v1', 'status': 'built-not-scientifically-validated', 'passed': True,
                 'productVersion': context['contract']['productVersion'], 'backend': 'OpenBLAS', 'versions': versions,
                 'output': bundle.relative_to(c.ROOT).as_posix(), 'entry': 'engine.exe', 'files': files, 'fileCount': len(files),
                 'totalBytes': sum(row['bytes'] for row in files), 'sourceFiles': context['contract']['sourceFiles'],
                 'builderSources': context['contract']['builderSources'], 'profile': config['profileIdentity'],
                 **{name: config[name + 'Identity'] for name in ('runtimeLock', 'toolchainLock', 'xtbLock')},
                 'preparation': context['preparation'], 'importProbe': context['importProbe'], 'buildContract': context['buildContract'],
                 'sourceReview': context['sourceReview'], 'analysisClosure': c.identity(closure_path), 'dependencyManifest': c.identity(manifest),
                 'execution': c.identity(run / 'execution.json'), 'buildRun': run.name, 'cliExitCode': process.returncode,
                 'unresolvedImportedDlls': unresolved, 'requiredFreshGates': config['profile']['requiredFreshGates'],
                 'runtimePruning': closure['runtimePruning'], 'runtimeOutputCheck': runtime_output_check,
                 'frozenDependencyAdaptations': frozen_adaptations,
                 'historicalInputsRead': False, 'globalEnvironmentModified': False, 'scienceExecuted': False, 'scienceAccepted': False,
                 'packagedDynamicClosureValidated': False, 'publicDistribution': False, 'experimentalOnly': True,
                 'cleanMachineValidated': False, 'crossCpuValidated': False,
                 **({key: context[key] for key in ('buildPurpose', 'independentSourceReview')} if 'buildPurpose' in context else {})}
    c.write_new(run / 'candidate-receipt.json', candidate)
    print(__import__('json').dumps({'receipt': c.identity(run / 'candidate-receipt.json'), 'status': candidate['status']}))


if __name__ == '__main__':
    import argparse
    import json
    import re
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('contract', 'build', '_worker'))
    parser.add_argument('--output', type=Path)
    parser.add_argument('--run-id')
    parser.add_argument('--contract', type=Path)
    parser.add_argument('--source-review', type=Path)
    parser.add_argument('--source-review-sha256')
    args = parser.parse_args()
    config = c.configuration()
    if args.command == 'contract':
        c.require(not any((args.run_id, args.contract, args.source_review, args.source_review_sha256)), 'Contract generation accepts no build arguments')
        value = current_contract(config)
        if args.output:
            c.write_new(c.safe(c.ROOT / '.cache/builds', args.output.absolute()), value)
            print(json.dumps(c.identity(args.output.absolute())))
        else:
            print(json.dumps(value, indent=2))
    else:
        c.require(args.output is None and args.run_id and re.fullmatch(r'[a-z][a-z0-9-]{0,63}', args.run_id), 'Explicit ASCII build run ID required')
        c.require(args.contract and args.source_review and args.source_review_sha256 and re.fullmatch('[a-f0-9]{64}', args.source_review_sha256), 'Exact current contract and Main-approved source review required')
        run = c.safe(c.ROOT / '.cache/builds', c.ROOT / '.cache/builds' / args.run_id)
        contract, review = c.safe(c.ROOT, args.contract.absolute()), c.safe(c.ROOT, args.source_review.absolute())
        (build if args.command == 'build' else worker)(config, run, contract, review, args.source_review_sha256)
