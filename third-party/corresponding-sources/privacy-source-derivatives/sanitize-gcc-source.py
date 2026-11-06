"""Exact GCC test-core privacy derivative. See SANITIZER-LICENSE.txt (MIT).

Local archive transformation only: no download, installation or build command.
"""
from pathlib import Path, PurePosixPath
import argparse, gzip, hashlib, json, tarfile, time

def identity(path):
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    return {'bytes': path.stat().st_size, 'sha256': digest}

def logical_row(info, content_hash):
    pax = dict(info.pax_headers)
    # PAX long-name serialization can add only this equivalent path header.
    if 'path' in pax and (pax['path'] == info.name or
            (info.isdir() and pax['path'].rstrip('/') == info.name.rstrip('/'))):
        del pax['path']
    return {'path': info.name, 'type': info.type.decode('latin1'),
            'bytes': info.size, 'sha256': content_hash, 'mode': info.mode,
            'uid': info.uid, 'gid': info.gid, 'uname': info.uname,
            'gname': info.gname, 'mtime': info.mtime, 'linkname': info.linkname,
            'paxHeaders': pax}

def append_hash(target, row):
    target.update((json.dumps(row, sort_keys=True, separators=(',', ':')) + '\n').encode())

class HashReader:
    def __init__(self, stream):
        self.stream = stream
        self.digest = hashlib.sha256()
        self.bytes = 0
    def read(self, size=-1):
        data = self.stream.read(size)
        self.digest.update(data)
        self.bytes += len(data)
        return data

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True, choices=('13.2.0', '16.2.0'))
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    index = json.loads(Path(__file__).with_name('DERIVATIVES.json').read_text(encoding='utf-8'))
    spec = next(row for row in index['derivatives'] if row['version'] == args.version)
    source = args.input.resolve(strict=True)
    output = args.output.resolve()
    receipt = args.receipt.resolve()
    if source in (output, receipt) or output == receipt or output.exists() or receipt.exists():
        raise FileExistsError('Select distinct, new output and receipt files; original is never overwritten')
    if not output.parent.is_dir() or not receipt.parent.is_dir():
        raise FileNotFoundError('Create caller-selected output directories first')
    before = identity(source)
    if before != spec['officialInput']['identity']:
        raise ValueError('Official input archive identity mismatch')
    exclusion = spec['excludedMembers'][0]
    excluded = 0
    kept = 0
    expected = hashlib.sha256()
    started = time.monotonic()
    with tarfile.open(source, mode='r|*') as old, output.open('xb') as raw:
        with gzip.GzipFile(filename='', fileobj=raw, mode='wb', compresslevel=1, mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode='w|', format=tarfile.PAX_FORMAT) as new:
                for info in old:
                    if info.name == exclusion['path']:
                        data = old.extractfile(info).read()
                        plain = gzip.decompress(data)
                        if {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} != exclusion['compressedIdentity']:
                            raise ValueError('Excluded member identity mismatch')
                        if {'bytes': len(plain), 'sha256': hashlib.sha256(plain).hexdigest()} != exclusion['decodedIdentity']:
                            raise ValueError('Excluded decoded core identity mismatch')
                        excluded += 1
                        continue
                    name = PurePosixPath(info.name)
                    if name.is_absolute() or '..' in name.parts:
                        raise ValueError('Unsafe original member name')
                    reader = HashReader(old.extractfile(info)) if info.isfile() else None
                    new.addfile(info, reader)
                    if reader and reader.bytes != info.size:
                        raise ValueError('Incomplete original member')
                    append_hash(expected, logical_row(info, reader.digest.hexdigest() if reader else None))
                    kept += 1
    if excluded != 1:
        raise ValueError('Exactly one declared core fixture must be omitted')
    actual = hashlib.sha256()
    verified = 0
    with tarfile.open(output, mode='r|*') as archive:
        for info in archive:
            if info.name == exclusion['path']:
                raise ValueError('Excluded fixture remains in output')
            digest = None
            if info.isfile():
                digest = hashlib.file_digest(archive.extractfile(info), 'sha256').hexdigest()
            append_hash(actual, logical_row(info, digest))
            verified += 1
    if kept != verified or expected.digest() != actual.digest():
        raise ValueError('Remaining logical member identity mismatch')
    if identity(source) != before:
        raise ValueError('Original archive changed during transformation')
    result = {'schema': 'sy-gcc-privacy-derivative-proof/v1', 'version': args.version,
              'input': before, 'output': identity(output), 'excludedMembers': spec['excludedMembers'],
              'retainedMembers': kept, 'independentlyVerifiedMembers': verified,
              'remainingLogicalMembersSha256': actual.hexdigest(),
              'allRemainingLogicalMetadataAndContentIdentical': True,
              'archiveEncoding': index['archiveEncoding'],
              'elapsedSeconds': time.monotonic() - started,
              'originalArchiveModified': False, 'buildOrScientificCommandExecuted': False}
    with receipt.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
    print(json.dumps({'version': args.version, 'output': result['output'], 'retainedMembers': kept}))

if __name__ == '__main__':
    main()
