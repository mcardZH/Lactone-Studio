"""Bounded serial transport for the unchanged crystal_modeling.run function."""
import json
import re
import sys
import warnings

import crystal_modeling

PROTOCOL = 'sciyue-crystal-worker/v1'


def main():
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return 0
        identity = dict(protocol=PROTOCOL, id=None, owner=None, documentId=None, expectedRevision=None)
        oversized = not line.endswith(b'\n')
        try:
            crystal_modeling.require(not oversized, 'Crystal request exceeds the native line limit')
            envelope = json.loads(line.decode('utf-8'), parse_constant=lambda _: crystal_modeling.require(False, 'Non-finite JSON numbers are not supported'))
            crystal_modeling.require(isinstance(envelope, dict) and set(envelope) == set(identity) | {'request'}, 'Invalid crystal envelope')
            crystal_modeling.require(envelope['protocol'] == PROTOCOL and isinstance(envelope['id'], str) and re.fullmatch(r'crystal-[0-9]{1,16}', envelope['id']) is not None, 'Invalid crystal transport identity')
            crystal_modeling.require(type(envelope['owner']) is int and 0 <= envelope['owner'] <= 9007199254740991, 'Invalid crystal owner')
            request = envelope['request']
            crystal_modeling.require(isinstance(request, dict) and isinstance(envelope['documentId'], str) and envelope['documentId'] == request.get('documentId') and type(envelope['expectedRevision']) is int and 0 <= envelope['expectedRevision'] <= 9007199254740991 and envelope['expectedRevision'] == request.get('expectedRevision'), 'Crystal envelope source identity changed')
            identity = {key: envelope[key] for key in identity}
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', DeprecationWarning)
                result = crystal_modeling.run(request)
            response = dict(identity, ok=True, result=result)
        except Exception as error:
            response = dict(identity, ok=False, error=dict(code='crystal-rejected' if isinstance(error, crystal_modeling.CrystalError) else 'crystal-native-failed', message=str(error) if isinstance(error, crystal_modeling.CrystalError) else 'Crystal preview failed; source unchanged'))
        encoded = json.dumps(response, ensure_ascii=True, allow_nan=False, separators=(',', ':')) + '\n'
        sys.stdout.write(encoded)
        sys.stdout.flush()
        if oversized:
            return 1
        # No input, candidate or prior response remains retained while idle.
        line = envelope = request = result = response = encoded = None


if __name__ == '__main__':
    raise SystemExit(main())
