"""Owned result transport. Only ES serialization is segmented, never science.

Every attachment lives directly in the host-created workspace. Metadata retains
the exact source/frame/unit contract; the host consumes and removes attachments
before accepting a result. A failed/closed session retains its usual root owner.
"""
from pathlib import Path
import base64
import hashlib
import json
import re
import uuid


class PackedArray:
    """Exact finite native values or domain memberships, with no text copy."""
    def __init__(self, array, encoding):
        self.encoding = encoding
        self.array = array.astype('<f8' if encoding == 'float64-le' else 'u1', order='C', copy=False)


def packed_values(array):
    return PackedArray(array, 'float64-le')


def packed_mask(array):
    return PackedArray(array, 'uint8')


def sha256_file(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_domain_record(path, value):
    """Preserve the existing JSON maskBase64 sidecar format by writing pages."""
    with Path(path).open('w', encoding='utf-8', newline='\n') as stream:
        def put(item):
            if isinstance(item, dict):
                stream.write('{')
                for index, (key, entry) in enumerate(item.items()):
                    if index:
                        stream.write(',')
                    json.dump('maskBase64' if key == 'maskBinary' else key, stream)
                    stream.write(':')
                    put(entry)
                stream.write('}')
            elif isinstance(item, PackedArray):
                stream.write('"')
                view = memoryview(item.array).cast('B')
                for start in range(0, len(view), 49152):
                    stream.write(base64.b64encode(view[start:start + 49152]).decode('ascii'))
                stream.write('"')
            else:
                json.dump(item, stream, allow_nan=False, separators=(',', ':'))
        put(value)


def read_domain_record(path, revision, points):
    """Load exact bound metadata while decoding its single mask in file pages.

    New sidecars have a compact Base64 value. The spacer covers legacy JSON
    written by Python's compact/default separators without changing the format.
    """
    import numpy as np
    metadata = bytearray()
    header = re.compile(rb'"maskBase64": ?"')
    pending = b''
    digest = hashlib.sha256()
    mask, offset, padding = None, 0, False
    state = 'head'

    def decode_page(data):
        nonlocal offset, padding
        if not data:
            return
        if padding:
            raise ValueError('Invalid data after domain padding.')
        raw = base64.b64decode(data, validate=True)
        if len(raw) > points - offset:
            raise ValueError('Bound domain mask exceeds the grid.')
        values = np.frombuffer(raw, dtype=np.uint8)
        if values.size and values.max() > 1:
            raise ValueError('Bound domain mask contains invalid memberships.')
        mask[offset:offset + len(raw)] = values
        offset += len(raw)
        padding = b'=' in data

    with Path(path).open('rb') as stream:
        for raw in iter(lambda: stream.read(65536), b''):
            digest.update(raw)
            data, pending = pending + raw, b''
            if state == 'head':
                match = header.search(data)
                if not match:
                    metadata.extend(data[:-32]); pending = data[-32:]; continue
                metadata.extend(data[:match.end()]); data = data[match.end():]
                mask = np.empty(points, dtype=np.uint8)
                state = 'mask'
            if state == 'mask':
                end = data.find(b'"')
                if end < 0:
                    whole = len(data) // 4 * 4
                    decode_page(data[:whole]); pending = data[whole:]; continue
                if end % 4:
                    raise ValueError('Bound domain mask is truncated.')
                decode_page(data[:end]); data = data[end:]
                state = 'tail'
            metadata.extend(data)
    if digest.hexdigest() != revision or state == 'mask' or mask is not None and offset != points:
        raise ValueError('Bound domain file changed or mask is incomplete.')
    metadata.extend(pending)
    result = json.loads(metadata)
    if mask is not None:
        if result.get('validDomain', {}).pop('maskBase64', None) != '':
            raise ValueError('Bound mask is outside its valid-domain metadata.')
        result['validDomain']['maskBinary'] = packed_mask(mask)
    return result


class ExportFile:
    def __init__(self, path, revision):
        self.path, self.revision = Path(path), revision

    def copy_verified(self, target):
        digest = hashlib.sha256()
        created = False
        try:
            with self.path.open('rb') as source, target.open('xb') as output:
                created = True
                for chunk in iter(lambda: source.read(262144), b''):
                    digest.update(chunk)
                    output.write(chunk)
                if digest.hexdigest() != self.revision:
                    raise ValueError('The completed Cube or its bound domain changed before export.')
                return self.revision
        except Exception:
            if created:
                target.unlink(missing_ok=True)
            raise


class ExportRows:
    def __init__(self, rows):
        self.rows = rows

    def copy_verified(self, target):
        digest = hashlib.sha256()
        created = False
        try:
            with target.open('xb') as output:
                created = True
                for row in self.rows:
                    chunk = (row + '\n').encode('utf-8')
                    output.write(chunk); digest.update(chunk)
        except Exception:
            if created:
                target.unlink(missing_ok=True)
            raise
        return digest.hexdigest()


def cube_export_file(name, path, revision, sidecar=None):
    result = dict(name=name, file=ExportFile(path, revision))
    if sidecar:
        path, revision = sidecar
        result['domain'] = dict(name=name + '.sciyue-domain.json', file=ExportFile(path, revision))
    return result


def managed_result(value, workspace, key=None):
    root = Path(workspace).resolve()
    def attachment(kind):
        return root / ('es-result-' + uuid.uuid4().hex + '.' + kind)

    def encode(item, key=None):
        if isinstance(item, (ExportFile, ExportRows)):
            target = attachment('bin')
            revision = item.copy_verified(target)
            return dict(esResultAttachment=target.name, encoding='verified-export', bytes=target.stat().st_size, sha256=revision)
        if isinstance(item, PackedArray):
            target = attachment('bin')
            # tofile streams contiguous native buffers directly. Its C-order
            # contract also handles a non-contiguous view without a .tobytes copy.
            with target.open('xb') as stream:
                item.array.tofile(stream)
            return dict(esResultAttachment=target.name, encoding=item.encoding, bytes=target.stat().st_size)
        if isinstance(item, dict):
            return {name: encode(entry, name) for name, entry in item.items()}
        if isinstance(item, str) and key in ('valuesBase64', 'maskBase64', 'dataBase64'):
            target = attachment('bin')
            # Decode bounded base64 blocks, avoiding a second complete byte copy.
            with target.open('xb') as stream:
                for offset in range(0, len(item), 262144):
                    stream.write(base64.b64decode(item[offset:offset+262144], validate=True))
            return dict(esResultAttachment=target.name, encoding='bytes', bytes=target.stat().st_size)
        if isinstance(item, str) and len(item) > 65536:
            target = attachment('txt')
            with target.open('x', encoding='utf-8', newline='') as stream:
                for offset in range(0, len(item), 65536):
                    stream.write(item[offset:offset+65536])
            return dict(esResultAttachment=target.name, encoding='utf8', bytes=target.stat().st_size)
        if isinstance(item, (list, tuple)):
            if len(item) <= 4096:
                return [encode(entry) for entry in item]
            target = attachment('jsonl')
            with target.open('x', encoding='utf-8', newline='\n') as stream:
                for entry in item:
                    json.dump(encode(entry), stream, allow_nan=False, separators=(',', ':'))
                    stream.write('\n')
            return dict(esResultAttachment=target.name, encoding='jsonl', bytes=target.stat().st_size, count=len(item))
        return item

    return encode(value,key)
