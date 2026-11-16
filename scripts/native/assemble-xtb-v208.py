"""Assemble one fresh, pinned Windows xTB runtime set for Ester Studio.

Does not run scientific programs, write the active source lock, or download.
The emitted lock is reviewed and promoted separately. All binaries are copied
from the selected archives or the recorded bounded-cycle build.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import struct
import subprocess
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / 'third-party/build-inputs/declarations/xtb-v208-inputs.json'
ASSEMBLY = INDEX.with_name('xtb-v208-assembly.json')
PARAMETERS = ('.param_gfnff.xtb', 'param_gfn0-xtb.txt', 'param_gfn1-xtb.txt',
              'param_gfn1-si-xtb.txt', 'param_gfn2-xtb.txt', 'param_ipea-xtb.txt')
SYSTEM_DLLS = {'kernel32.dll', 'advapi32.dll', 'msvcrt.dll'}


def identity(path):
    with path.open('rb') as stream:
        return {'bytes': path.stat().st_size, 'sha256': hashlib.file_digest(stream, 'sha256').hexdigest()}


def verify(path, expected):
    observed = identity(path)
    if observed != {key: expected[key] for key in observed}:
        raise ValueError(f'Input identity differs: {path}')
    return observed


def put_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
    return {'path': path.name, **identity(path)}


def copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    with source.open('rb') as inp, target.open('xb') as out:
        shutil.copyfileobj(inp, out)


def members(root):
    return [{'path': f.relative_to(root).as_posix(), **identity(f)}
            for f in sorted(root.rglob('*'), key=lambda p: p.as_posix()) if f.is_file()]


def copy_release(archive, bundle, archive_root, license_dir, *, dlls=()):
    wanted = {'bin/xtb.exe': bundle / 'bin/xtb.exe'}
    wanted.update({f'bin/{dll}': bundle / 'bin' / dll for dll in dlls})
    wanted.update({f'share/xtb/{p}': bundle / 'share/xtb' / p for p in PARAMETERS})
    with zipfile.ZipFile(archive) as zf:
        found = set()
        for row in zf.infolist():
            prefix = archive_root + '/'
            if row.is_dir() or not row.filename.startswith(prefix):
                continue
            member = row.filename[len(prefix):]
            target = wanted.get(member)
            if license_dir and member.startswith('share/licenses/'):
                name = member.removeprefix('share/licenses/')
                pieces = PurePosixPath(name).parts
                if not pieces or any(p in ('.', '..', '/') or '\\' in p or ':' in p for p in pieces):
                    raise ValueError(f'Unsafe license archive member: {member}')
                target = license_dir.joinpath(*pieces)
            if target is None:
                continue
            if member.casefold() in found or row.external_attr >> 28 == 0xA:
                raise ValueError(f'Duplicate/linked release member: {member}')
            found.add(member.casefold())
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(row) as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
        if not set(wanted) <= found:
            raise ValueError('Archive missing a selected xTB runtime member')


def pe_stack(exe):
    data = exe.read_bytes()
    offset = struct.unpack_from('<I', data, 0x3c)[0]
    if data[offset:offset + 6] != b'PE\0\0\x64\x86' or struct.unpack_from('<H', data, offset + 24)[0] != 0x20B:
        raise ValueError('Expected PE32+ x64 program')
    return offset + 24 + 72, struct.unpack_from('<Q', data, offset + 24 + 72)[0]


def check_stack_derivative(original, derivative):
    offset, before = pe_stack(original)
    actual_offset, after = pe_stack(derivative)
    raw, amended = original.read_bytes(), derivative.read_bytes()
    if (actual_offset, before, after) != (offset, 2097152, 67108864) or (
        raw[:offset] != amended[:offset] or raw[offset + 8:] != amended[offset + 8:]
    ):
        raise ValueError('Existing GFN0 derivative must differ only by 2 to 64 MiB PE reserve')
    return {'sizeOfStackReserveOffset': offset, 'oldReserveBytes': before, 'newReserveBytes': after}


def dll_closure(binary_dir, objdump):
    seen = {}
    files = sorted(binary_dir.iterdir(), key=lambda p: p.name)
    names = {f.name.lower() for f in files}
    for file in files:
        result = subprocess.run([str(objdump), '-p', str(file)], capture_output=True, check=True)
        imports = sorted({line.split(b'DLL Name:', 1)[1].decode('ascii').strip().lower()
                          for line in result.stdout.splitlines() if b'DLL Name:' in line})
        absent = [name for name in imports if name not in names | SYSTEM_DLLS and not name.startswith('api-ms-win-crt-')]
        if absent:
            raise ValueError(f'{file.name} has unsatisfied native dependencies: {absent}')
        seen[file.name] = imports
    return seen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('official-zip', 'stack64', 'fire-build', 'tools', 'math-bin',
                 'openblas-licenses', 'legacy-licenses', 'node', 'lock-output'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--external-gxtb', action='store_true',
                        help='Prepare the public v4 set with ordinary variants only; no g-xTB archive is read')
    parser.add_argument('--gxtb-zip', type=Path)
    parser.add_argument('--gxtb-license', type=Path)
    args = parser.parse_args()
    if not args.external_gxtb and (args.gxtb_zip is None or args.gxtb_license is None):
        parser.error('The historical v3 profile requires --gxtb-zip and --gxtb-license; use --external-gxtb for v4')
    index = json.loads(INDEX.read_text(encoding='utf-8'))
    assembly = json.loads(ASSEMBLY.read_text(encoding='utf-8'))
    if assembly['schema'] != 'ester-xtb-v208-assembly/v1':
        raise ValueError('Unknown assembly declaration')
    index['gxtb'].update(assembly['gxtb'])
    index.update({key: assembly[key] for key in ('fireLibraries', 'fireLicenses')})
    verify(args.official_zip, index['official']['archive'])
    if not args.external_gxtb:
        verify(args.gxtb_zip, index['gxtb']['archive'])
    verify(args.stack64, index['stack64'])
    if not args.external_gxtb:
        verify(args.gxtb_license, index['gxtb']['license'])
    verify(args.math_bin / 'openblas.dll', index['fireOpenblas'])
    for name, info in index['fireLibraries'].items():
        verify((args.math_bin if name == 'VCRUNTIME140.dll' else args.tools / 'mingw64/bin') / name, info)
    objdump = (args.tools / 'mingw64/bin/objdump.exe').resolve()
    verify(objdump, next(row for row in index['fireTools'] if row['path'].endswith('/objdump.exe')))
    fire_receipt = args.fire_build / 'build-receipt.json'
    fire_record = json.loads(fire_receipt.read_text(encoding='utf-8'))
    fire_exe = args.fire_build / 'b/xtb.exe'
    if (fire_record['schema'] != 'ester-xtb-fire-source-build/v1'
        or fire_record['inputIndex'] != identity(INDEX)
        or fire_record['builder'] != identity(ROOT / 'scripts/native/build-xtb-v208-fire.py')
        or fire_record['sourceCommit'] != index['xtbSourceCommit']
        or fire_record['sources'] != index['fireSources']
        or fire_record['tools'] != index['fireTools']
        or fire_record['openblas']['sha256'] != index['fireOpenblas']['sha256']
        or not any(row['kind'] == 'fire-remaining-step-limit' for row in fire_record['sourceEdits'])):
        raise ValueError('Expected the declared FIRE source build')
    fire_identity = verify(fire_exe, fire_record['executable'])
    if pe_stack(fire_exe)[1] != 67108864:
        raise ValueError('FIRE needs its documented 64 MiB stack reserve')
    # Inputs are validated before creating a fresh, content-specific local root.
    lock_id = 'xtb-v208-4b8c987-' + fire_identity['sha256'][:12] + ('-external-gxtb' if args.external_gxtb else '')
    root = ROOT / '.local/dependencies/win-x64' / lock_id
    runtime = root / 'xtb'
    root.mkdir(parents=True, exist_ok=False)
    official, gxtb, fire = runtime, runtime / 'variants/gxtb', runtime / 'variants/fire'
    licenses = runtime / 'licenses'
    copy_release(args.official_zip, official, 'stage', licenses / 'official-6.8')
    if not args.external_gxtb:
        copy_release(args.gxtb_zip, gxtb, 'xtb-bleed-windows', None, dlls=tuple(index['gxtb']['dlls']))
    verify(official / 'bin/xtb.exe', index['official']['executable'])
    if not args.external_gxtb:
        verify(gxtb / 'bin/xtb.exe', index['gxtb']['executable'])
        for name, info in index['gxtb']['dlls'].items():
            verify(gxtb / 'bin' / name, info)
    stack = check_stack_derivative(official / 'bin/xtb.exe', args.stack64)
    copy(args.stack64, official / 'bin/xtb680-stack64.exe')
    if not args.external_gxtb:
        copy(args.gxtb_license, licenses / 'gxtb-2.0.1/GPL-3.0.txt')
    copy(fire_exe, fire / 'bin/xtb.exe')
    for name in PARAMETERS:
        copy(official / 'share/xtb' / name, fire / 'share/xtb' / name)
    for name in index['fireLibraries']:
        source = (args.math_bin if name == 'VCRUNTIME140.dll' else args.tools / 'mingw64/bin') / name
        copy(source, fire / 'bin' / name)
    copy(args.math_bin / 'openblas.dll', fire / 'bin/openblas.dll')
    for name, info in index['fireLicenses'].items():
        source = (args.openblas_licenses if name.startswith('openblas/') else args.legacy_licenses) / info['path']
        verify(source, info)
        copy(source, licenses / 'fire' / name)

    receipts = {}
    for name, info in {
        'official': {'release': index['official'], 'sourceCommit': index['xtbSourceCommit'],
                     'dllImports': dll_closure(official / 'bin', objdump)['xtb.exe']},
        'gfn0-stack64': {'archive': index['official']['archive'], 'original': index['official']['executable'],
                         'derivative': index['stack64'], 'peStackDelta': stack, 'sourceModified': False},
        'gxtb': ({'schema': 'ester-external-program-reference/v1', 'program': 'g-xTB',
                  'route': 'user-supplied-cli', 'downloadUrl': 'https://github.com/grimme-lab/g-xtb/releases',
                  'binaryBundled': False, 'samePackageDllsRequired': True}
                 if args.external_gxtb else {**index['gxtb'], 'dllImports': dll_closure(gxtb / 'bin', objdump)}),
        'fire': {**fire_record, 'actualBuildReceipt': identity(fire_receipt), 'dllImports': dll_closure(fire / 'bin', objdump)},
    }.items():
        receipts[name] = put_json(runtime / 'provenance' / (name + '.json'), info)['sha256']
    payload_inventory = put_json(runtime / 'inventory.json', {
        'schema': 'sciyue-xtb-runtime-inventory/v1', 'files': members(runtime),
    })
    common = {'version': '6.8.0', 'sourceCommit': index['xtbSourceCommit']}
    official_archive = {'archiveSha256': index['official']['archive']['sha256']}
    variants = {
        'official': {**common, **official_archive, 'root': '', 'entry': 'bin/xtb.exe', 'kind': 'official-release',
                     'buildId': 'xtb-v6.8.0-windows-x86_64-openblas-official',
                     'executableSha256': index['official']['executable']['sha256']},
        'gfn0-stack64': {**common, **official_archive, 'root': '', 'entry': 'bin/xtb680-stack64.exe', 'kind': 'pe-stack-derivative',
                         'buildId': 'xtb-v6.8.0-official-win64-pe-stack64', 'stackReserveBytes': stack['newReserveBytes'],
                         'parentExecutableSha256': index['official']['executable']['sha256'],
                         'executableSha256': index['stack64']['sha256']},
        'gxtb': {'root': 'variants/gxtb', 'entry': 'bin/xtb.exe', 'kind': 'official-gxtb-release',
                 'buildId': 'gxtb-v2.0.1-win64-host-6.7.1-30c6303',
                 'version': index['gxtb']['hostVersion'], 'sourceCommit': index['gxtb']['hostCommit'],
                 'gxtbRelease': index['gxtb']['release'], 'hostVersion': index['gxtb']['hostVersion'],
                 'hostCommit': index['gxtb']['hostCommit'], 'archiveSha256': index['gxtb']['archive']['sha256'],
                 'executableSha256': index['gxtb']['executable']['sha256']},
        'fire': {**common, 'root': 'variants/fire', 'entry': 'bin/xtb.exe', 'kind': 'fire-step-limit-rebuild',
                 'buildId': fire_record['buildId'], 'compiler': fire_record['compiler'],
                 'toolchainArchiveSha256': index['fireToolchainArchiveSha256'],
                 'scientificPinsSha256': fire_record['inputIndex']['sha256'],
                 'stackReserveBytes': fire_record['peStackReserveBytes'], 'fireStepLimit': 'remaining-microcycles-v1',
                 'executableSha256': fire_identity['sha256']},
    }
    if args.external_gxtb:
        del variants['gxtb']
    for name in variants:
        variants[name]['sourceReceiptSha256'] = receipts[name]
    methods = ['gfn0', 'gfn1', 'gfn2', 'gfnff'] + ([] if args.external_gxtb else ['gxtb'])
    manifest = put_json(runtime / 'runtime.json', {
        'schema': 'sciyue-xtb-bundled-runtime/v4' if args.external_gxtb else 'sciyue-xtb-bundled-runtime/v3',
        'platform': 'win32-x64', 'version': '6.8.0',
        'entry': 'bin/xtb.exe', 'dataDirectory': 'share/xtb', 'methods': methods,
        'scope': 'local-experimental', 'localUseReady': True, 'publicRedistributionReviewed': False,
        'inventory': payload_inventory, 'variants': variants,
        **({'externalProviders': {'gxtb': 'user-supplied-cli'}} if args.external_gxtb else {}),
    })
    # The host's own verifier is also used to generate canonical identity values.
    code = """const c=require(process.argv[1]),r=process.argv[2];
