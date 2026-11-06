"""Exact Windows 11 output recipe; no loading, deleting or changing locked inputs."""
from __future__ import annotations

from pathlib import Path, PurePosixPath
import copy
import re

RECIPE = 'desktop/packaging/native-runtime-win11-recipe.json'
SCHEMA = 'sciyue-native-win11-output-recipe-v1'


def require(value, message):
    if not value:
        raise ValueError(message)


def target(value):
    value = str(value).replace('\\', '/')
    path = PurePosixPath(value)
    require(not path.is_absolute() and path.parts and all(p not in ('', '.', '..') for p in value.split('/'))
            and ':' not in value, 'Unsafe output target')
    return value.casefold()


def identity(row):
    return {key: row[key] for key in ('path', 'bytes', 'sha256')}


def content_identity(row):
    return {key: row[key] for key in ('bytes', 'sha256')}


def validate_ase_overlay_chain(parent_lock, parent_inventory, derived_lock, derived_inventory,
                               derivation, parent_identity, recipe):
    """Validate already hash-checked parent/derived documents without importing ASE.

    Only existing ASE-owned preferred .py sources may differ. Returned evidence
    contains relative scientific member paths and content identities, never local
    absolute parent/source locations.
    """
    pins = [row for row in recipe['sourceLockParents'] if row['lockId'] == parent_lock['lockId']]
    require(len(pins) == 1 and content_identity(parent_identity) == pins[0]['lock'], 'Unrecognized complete parent lock identity')
    require(parent_lock['lockId'] in recipe['sourceLockIds'] and 'derivation' not in parent_lock,
            'One recognized immutable parent generation required')
    require(content_identity(parent_lock['inventory']) == pins[0]['inventory']
            and derivation['parentInventory'] == parent_lock['inventory']
            and content_identity(derivation['parentRef']) == content_identity(parent_identity), 'Parent inventory/ref differs from pinned parent')
    require(set(derivation) == {'schema', 'component', 'parentRef', 'parentLockId', 'parentInventory',
                               'derivedRoot', 'derivedLockId', 'derivedInventory', 'overlay',
                               'unchangedLibraryDlls', 'officialAcceptance', 'publicDistributionApproved'}, 'Unknown derivation field')
    require(derivation['schema'] == 'sy-ase-source-overlay-derivation/v1' and derivation['component'] == 'ase'
            and derivation['parentLockId'] == parent_lock['lockId']
            and derivation['officialAcceptance'] is False and derivation['publicDistributionApproved'] is False,
            'Wrong/local-only ASE derivation required')
    derived_id = derived_lock['lockId']
    require(re.fullmatch(r'native-local-ase-[a-z][a-z0-9-]{0,40}', derived_id)
            and derived_lock['root'] == '.local/dependencies/win-x64/' + derived_id
            and derivation['derivedLockId'] == derived_id and derivation['derivedRoot'] == derived_lock['root']
            and derivation['derivedInventory'] == derived_lock['inventory'], 'Derived lock/root/inventory identity mismatch')
    for document in (parent_lock, parent_inventory):
        require(document['schema'] == 'sciyue-native-runtime-lock-v1' and document['platform'] == 'win32-x64'
                and document['lockId'] == parent_lock['lockId'] and document['root'] == parent_lock['root'], 'Parent inventory ownership differs')
    owners = [key for key, value in parent_lock['packages'].items() if value['name'].casefold() == 'ase']
    require(len(owners) == 1, 'Unique original ASE owner required')
    owner = owners[0]
    parent_rows = {row['path']: row for row in parent_inventory['files']}
    derived_rows = {row['path']: row for row in derived_inventory['files']}
    for rows, sequence in ((parent_rows, parent_inventory['files']), (derived_rows, derived_inventory['files'])):
        require(len(rows) == len(sequence) == len({target(name) for name in rows}), 'Duplicate/case-colliding runtime member')
    require(parent_rows.keys() == derived_rows.keys(), 'ASE overlay may not add/delete members')
    overlay = derivation['overlay']
    paths = [row['path'] for row in overlay]
    require(overlay and len(paths) == len(set(paths)), 'Nonempty unique ASE overlay required')
    delta = {name for name in parent_rows if parent_rows[name] != derived_rows[name]}
    require(delta == set(paths), 'Actual runtime difference must exactly equal the declared overlay')
    expected_rows = copy.deepcopy(parent_rows)
    for row in overlay:
        name = row['path']; target(name)
        require(set(row) == {'path', 'before', 'after', 'owner'} and '\\' not in name
                and name.startswith('python/Lib/site-packages/ase/') and name.endswith('.py')
                and row['owner'] == owner and parent_rows[name].get('owner') == owner,
                'Only existing original-ASE-owned preferred Python sources may change')
        require(row['before'] == content_identity(parent_rows[name]) and row['after'] == content_identity(derived_rows[name])
                and row['before'] != row['after'], 'ASE before/after identities differ from actual inventory')
        expected_rows[name].update(row['after'])
        require(expected_rows[name] == derived_rows[name], 'ASE overlay altered member metadata/owner')
    dlls = lambda rows: sorted([identity(row) for row in rows if row['path'].startswith('python/Library/bin/')
                               and row['path'].lower().endswith('.dll')], key=lambda row: row['path'])
    expected_dlls = dlls(recipe['libraryDlls'])
    require(dlls(parent_inventory['files']) == expected_dlls == dlls(derived_inventory['files'])
            and derivation['unchangedLibraryDlls'] == expected_dlls, 'All 155 immutable DLL identities must remain exact')
    local = {'component': 'ase', 'upstreamVersion': parent_lock['packages'][owner]['version'],
             'kind': 'user-modified-preferred-Python-source', 'officialAcceptance': False}
    packages = copy.deepcopy(parent_lock['packages']); packages[owner]['localModification'] = local
    expected_lock = {**parent_lock, 'root': derived_lock['root'], 'lockId': derived_id, 'packages': packages,
                     'inventory': derivation['derivedInventory'], 'derivation': derived_lock['derivation'],
                     'localModification': local, 'officialAcceptance': False, 'publicDistributionApproved': False}
    expected_lock.pop('files', None)
    require(derived_lock == expected_lock, 'Derived lock changed versions/packages/capabilities beyond the exact ASE overlay')
    expected_inventory = {**parent_inventory, 'root': derived_lock['root'], 'lockId': derived_id, 'packages': packages,
                          'files': list(expected_rows.values()), 'localModification': local,
                          'officialAcceptance': False, 'publicDistributionApproved': False}
    expected_inventory.pop('inventory', None)
    require(derived_inventory == expected_inventory, 'Derived inventory changed immutable metadata or source members')
    return {'schema': 'sciyue-native-ase-overlay-admission-v1', 'parentLockId': parent_lock['lockId'],
            'parentLock': content_identity(parent_identity), 'parentInventory': content_identity(parent_lock['inventory']),
            'derivedLockId': derived_id, 'derivedInventory': content_identity(derived_lock['inventory']),
            'derivation': content_identity(derived_lock['derivation']), 'overlay': copy.deepcopy(overlay),
            'unchangedLibraryDllCount': len(expected_dlls), 'officialAcceptance': False, 'publicDistributionApproved': False}


