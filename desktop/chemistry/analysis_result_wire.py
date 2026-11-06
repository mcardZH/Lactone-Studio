"""Owned result transport. Only ES serialization is segmented, never science.

Every attachment lives directly in the host-created workspace. Metadata retains
the exact source/frame/unit contract; the host consumes and removes attachments
before accepting a result. A failed/closed session retains its usual root owner.
"""
from pathlib import Path
import base64
import json
import uuid


def managed_result(value, workspace, key=None):
    root = Path(workspace).resolve()
    def attachment(kind):
        return root / ('es-result-' + uuid.uuid4().hex + '.' + kind)

    def encode(item, key=None):
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
