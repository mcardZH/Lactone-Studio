"""Materialize exact public build inputs without installing or resolving packages.

Python >=3.12 plus Node >=24 (zstd support) are bootstrap tools. No imported
archive code is executed. The manifest fixes every archive and output byte.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import struct
import tempfile
import tarfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MANIFEST = ROOT / 'third-party/build-inputs/acquisition.json'


def require(value, message):
    if not value:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def member(name):
    import re
    require(isinstance(name, str) and name and '\\' not in name and ':' not in name and not name.startswith('/'), 'Unsafe member')
    require(all(p not in ('', '.', '..') and not any(ord(c) < 32 for c in p) for p in name.split('/')), 'Unsafe member')
    require(all(not p.endswith(('.', ' ')) and not re.fullmatch(r'(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?',p,re.I) and not any(c in p for c in '<>"|?*') for p in name.split('/')), 'Unsafe Windows member')
    return name


def ordinary(path):
    path = Path(os.path.abspath(path))
    for parent in (path, *path.parents):
        require(not parent.is_symlink() and not getattr(parent, 'is_junction', lambda: False)(), 'Linked path refused: ' + str(parent))
    return path


def checked(path, identity):
    path = ordinary(path)
    require(path.is_file(), 'Missing regular input: ' + str(path))
    require(path.stat().st_nlink == 1, 'Hardlinked input refused')
    before = path.stat()
    data = path.read_bytes()
    after = path.stat()
    require((before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'Input changed while reading')
    require(len(data) == identity['bytes'] and digest(data) == identity['sha256'], 'Changed input: ' + str(path))
    return data


def cabinet_member(path, chain, work):
    """Read an exact nested CAB chain with Windows' data-only expand utility.

    The redistributable/installer is never executed. Only explicitly named
    cabinet members are expanded; scratch outputs stay in an owned build root.
    """
    import re
    require(os.name == 'nt', 'Windows expand.exe required for Microsoft CAB input')
    parts=chain.split('/')
    require(len(parts) in (2,4,6), 'Bounded exact CAB chain required')
    require(all(re.fullmatch(r'cab@\d+',parts[i]) for i in range(0,len(parts),2)), 'Exact CAB offsets required')
    require(all('/'not in member(parts[i]) and '\\'not in parts[i] for i in range(1,len(parts),2)), 'Flat exact CAB filenames required')
    data=ordinary(path).read_bytes()
    work=ordinary(work);work.mkdir(parents=True,exist_ok=True)
    for level in range(0,len(parts),2):
        offset=int(parts[level][4:]);name=parts[level+1]
        require(offset+36<=len(data) and data[offset:offset+4]==b'MSCF' and data[offset+24:offset+26]==b'\x03\x01','Declared CAB header differs')
        size=struct.unpack_from('<I',data,offset+8)[0]
        require(size>=36 and offset+size<=len(data),'Declared CAB span differs')
        owned=Path(tempfile.mkdtemp(prefix='cab-',dir=work));cab=owned/'input.cab';cab.write_bytes(data[offset:offset+size]);out=owned/'members';out.mkdir()
        executable=Path(os.environ['SystemRoot'])/'System32/expand.exe'
        result=subprocess.run([str(executable),'-F:'+name,str(cab),str(out)],capture_output=True,timeout=120)
        require(result.returncode==0,'CAB expansion failed; owned scratch retained')
        target=ordinary(out/name);require(target.is_file(),'Exact CAB member absent')
        data=target.read_bytes()
    return data


def archive_members(path, node='node'):
    """Yield regular member bytes only; never extract archive links or paths."""
    path = ordinary(path)
    if path.suffix in ('.zip', '.whl', '.conda'):
        with zipfile.ZipFile(path) as archive:
            for item in archive.infolist():
                if item.is_dir():
                    continue
                member(item.filename)
                mode = item.external_attr >> 16
                require((mode & 0o170000) != 0o120000, 'Archive symbolic link refused')
                if path.suffix == '.conda':
                    if not item.filename.endswith('.tar.zst'):
                        continue
                    compressed = archive.read(item)
                    result = subprocess.run([node, '-e', "const z=require('node:zlib');let a=[];process.stdin.on('data',b=>a.push(b));process.stdin.on('end',()=>process.stdout.write(z.zstdDecompressSync(Buffer.concat(a),{maxOutputLength:2147483647})));"], input=compressed, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180, check=True)
                    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode='r:') as tar:
                        for entry in tar:
                            if entry.isdir():
                                continue
                            require(entry.isfile(), 'Nonregular Conda member refused')
                            name = entry.name.removeprefix('./')
                            member(name)
                            yield name, tar.extractfile(entry).read()
                else:
                    yield item.filename, archive.read(item)
    else:
        with tarfile.open(path, mode='r:*') as archive:
            for item in archive:
                if item.isdir():
                    continue
                require(item.isfile(), 'Nonregular archive member refused')
                name = item.name.removeprefix('./')
                member(name)
                yield name, archive.extractfile(item).read()


def validate_manifest(manifest):
    require(manifest['schema'] == 'sy-public-build-inputs/v1', 'Wrong acquisition manifest')
    require(manifest.get('scientificVersionsChanged') is False, 'Scientific versions must remain fixed')
    sources = {a['id']: a for a in manifest['archives']}
    require(len(sources) == len(manifest['archives']), 'Duplicate archive')
    for archive in sources.values():
        member(archive['filename'])
        require('/' not in archive['filename'] and archive['url'].startswith('https://'), 'Exact HTTPS archive required')
        require(len(archive['sha256']) == 64 and archive['bytes'] > 0, 'Archive identity required')
    destinations = set()
    for payload in manifest['payloads']:
        root = member(payload['root'])
        require(root.startswith(('.local/dependencies/win-x64/', '.local/toolchains/win-x64/')), 'Declared local content root required')
        for row in payload['files']:
            target = root + '/' + member(row['path'])
            require(target.casefold() not in destinations, 'Duplicate/case-colliding payload member')
            destinations.add(target.casefold())
            source = row['source']
            require(source['kind'] in ('archive', 'literal', 'pe-stack-reserve','windows-cab-chain'), 'Unknown material operation')
            if source['kind'] in ('archive', 'pe-stack-reserve','windows-cab-chain'):
                require(source['archive'] in sources, 'Missing archive identity')
                member(source['member'])
            else:
                require(member(source['path']).startswith('third-party/build-inputs/literals/'), 'Declared build-only literal required')
    return sources


def select_payloads(manifest, skip_xtb=False, legacy_xtb=False):
    """Choose data inputs explicitly without rewriting any archived contract."""
    validate_manifest(manifest)
    require(not(skip_xtb and legacy_xtb), '--skip-xtb and --legacy-xtb are mutually exclusive')
    xtb=[p for p in manifest['payloads'] if p.get('name')=='xtb-runtime']
    require(not xtb or skip_xtb or legacy_xtb,
            'Manifest contains legacy xTB: choose --skip-xtb for GNU rebuild or explicitly --legacy-xtb')
    if not skip_xtb:return copy.deepcopy(manifest)
    selected=copy.deepcopy(manifest)
    selected['payloads']=[p for p in selected['payloads'] if p.get('name')!='xtb-runtime']
    require(selected['payloads'], 'No native/toolchain payload remains')
    used={r['source']['archive'] for p in selected['payloads'] for r in p['files'] if r['source']['kind']!='literal'}
    selected['archives']=[a for a in selected['archives'] if a['id'] in used]
    if 'transformations' in selected:selected['transformations']=[r for r in selected['transformations'] if r.get('payload')!='xtb-runtime']
    selected['selection']={'skippedPayloads':['xtb-runtime'],'legacyXtbMaterialized':False}
    validate_manifest(selected)
    return selected


def fetch(manifest, cache):
    sources = validate_manifest(manifest)
    ordinary(cache)
    cache.mkdir(parents=True, exist_ok=True)
    for archive in sources.values():
        path = ordinary(cache / archive['filename'])
        if path.exists():
            checked(path, archive)
            continue
        print(json.dumps({'download': archive['url'], 'bytes': archive['bytes'], 'destination': str(path)}), flush=True)
        temporary = path.with_name(path.name + '.partial')
        require(not temporary.exists(), 'Previous partial download preserved')
        with urllib.request.urlopen(archive['url'], timeout=90) as response, temporary.open('xb') as output:
            while block := response.read(1024 * 1024):
                output.write(block)
        checked(temporary, archive)
        temporary.rename(path)


def materialize(manifest, cache, root, node='node'):
    sources = validate_manifest(manifest)
    root = ordinary(root)
    require(root == ROOT, 'Run this build tool from its own source root')
    targets = [ordinary(root / p['root']) for p in manifest['payloads']]
    require(all(not p.exists() for p in targets), 'Existing payload/partial attempt protected')
    wanted = {}
    for payload in manifest['payloads']:
        for row in payload['files']:
            if row['source']['kind'] != 'literal':
                wanted.setdefault(row['source']['archive'], set()).add(row['source']['member'])
    # Verify archives and literals before any payload output is created.
    for archive in sources.values():
        checked(cache / archive['filename'], archive)
    for payload in manifest['payloads']:
        checked(root / payload['inventory']['path'], payload['inventory'])
        for row in payload['files']:
            if row['source']['kind'] == 'literal':
                checked(root / row['source']['path'], row)
    for target in targets:
        target.mkdir(parents=True)
    planned = {}
    for payload in manifest['payloads']:
        for row in payload['files']:
            source = row['source']
            if source['kind'] == 'literal':
                data = checked(root / source['path'], row)
                output_member(root / payload['root'] / row['path'], data, row)
            else:
                planned.setdefault((source['archive'], source['member']), []).append((payload, row))
    for payload in manifest['payloads']:
        for row in payload['files']:
            source=row['source']
            if source['kind']=='windows-cab-chain':
                archive=sources[source['archive']]
                data=cabinet_member(cache/archive['filename'],source['member'],root/'.cache/materialization-cabs')
                output_member(root/payload['root']/row['path'],data,row)
                planned.pop((source['archive'],source['member']))
    for key, archive in sources.items():
        if not any(archive_key==key for archive_key,_ in planned):continue
        for name, data in archive_members(cache / archive['filename'], node):
            for payload, row in planned.pop((key, name), []):
                source = row['source']
                if source['kind'] == 'pe-stack-reserve':
                    require(digest(data) == source['originalSha256'], 'Unexpected original PE')
                    buffer = bytearray(data)
                    offset = source['offset']
                    require(int.from_bytes(buffer[offset:offset+8], 'little') == source['oldValue'], 'Unexpected PE stack reserve')
                    buffer[offset:offset+8] = source['newValue'].to_bytes(8, 'little')
                    data = bytes(buffer)
                output_member(root / payload['root'] / row['path'], data, row)
    require(not planned, 'Missing archive members: ' + repr(list(planned)[:5]))
    for payload in manifest['payloads']:
        target = root / payload['root']
        expected = {r['path'] for r in payload['files']}
        actual = {p.relative_to(target).as_posix() for p in target.rglob('*') if p.is_file()}
        require(actual == expected, 'Payload membership differs')
        for row in payload['files']:
            checked(target / row['path'], row)
        inventory = checked(root / payload['inventory']['path'], payload['inventory'])
        with (target / 'inventory.json').open('xb') as output:
            output.write(inventory)
    print(json.dumps({'materialized': [str(p) for p in targets], 'scientificExecution': False, 'installation': False}))


def output_member(path, data, identity):
    require(len(data) == identity['bytes'] and digest(data) == identity['sha256'], 'Materialized byte identity differs: ' + str(path))
    path = ordinary(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as output:
        output.write(data)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('plan', 'fetch', 'materialize'))
    parser.add_argument('--manifest', type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--node', default='node')
    selection=parser.add_mutually_exclusive_group()
    selection.add_argument('--skip-xtb',action='store_true',help='Materialize native/toolchain only; build and admit GNU xTB separately')
    selection.add_argument('--legacy-xtb',action='store_true',help='Explicitly select the historical pinned xTB payload')
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding='utf-8'))
    manifest=select_payloads(manifest,args.skip_xtb,args.legacy_xtb)
    if args.command == 'plan':
        print(json.dumps({'archiveBytes': sum(a['bytes'] for a in manifest['archives']), 'payloadBytes': sum(r['bytes'] for p in manifest['payloads'] for r in p['files']), 'selectedPayloads': [p.get('name',p['root']) for p in manifest['payloads']], 'skippedPayloads': manifest.get('selection',{}).get('skippedPayloads',[]), 'downloadsExecuted': False, 'installation': False}, indent=2))
    elif args.command == 'fetch':
        fetch(manifest, ordinary(args.cache))
    else:
        materialize(manifest, ordinary(args.cache), ROOT, args.node)