def load_ase_overlay_chain(config, recipe):
    """Read only exact referenced documents through the existing path/hash guards."""
    import common
    lock = config['runtimeLock']
    require('derivation' in lock, 'Unrecognized runtime lock requires an exact ASE parent/overlay chain')
    raw_lock = common.read(common.check(config['runtimeLockIdentity']))
    require(raw_lock['lockId'] == lock['lockId'] and raw_lock['root'] == lock['root'], 'Active derived lock identity mismatch')
    root = common.safe(common.ROOT / '.local/dependencies/win-x64', common.ROOT / raw_lock['root'])
    def document(reference, scope):
        target(reference['path'])
        path = common.safe(scope, common.ROOT / reference['path'])
        return common.read(common.check(reference)), path
    record, _ = document(raw_lock['derivation'], root)
    parent, _ = document(record['parentRef'], root)
    parent_root = common.safe(common.ROOT / '.local/dependencies/win-x64', common.ROOT / parent['root'])
    parent_inventory, _ = document(record['parentInventory'], parent_root)
    derived_inventory, _ = document(record['derivedInventory'], root)
    require(derived_inventory['files'] == lock['files'], 'Loaded derived inventory differs from active expanded lock')
    return validate_ase_overlay_chain(parent, parent_inventory, raw_lock, derived_inventory,
                                      record, record['parentRef'], recipe)