const out=c.verifyRuntimeSet(r,c.fileIdentity(r,'runtime.json'));
console.log(JSON.stringify(Object.fromEntries(Object.entries(out.variants).map(([k,v])=>[k,v.engineIdentity]))));"""
    result = subprocess.run([str(args.node.resolve()), '-e', code, str(ROOT / 'desktop/xtb-runtime-contract.cjs'),
                             str(runtime)], capture_output=True, check=True, text=True)
    identities = json.loads(result.stdout)
    root_relative = root.relative_to(ROOT).as_posix()
    lock = {
        'schema': 'sciyue-xtb-lock-v1', 'platform': 'win32-x64', 'lockId': lock_id, 'root': root_relative,
        'contentDirectories': ['xtb'], 'version': '6.8.0', 'entry': 'xtb/bin/xtb.exe', 'dataDirectory': 'xtb/share/xtb',
        'methods': methods, 'scope': 'local-experimental', 'localUseReady': True, 'publicRedistributionReviewed': False,
        'distributionLicenseReady': False, 'publicDistribution': False,
        'runtimeManifest': manifest, 'variantIdentities': identities, 'engineIdentity': identities['official'],
        **({'externalProviders': {'gxtb': 'user-supplied-cli'}} if args.external_gxtb else {}),
    }
    ref = put_json(root / 'inventory.json', {**lock, 'files': members(root)})
    lock['inventory'] = {**ref, 'path': root_relative + '/inventory.json'}
    put_json(args.lock_output, lock)
    print(json.dumps({'runtimeRoot': str(runtime), 'manifest': manifest, 'lock': identity(args.lock_output)}, indent=2))


if __name__ == '__main__':
    main()
