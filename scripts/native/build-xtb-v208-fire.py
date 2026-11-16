"""Build the bounded-cycle xTB 6.8 Windows executable with existing tools.

No downloads or science runs. Use the exact sources in the v208 input index.
The job limits below bound this build only, and are not product run limits.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tarfile
import time
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]
SUPPORT = ROOT / 'third-party/corresponding-sources/build-support/xtb-gnu'
INDEX = ROOT / 'third-party/build-inputs/declarations/xtb-v208-inputs.json'
SOURCE = 'src/relaxation_engine.f90'
BUILD_ID = '4b8c987-ester-fire-limit-gnu132-openblas033'
OLD = b'(env,iter,thisstep,opt,molopt, &'
NEW = b'(env,iter,min(thisstep,maxcycle-iter),opt,molopt, &'


def identity(path):
    with path.open('rb') as stream:
        return {'bytes': path.stat().st_size, 'sha256': hashlib.file_digest(stream, 'sha256').hexdigest()}


def verify(path, expected):
    observed = identity(path)
    if observed != {k: expected[k] for k in observed}:
        raise ValueError(f'Input identity differs: {path}')
    return observed


def write_json(path, value):
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def unpack(path, out):
    out.mkdir(parents=True, exist_ok=True)
    with tarfile.open(path, 'r:gz') as archive:
        for member in archive:
            pieces = PurePosixPath(member.name).parts
            if not pieces or any(p in ('.', '..') or '\\' in p or ':' in p for p in pieces):
                raise ValueError(f'Unsafe archive member: {member.name}')
            if len(pieces) == 1 and member.isdir():
                continue
            target = out.joinpath(*pieces[1:])
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output)
            elif not member.issym():
                raise ValueError(f'Unsupported archive member: {member.name}')
            # Source archives include documentation aliases and test-data links;
            # the CLI build never consumes them. No link is materialized.


def patch(source):
    target = source / SOURCE
    before = verify(target, {'bytes': target.stat().st_size,
                             'sha256': '6d7b982b20a1dbc1ac499338b28bf7bc5b4e58afe5c66985d87c03105dea384a'})
    data = target.read_bytes()
    if data.count(OLD) != 1:
        raise ValueError('Expected one upstream FIRE microcycle call')
    target.write_bytes(data.replace(OLD, NEW))
    # Build metadata only: no local account or machine name enters the artifact.
    meson = source / 'meson.build'
    original = identity(meson)
    data = meson.read_bytes()
    for query, label in [
        (b'import getpass; print(getpass.getuser())', b'print("Ester Studio")'),
        (b'import socket; print(socket.gethostname())', b'print("local locked build")'),
    ]:
        if data.count(query) != 1:
            raise ValueError('Expected one upstream build metadata query')
        data = data.replace(query, label)
    meson.write_bytes(data)
    return [
        {'path': SOURCE, 'before': before, 'after': identity(target), 'kind': 'fire-remaining-step-limit'},
        {'path': 'meson.build', 'before': original, 'after': identity(meson), 'kind': 'build-metadata-only'},
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources', type=Path, required=True)
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--tools', type=Path, required=True)
    parser.add_argument('--math-bin', type=Path, required=True)
    parser.add_argument('--jobs', type=int, default=6)
    parser.add_argument('--memory-gib', type=int, default=8)
    parser.add_argument('--seconds', type=int, default=900)
    args = parser.parse_args()
    work, tools, math = (value.resolve() for value in (args.work, args.tools, args.math_bin))
    binary, meson = tools / 'mingw64/bin', tools / 'meson-1.4.1'
    source, build, abi = work / 's', work / 'b', work / 'abi'
    win = Path(os.environ['SYSTEMROOT'])
    index = json.loads(INDEX.read_text(encoding='utf-8'))
    for item in index['fireSources']:
        verify(args.sources / item['name'], item)
    for item in index['fireTools']:
        verify(tools / item['path'], item)
    verify(math / 'openblas.dll', index['fireOpenblas'])
    work.mkdir(parents=True, exist_ok=False)
    for name in ('logs', 'home', 'temp', 'abi'):
        (work / name).mkdir()
    for item in index['fireSources']:
        unpack(args.sources / item['name'], source / item['destination'])
    edits = patch(source)
    write_json(work / 'source-edits.json', edits)

    env = {key: os.environ[key] for key in ('SYSTEMROOT', 'WINDIR', 'COMSPEC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE') if key in os.environ}
    env.update(
        PATH=os.pathsep.join(map(str, [binary, Path(sys.executable).parent, math, win / 'System32', win])),
        USERPROFILE=str(work / 'home'), TEMP=str(work / 'temp'), TMP=str(work / 'temp'),
        PYTHONUTF8='1', PYTHONDONTWRITEBYTECODE='1', PYTHONPATH=str(meson),
        LIBRARY_PATH=str(abi), OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS=str(args.jobs),
    )
    deadline = time.monotonic() + args.seconds

    def run(name, cmd, cwd=work):
        logs = work / 'logs'
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Build deadline elapsed')
        request = logs / (name + '.request.json')
        write_json(request, {
            'command': list(map(str, cmd)), 'cwd': str(cwd), 'env': env,
            'stdout': str(logs / (name + '.stdout.txt')), 'stderr': str(logs / (name + '.stderr.txt')),
            'receipt': str(logs / (name + '.receipt.json')),
            'threads': args.jobs, 'memoryGiB': args.memory_gib, 'timeoutSeconds': remaining,
        })
        subprocess.run([sys.executable, '-B', str(SUPPORT / 'bounded-command.py'), str(request)], check=True)

    shutil.copyfile(math / 'openblas.dll', abi / 'openblas.dll')
    run('gendef', [binary / 'gendef.exe', abi / 'openblas.dll'], abi)
    run('dlltool', [binary / 'dlltool.exe', '-d', abi / 'openblas.def', '-D', 'openblas.dll', '-l', abi / 'libopenblas.dll.a'], abi)
    native = work / 'native.ini'
    bins = {'c': binary / 'gcc.exe', 'fortran': binary / 'gfortran.exe',
            'ar': binary / 'ar.exe', 'strip': binary / 'strip.exe',
            'python': Path(sys.executable), 'python3': Path(sys.executable)}
    flags = ['-L' + abi.as_posix()]
    native.write_text(
        '[binaries]\n' + ''.join(f'{name} = {value.as_posix()!r}\n' for name, value in bins.items())
        + f'[built-in options]\nfortran_link_args = {flags + ["-Xlinker", "--stack", "-Xlinker", "67108864,4096"]!r}\n'
        + f'c_link_args = {flags!r}\n', encoding='utf-8',
    )
    options = [
        '--buildtype=release', '--optimization=2', '--default-library=static', '--wrap-mode=nodownload',
        '-Dlapack=openblas', '-Dtblite=enabled', '-Dtblite:ddx=true', '-Dcpcmx=enabled',
        '-Dcpx:lapack=openblas', '-Dtblite:lapack=openblas', '-Dddx:lapack=openblas',
        '-Dbuild_name=' + BUILD_ID,
    ]
    run('setup', [sys.executable, '-B', '-m', 'mesonbuild.mesonmain', 'setup', build, source,
                  '--native-file', native, '--prefix', work / 'install', *options])
    run('compile', [binary / 'ninja.exe', '-C', build, '-j', args.jobs, 'xtb.exe'])
    run('pe-imports', [binary / 'objdump.exe', '-p', build / 'xtb.exe'])
    executable = build / 'xtb.exe'
    data = executable.read_bytes()
    pe_offset = struct.unpack_from('<I', data, 0x3c)[0]
    if data[pe_offset:pe_offset + 6] != b'PE\0\0\x64\x86':
        raise ValueError('Expected x64 Windows PE')
    reserve, commit = struct.unpack_from('<QQ', data, pe_offset + 24 + 72)
    if (reserve, commit) != (67108864, 4096):
        raise ValueError('64 MiB stack reserve required for the GFN0 periodic route')
    write_json(work / 'build-receipt.json', {
        'schema': 'ester-xtb-fire-source-build/v1', 'buildId': BUILD_ID,
        'inputIndex': identity(INDEX), 'builder': identity(Path(__file__)),
        'sourceCommit': index['xtbSourceCommit'], 'sources': index['fireSources'],
        'tools': index['fireTools'], 'compiler': {'name': 'gfortran', 'version': '13.2.0'},
        'openblas': index['fireOpenblas'], 'options': options, 'sourceEdits': edits,
        'executable': identity(executable), 'peStackReserveBytes': reserve, 'peStackCommitBytes': commit,
        'officialBinaryIdentity': False, 'scienceExecuted': False,
    })


if __name__ == '__main__':
    main()