def validate_recipe(recipe):
    require(recipe['schema'] == SCHEMA and recipe['platform'] == 'win32-x64'
            and recipe['minimumWindowsBuild'] == 22000, 'Wrong Windows output recipe')
    entries = recipe['libraryDlls']
    paths = [target(row['path']) for row in entries]
    require(len(paths) == len(set(paths)), 'Duplicate recipe input')
    outputs = [target(row['target']) for row in entries]
    require(len(outputs) == len(set(outputs)), 'Duplicate recipe target')
    for row in entries:
        require(row['path'] == 'python/Library/bin/' + row['target'] and '/' not in row['target']
                and row['target'].lower().endswith('.dll'), 'Exact Library/bin DLL required')
        require(row['action'] in ('keep', 'omit-intel', 'system-ucrt'), 'Unknown DLL action')
        require(row['bytes'] > 0 and len(row['sha256']) == 64
                and all(c in '0123456789abcdef' for c in row['sha256']), 'Exact DLL identity required')
    counts = {action: sum(row['action'] == action for row in entries)
              for action in ('keep', 'omit-intel', 'system-ucrt')}
    require(counts == recipe['counts'], 'Recipe counts differ')
    parents = recipe['sourceLockParents']
    require(len(parents) == len(recipe['sourceLockIds'])
            and {row['lockId'] for row in parents} == set(recipe['sourceLockIds']), 'Exact recognized parent pins required')
    return recipe


def select_library_dlls(config, recipe):
    """Compare the complete fixed Library/bin inventory, then select exact members.

    The builder verifies physical locked inputs. This function never consults the
    host PATH, installed runtimes or a package resolver.
    """
    validate_recipe(recipe)
    lock = config['runtimeLock']
    if lock['lockId'] in recipe['sourceLockIds']:
        pin = next(row for row in recipe['sourceLockParents'] if row['lockId'] == lock['lockId'])
        require(content_identity(config['runtimeLockIdentity']) == pin['lock']
                and 'derivation' not in lock and 'localModification' not in lock,
                'Official lock ID must retain its exact recognized parent bytes')
        derivation = None
    else:
        derivation = load_ase_overlay_chain(config, recipe)
    available = [row for row in lock['files'] if row['path'].startswith('python/Library/bin/')
                 and row['path'].lower().endswith('.dll')]
    require(len(available) == len({row['path'] for row in available}), 'Duplicate locked DLL')
    actual = {row['path']: identity(row) for row in available}
    expected = {row['path']: identity(row) for row in recipe['libraryDlls']}
    require(actual == expected, 'Library/bin inventory differs from reviewed exact recipe')
    kept = [row for row in recipe['libraryDlls'] if row['action'] == 'keep']
    omitted = [row for row in recipe['libraryDlls'] if row['action'] != 'keep']
    return [(str(config['runtimeLockRoot'] / row['path']), '.') for row in kept], {
        'schema': 'sciyue-native-win11-library-selection-v1',
        'keptInputs': [identity(row) for row in kept],
        'omittedInputs': [{**identity(row), 'target': row['target'], 'reason': row['action']} for row in omitted],
        **({'sourceDerivation': derivation} if derivation is not None else {})}


