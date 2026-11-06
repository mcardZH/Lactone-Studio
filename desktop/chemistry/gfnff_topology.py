"""Fixed initial GFN-FF topology seed shared by isolated and periodic drivers.

The native member contains initialized charges and parameter arrays as well as
connectivity. Rebuilding it at each geometry would change the sampled potential.
"""
import hashlib
import json
import stat
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def runtime_seed_identity(runtime, request, check=require):
    """A seed belongs to one engine/build/parameter set and source request.

    No file, old project or former runtime directory supplies a missing identity.
    Coordinates are the request's initial source, not the evolving optimizer frame.
    """
    identity = runtime.get('engineIdentity')
    check(isinstance(identity, dict) and identity.get('schema') == 'sciyue-xtb-engine-identity/v1'
          and identity.get('engine') == 'xtb', 'xTB engine/build/parameter identity is required for binary seeds')
    payload = {key: value for key, value in identity.items() if key not in ('schema', 'engine', 'kind', 'sha256')}
    encode = lambda value: json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')
    for key in ('sha256', 'runtimeMemberDigest', 'parameterDigest'):
        check(isinstance(identity.get(key), str) and len(identity[key]) == 64
              and all(char in '0123456789abcdef' for char in identity[key]), 'Invalid xTB binary-seed identity')
    check(isinstance(identity.get('buildId'), str) and bool(identity['buildId'])
          and hashlib.sha256(encode(payload)).hexdigest() == identity['sha256'], 'xTB binary-seed identity changed')
    source = dict(engineIdentity=identity['sha256'], reportedVersion=runtime.get('version'), method=request['method'],
                  charge=request.get('charge'), uhf=request.get('uhf'), solvation=request.get('solvation'),
                  atoms=request['structure']['atoms'], cell=request['structure'].get('cell'))
    return hashlib.sha256(encode(source)).hexdigest()


def prepare_topology(directory, seed, seed_sha256, check=require):
    seeded = seed is not None
    if seeded:
        check(hashlib.sha256(seed).hexdigest() == seed_sha256, 'Owned GFN-FF seed changed')
        with (Path(directory) / 'gfnff_topo').open('xb') as handle:
            handle.write(seed)
    return seeded


def accept_topology(directory, output, seeded, seed, seed_sha256, check=require):
    # Upstream restart.f90 saves topology/neighbours, qa, xyze0, zetac6, qfrag
    # and force-field parameter arrays. gfnff_charges is output, not seed input.
    member = Path(directory) / 'gfnff_topo'
    check(member.is_file() and not member.is_symlink(), 'Native GFN-FF topology seed missing')
    info = member.lstat()
    check(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'Native GFN-FF topology is not an owned regular file')
    raw = member.read_bytes()
    check(0 < len(raw) <= 64*1024*1024, 'Native topology exceeds its seed budget')
    if seeded:
        check('GFN-FF topology read from file successfully!' in output and 'generating topology and atomic info file' not in output,
              'Native GFN-FF did not use the exact owned initial topology')
        check(raw == seed and hashlib.sha256(raw).hexdigest() == seed_sha256, 'Native GFN-FF initial topology changed')
        return seed, seed_sha256
    check(seed is None, 'GFN-FF attempted to reinitialize its potential')
    return raw, hashlib.sha256(raw).hexdigest()