def prune_analysis(binaries, admitted, recipe, selection, recipe_identity):
    """Omit reviewed output targets only after normal locked-source admission.

    Dependency analysis can rediscover UCRT from interpreter/VC imports. These
    targets must match the reviewed bytes; an unknown/nested substitute fails.
    """
    excluded = {target(row['target']): row for row in recipe['libraryDlls'] if row['action'] != 'keep'}
    evidence = {target(row['target']): row for row in admitted if row['kind'] == 'BINARY'}
    kept, omitted = [], []
    for row in binaries:
        normalized = target(row[0])
        basename = PurePosixPath(normalized).name
        if basename not in excluded:
            kept.append(row)
            continue
        require(normalized == basename and row[2] == 'BINARY', 'Excluded DLL reappeared under an unreviewed target')
        expected = excluded[basename]
        actual = evidence.get(normalized)
        require(actual and (actual['bytes'], actual['sha256']) == (expected['bytes'], expected['sha256']),
                'Excluded Analysis DLL differs from reviewed source: ' + normalized)
        omitted.append({**actual, 'reason': expected['action']})
    require(len(omitted) == len({target(row['target']) for row in omitted}), 'Duplicate excluded Analysis target')
    omitted_targets = {target(row['target']) for row in omitted}
    kept_admitted = [row for row in admitted if not (row['kind'] == 'BINARY' and target(row['target']) in omitted_targets)]
    return kept, kept_admitted, {
        'schema': 'sciyue-native-win11-runtime-pruning-v1', 'recipe': recipe_identity,
        'selection': selection, 'analysisOmissions': omitted,
        'lockedInputsModified': False, 'dynamicClosureValidated': False}


def validate_pruning(config, recipe, evidence, recipe_identity):
    _, selection = select_library_dlls(config, recipe)
    require(evidence['schema'] == 'sciyue-native-win11-runtime-pruning-v1'
            and evidence['recipe'] == recipe_identity and evidence['selection'] == selection
            and evidence['lockedInputsModified'] is False and evidence['dynamicClosureValidated'] is False,
            'Output pruning evidence does not bind the exact recipe/lock')
    expected = {target(row['target']): row for row in recipe['libraryDlls'] if row['action'] != 'keep'}
    for row in evidence['analysisOmissions']:
        key = target(row['target'])
        require(key in expected and row['reason'] == expected[key]['action']
                and (row['bytes'], row['sha256']) == (expected[key]['bytes'], expected[key]['sha256']),
                'Unreviewed Analysis omission')


def expected_unresolved_imports(profile, recipe, evidence):
    """Only known warnings whose exact Intel dependent was excluded can vanish.

    An excluded dependency rediscovered by Analysis may still produce its old
    warning. Its exact source bytes are admitted above and remain in evidence.
    Unknown DLLs/dependents are never ignored by this helper.
    """
    omitted = {target(row['target']) for row in recipe['libraryDlls'] if row['action'] == 'omit-intel'}
    omitted_in_analysis = {target(row['target']) for row in evidence['analysisOmissions']}
    return [row for row in profile['inheritedUnresolvedImports']
            if target(row['dependent']) not in omitted or target(row['dependent']) in omitted_in_analysis]


def validate_output(files, recipe):
    rows = {target(row['path']): row for row in files}
    require(len(rows) == len(files), 'Duplicate output path')
    excluded = {target(row['target']) for row in recipe['libraryDlls'] if row['action'] != 'keep'}
    require(not any(PurePosixPath(path).name in excluded for path in rows), 'Excluded DLL present in final native output')
    required = [{'path': '_internal/' + row['target'], 'bytes': row['bytes'], 'sha256': row['sha256']}
                for row in recipe['libraryDlls'] if row['action'] == 'keep'] + recipe['requiredPackagedFiles']
    for row in required:
        actual = rows.get(target(row['path']))
        require(actual and (actual['bytes'], actual['sha256']) == (row['bytes'], row['sha256']),
                'Required DLL/ABI member missing or changed: ' + row['path'])
    return {'schema': 'sciyue-native-win11-output-check-v1', 'passed': True,
            'retainedLibraryDlls': recipe['counts']['keep'],
            'excludedIntelDlls': recipe['counts']['omit-intel'], 'systemUcrtDlls': recipe['counts']['system-ucrt'],
            'requiredPackagedFiles': len(recipe['requiredPackagedFiles']), 'dynamicClosureValidated': False}
