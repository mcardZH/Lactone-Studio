"""Owned single-process xTB MD/MTD for conformer-guess sampling.

This adapter does not own admission, task identity, defaults, or the IPC stream.
It never substitutes a native wall/distance potential for the ASE protections.
"""
from __future__ import annotations
import copy
from collections import deque
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

from ase import units
from conformer_gfnff import ordinary_directory, isolated_coordinate_input
from orbitals import _windows_owned_job
from xtb_periodic import BOHR_ANGSTROM

SOURCE_COMMIT = '5071a8869720fb0ecd788af977159869b64a277c'
# These path-independent identities are emitted by desktop/xtb-runtime.cjs
# after its descriptor anchor and complete binary/parameter inventory checks.
# Keep the original supported Windows bundle and the admitted GNU r2 bundle
# separate: sharing a version or main-source commit is not sufficient.
MD_ENGINE_IDENTITIES = (
    dict(schema='sciyue-xtb-engine-identity/v1', engine='xtb', kind='legacy-binary-observation',
         version='6.7.1pre', sourceCommit=SOURCE_COMMIT,
         buildId='legacy-manifest-5a570b48777807b09c9577f5def8d4fe4ae0caa55134c32b4f148342aa161cb5',
         compiler=None, toolchainArchiveSha256=None, sourceReceiptSha256=None, scientificPinsSha256=None,
         runtimeMemberDigest='40c0cc0cbd3aa64dee1ffa314f81d363664934526ec6d9ee0edebc8bbc23152a',
         parameterDigest='0393b0ab523fd1e193396d480c0b44f659e5350af421400e3b631335d870c0d2',
         sha256='2bef22d7ebb4e01f29abe55ad756fd39e2b59752d9424592d4f3924e0f7e38c2'),
    dict(schema='sciyue-xtb-engine-identity/v1', engine='xtb', kind='bundled-independent-rebuild',
         version='6.7.0', sourceCommit=SOURCE_COMMIT, buildId='5071a886-gnu132-r2-runtime-rebuild-a01',
         compiler=dict(name='gfortran', version='13.2.0'),
         toolchainArchiveSha256='87962f039c303764376b6a031edb7d4afab08abc89805c7055fa9dce5e764c9a',
         sourceReceiptSha256='d3afbb68638253d2a5ab8fbc9f86191d48120560269fd7ece37d887f686c3ef3',
         scientificPinsSha256='c74161d40083f5acb15ca57a7cbb9c337e21f85c866055c875c04aad63255f6b',
         runtimeMemberDigest='812a7296f44af4fd143a1a3e52f0b371cdbf4ee00661ebbfde6474f3d772f60a',
         parameterDigest='0233b838d5ec57437c70d65c26ba369d6ce6a5226f790912cdbbf3ebc6239ed2',
         sha256='6b2b2be41235f7c1f5b61f52c57b9284ea1d1fce08bdb6c70dae7b292c7ca42a'),
    dict(schema='sciyue-xtb-engine-identity/v1', engine='xtb', kind='bundled-independent-rebuild',
         version='6.7.0', sourceCommit=SOURCE_COMMIT, buildId='5071a886-gnu132-r2-openblas033-a01',
         compiler=dict(name='gfortran', version='13.2.0'),
         toolchainArchiveSha256='87962f039c303764376b6a031edb7d4afab08abc89805c7055fa9dce5e764c9a',
         sourceReceiptSha256='b8ce3a40717eb518ed78f16a7a0481e5af1b602e06cfe9ca4910e10c30fe6bc6',
         scientificPinsSha256='c74161d40083f5acb15ca57a7cbb9c337e21f85c866055c875c04aad63255f6b',
         runtimeMemberDigest='503ec84fc190195e442570e517a5034468c28e63257433624be51b5ef1fbb279',
         parameterDigest='0233b838d5ec57437c70d65c26ba369d6ce6a5226f790912cdbbf3ebc6239ed2',
         sha256='b40033dc620944f87e520d54d0a3cf69f7df73a9f82955d34dfa1a3464924a1c'),
)
ATOMIC_TIME_FS = .024188843265857
MAX_RAW_BYTES = 128 * 1024 * 1024
SHAKE_BOND_TOLERANCE_ANGSTROM = 1e-6
NUMBER = re.compile(r'[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][-+]?\d+)?\Z')
BAD_NATIVE = re.compile(r'MD is unstable|taking it as converged|ABNORMAL TERMINATION|FATAL ERROR|\[ERROR\]|'
                        r'FAILED TO CONVERGE|failed[^\n]*converg|not converg|convergence failure|'
                        r'Single point calculation terminated|GOOD AVERAGES REACHED|MAXIMUM RUN TIME EXCEEDED|'
                        r'EQUILIBRATION mode|GMD mode|GEOMETRY OPTIMIZATION|'
                        r'not recognized|unknown (?:option|keyword)', re.I)


class NativeMDError(ValueError):
    def __init__(self, message, code='SAMPLING_NATIVE_MD_FAILED'):
        super().__init__(message)
        self.code = code


def require(condition, message, code='SAMPLING_NATIVE_MD_INVALID'):
    if not condition:
        raise NativeMDError(message, code)


def admitted_md_engine_identity(runtime):
    require(isinstance(runtime, dict), 'Native MD requires a host-resolved runtime')
    identity = runtime.get('engineIdentity')
    require(isinstance(identity, dict) and any(
        runtime.get('version') == expected['version'] and identity == expected
        for expected in MD_ENGINE_IDENTITIES),
        'Native MD evaluation bound requires an admitted engine/build/parameter identity')
    return copy.deepcopy(identity)


def number(value):
    require(isinstance(value, str) and NUMBER.fullmatch(value), 'Malformed native MD number')
    result = float(value.replace('D', 'E').replace('d', 'e'))
    require(math.isfinite(result), 'Nonfinite native MD number')
    return result


def bounded_file(path, limit=None, allow_empty=False):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_nlink == 1
            and (allow_empty or info.st_size > 0) and (limit is None or info.st_size <= limit),
            'Native MD artifact is not an owned bounded regular file')
    return info


def exact_steps(duration, dt):
    require(type(duration) in (int, float) and type(dt) in (int, float)
            and math.isfinite(duration) and math.isfinite(dt) and duration > 0 and dt > 0,
            'Finite positive native MD time settings required')
    count = round(duration / dt)
    require(1 <= count <= 1000000 and abs(count * dt - duration) <= 1e-9,
            'Native MD duration must be an exact number of steps')
    return int(count)


def native_protection_settings(request):
    """Resolve native units and stable-ID targets; never translate ASE potentials.

    ``coordinateTransform.offsetAngstrom`` maps source -> native coordinates.
    Core K is effective-per-atom; xTB applies K/(n-1) to each selected pair.
    The sphere has a fixed 1 Eh polynomial scale, including inside the radius.
    """
    raw = request.get('nativeProtection')
    require(raw is None or isinstance(raw, dict) and set(raw) <= {'core', 'sphere'}, 'Invalid native protection fields')
    raw = raw or {}; atoms = request['structure']['atoms']; ids = {a['id']: i for i, a in enumerate(atoms)}
    result = dict(core=None, sphere=None, coordinateTransform=dict(kind='identity', offsetAngstrom=[0., 0., 0.]))
    if raw.get('core') is not None:
        core = raw['core']
        require(isinstance(core, dict) and set(core) == {'kind', 'atomIds', 'forceConstantEVPerAngstrom2'}
                and core['kind'] == 'pairwise-distance', 'Invalid native core definition')
        selected = core['atomIds']; strength = core['forceConstantEVPerAngstrom2']
        require(isinstance(selected, list) and len(selected) >= 2 and len(set(selected)) == len(selected)
                and all(i in ids for i in selected), 'Native relative-distance protection requires at least two distinct source atoms')
        require(type(strength) in (int, float) and math.isfinite(strength) and 1e-6 <= strength <= 6000,
                'Invalid native core force constant')
        indices = [ids[i] for i in selected]; pairs = []
        for i in range(len(indices)):
            for j in range(i):
                a, b = indices[i], indices[j]
                distance = math.dist([atoms[a][k] for k in ('x', 'y', 'z')], [atoms[b][k] for k in ('x', 'y', 'z')])
                require(math.isfinite(distance) and distance > 1e-8, 'Native core has a coincident source pair')
                pairs.append(dict(atomIds=[atoms[a]['id'], atoms[b]['id']], nativeAtomIndices=[a+1, b+1], referenceDistanceAngstrom=distance))
        result['core'] = dict(kind='pairwise-distance', atomIds=copy.deepcopy(selected), nativeAtomIndices=[i+1 for i in indices],
            forceConstantEVPerAngstrom2=strength, inputForceConstantHartreePerBohr2=strength*BOHR_ANGSTROM**2/units.Hartree,
            actualPairForceConstantEVPerAngstrom2=strength/(len(indices)-1),
            pairPotentialDefinition='E=K/(N-1)*sum((r-r0)^2)',
            pairSpringCurvatureEVPerAngstrom2=2*strength/(len(indices)-1), pairs=pairs)
    if raw.get('sphere') is not None:
        sphere = raw['sphere']
        require(isinstance(sphere, dict) and set(sphere) == {'kind', 'centerAngstrom', 'radiusAngstrom', 'exponent'}
                and sphere['kind'] == 'polynomial' and type(sphere['exponent']) is int and sphere['exponent'] == 30,
                'Invalid native polynomial sphere definition')
        center = sphere['centerAngstrom']; radius = sphere['radiusAngstrom']
        require(isinstance(center, list) and len(center) == 3 and all(type(v) in (int, float) and math.isfinite(v) and abs(v) <= 1e6 for v in center)
                and type(radius) in (int, float) and math.isfinite(radius) and .01 <= radius <= 1e6, 'Invalid native sphere geometry')
        result['sphere'] = dict(kind='polynomial', centerAngstrom=copy.deepcopy(center), radiusAngstrom=radius, exponent=30,
            nativeCenterBohr=[0., 0., 0.], nativeRadiusBohr=radius/BOHR_ANGSTROM, energyScaleHartree=1., appliesTo='all-atoms')
        result['coordinateTransform'] = dict(kind='translation', offsetAngstrom=[-v for v in center])
    return result


def settings(request):
    require(request.get('operation') in ('md', 'metadynamics') and request.get('method') in ('gfnff', 'gfn0', 'gfn1', 'gfn2'),
            'This native driver implements ordinary xTB MD only', 'SAMPLING_NATIVE_MD_UNSUPPORTED')
    require(not request.get('coreProtection') and not request.get('sphere') and not request.get('frozenAtomIds')
            and not request.get('constraints'), 'Native MD requires its explicit nativeProtection and does not support XYZ freezes', 'SAMPLING_NATIVE_MD_UNSUPPORTED')
    dt = request['dtFs']; md = dynamics_settings(request); count = exact_steps(md['durationFs'], dt)
    interval = exact_steps(md['sampleEveryFs'], dt)
    require(type(request['reportEvery']) is int and request['reportEvery'] > 0,
            'Invalid native MD output schedule')
    dump = math.gcd(interval, request['reportEvery'])
    from conformer_native_metadynamics import settings as mtd_settings
    metadynamics = mtd_settings(request, exact_steps, require)
    if metadynamics:
        dump = math.gcd(dump, metadynamics['depositSteps'])
    # SOURCE_COMMIT: src/prog/main.F90:687 initial SP;
    # src/dynamic.f90:398 pre-loop SP, :425 bounded loop, :439 one SP per step.
    # Counts are a conservative API-call upper bound, never an observed count.
    upper = count + 2
    require(type(request['maxEvaluations']) is int and request['maxEvaluations'] >= upper,
            'Native MD requires the source-proven steps+2 evaluation budget', 'SAMPLING_EVALUATION_LIMIT')
    require(count <= request['maxSteps'], 'Native MD exceeds the step budget', 'SAMPLING_STEP_LIMIT')
    expected = [i for i in range(1, count + 1) if i % interval == 0 or i % request['reportEvery'] == 0 or i == count]
    require(len(expected) <= request['maxFrames'], 'Native MD exceeds the retained-frame budget', 'SAMPLING_FRAME_LIMIT')
    atoms = request['structure']['atoms']
    raw_frames = (count + dump - 1) // dump
    shake = request.get('shakeHydrogenBonds', True)
    mass = request.get('hydrogenMassAmu')
    require(mass is None or (type(mass) in (int, float) and mass == 4 and request['method'] == 'gfnff'),
            'Only ordinary GFN-FF supports the explicit 4 amu hydrogen mass')
    mass = None if mass is None else 4
    require(type(shake) is bool and type(request['threads']) is int and 1 <= request['threads'] <= 2**53-1,
            'Explicit native MD SHAKE/thread settings required')
    # Locked main.F90 initializes xtb_gfnff_shake, but dynamic.f90 uses the
    # separate xtb_shake module. Its ncons stays zero for TGFFCalculator.
    require(not (request['method'] == 'gfnff' and shake),
            'Locked native GFN-FF MD cannot apply requested X-H SHAKE (upstream module mismatch)',
            'SAMPLING_NATIVE_MD_UNSUPPORTED')
    pairs = hydrogen_bond_references(request)
    if shake:
        # Generic native mode 1 chooses the nearest atom to each H, not the
        # supplied graph. Admit only when these are the exact requested pairs.
        nearest = set()
        for i, atom in enumerate(atoms):
            if atom['element'] == 'H':
                require(len(atoms) > 1, 'Native SHAKE requires a hydrogen partner')
                j = min((j for j in range(len(atoms)) if j != i),
                        key=lambda j: sum((atom[k]-atoms[j][k])**2 for k in ('x', 'y', 'z')))
                nearest.add(tuple(sorted((i, j))))
        require(nearest == {(p['a'], p['b']) for p in pairs},
                'Native nearest-H constraints differ from the source X-H bond graph', 'SAMPLING_NATIVE_MD_UNSUPPORTED')
    require(type(md['temperatureK']) in (int, float) and math.isfinite(md['temperatureK']) and 0 < md['temperatureK'] <= 5000,
            'Ordinary native MD requires a positive finite target temperature')
    require(request.get('solvation') is None or request['method'] in ('gfn1', 'gfn2'),
            'This native method has no supported implicit-solvent route', 'SAMPLING_NATIVE_MD_UNSUPPORTED')
    protection = native_protection_settings(request)
    # Actual resolved pair metadata is repeated per retained frame and terminal.
    # Bound that known serialization plus conservative atom/velocity/frame costs
    # before process creation, rather than relying on the host to kill mid-run.
    metadata_bytes = len(json.dumps(protection, allow_nan=False, separators=(',', ':')).encode('utf-8'))
    frame_bytes = metadata_bytes + len(atoms)*512 + 2048
    protocol_bytes = frame_bytes*(len(expected)+1) + 2*len(json.dumps(request, allow_nan=False).encode('utf-8'))
    if metadynamics:
        history_count = 1+(count-1)//metadynamics['depositSteps']
        protocol_bytes += 2*history_count*(len(metadynamics['atomIds'])*160+1024)
    return dict(steps=count, sampleInterval=interval, dumpSteps=dump, rawFrames=raw_frames,
                expectedSteps=expected, evaluationUpperBound=upper, shakeHydrogenBonds=shake,
                hydrogenBondReferences=pairs, expectedConstraintCount=len(pairs) if shake else 0,
                nativeProtection=protection, metadynamics=metadynamics, estimatedProtocolBytes=protocol_bytes,
                hydrogenMassAmu=mass, hydrogenMassMode='natural' if mass is None else 'fixed-amu')


def hydrogen_bond_references(request):
    atoms = request['structure']['atoms']; pairs = {}
    for bond in request['structure'].get('bonds', []):
        a, b = sorted((bond['a'], bond['b']))
        if atoms[a]['element'] == 'H' or atoms[b]['element'] == 'H':
            length = math.dist([atoms[a][k] for k in ('x', 'y', 'z')], [atoms[b][k] for k in ('x', 'y', 'z')])
            require(math.isfinite(length) and length > 1e-8, 'Invalid source X-H constraint length')
            pairs[a, b] = dict(a=a, b=b, atomIds=[atoms[a]['id'], atoms[b]['id']], lengthAngstrom=length)
    return list(pairs.values())


def dynamics_settings(request):
    return request['metadynamics'] if request['operation'] == 'metadynamics' else request['molecularMD']


def control_input(request, configuration):
    calc = request['calculator']; md = dynamics_settings(request)
    text = ('$md\n temp=' + format(md['temperatureK'], '.17g') + '\n time=' + format(md['durationFs'] / 1000, '.17g')
            + '\n step=' + format(request['dtFs'], '.17g') + '\n dump='
            + format(configuration['dumpSteps'] * request['dtFs'], '.17g')
            + '\n hmass=' + str(configuration['hydrogenMassAmu'] or 0) + '\n shake=' + ('1' if configuration['shakeHydrogenBonds'] else '0')
            + ('\n sdump=' + format(configuration['metadynamics']['scoordFs'], '.17g') if configuration.get('metadynamics') else '')
            + '\n nvt=true\n restart=false\n velo=true\n sccacc=' + format(calc['accuracy'], '.17g')
            + '\n$end\n$scc\n maxiterations=' + str(calc['maxIterations'])
            + '\n temp=' + format(calc['electronicTemperatureK'], '.17g') + '\n$end\n')
    protection = configuration['nativeProtection']
    if protection['core']:
        core = protection['core']
        text += ('$constrain\n force constant=' + format(core['inputForceConstantHartreePerBohr2'], '.17g')
                 + '\n atoms: ' + ','.join(str(i) for i in core['nativeAtomIndices']) + '\n$end\n')
    if protection['sphere']:
        text += ('$wall\n potential=polynomial\n alpha=30\n center=zero\n sphere: '
                 + format(protection['sphere']['nativeRadiusBohr'], '.17g') + ',all\n$end\n')
    from conformer_native_metadynamics import control
    return text + control(configuration)


def native_arguments(request, runtime):
    method = request['method']
    args = [runtime['executable'], 'input.coord']
    if method == 'gfnff':
        require(request['uhf'] == 0, 'GFN-FF has no spin Hamiltonian')
        args += ['--gfnff']
    else:
        args += ['--gfn', method[-1], '--uhf', str(request['uhf'])]
    args += ['--md', '--input', 'md.inp', '--chrg', str(request['charge']), '--acc', str(request['calculator']['accuracy']),
             '--etemp', str(request['calculator']['electronicTemperatureK']), '--parallel', str(request['threads']), '--norestart']
    if (request.get('nativeProtection') or {}).get('core'):
        # Locked main.F90 prints pot_info (actual pair inventory/per-pair fc)
        # only under set%verbose. This enables evidence, not another method.
        args += ['--verbose']
    if request.get('solvation'):
        sol = request['solvation']
        require(sol.get('model') in ('alpb', 'gbsa') and isinstance(sol.get('solvent'), str)
                and re.fullmatch(r'[a-z0-9-]{1,40}', sol['solvent']), 'Invalid native MD solvent identity')
        args += ['--' + sol['model'], sol['solvent']]
    return args


class NativeProgressReader:
    """Count complete native records without constructing coordinates or velocities.

    These are observed writer counts, not accepted geometries. Full scientific
    validation belongs to the single terminal read after the child has closed.
    """
    def __init__(self, atom_count, configuration):
        self.record_lines = 2 + 2 * atom_count
        self.configuration = configuration
        self.offset = self.lines = 0
        self.identity = None
        self.last_step = -1

    def drain(self, path):
        if not path.exists():
            return None
        info = bounded_file(path, allow_empty=True); identity = (info.st_dev, info.st_ino)
        require(self.identity is None or self.identity == identity, 'Native trajectory file identity changed')
        require(info.st_size >= self.offset, 'Native trajectory was truncated during sampling')
        self.identity = identity
        with path.open('rb') as stream:
            stream.seek(self.offset)
            while block := stream.read(64 * 1024):
                self.offset += len(block); self.lines += block.count(b'\n')
        records = self.lines // self.record_lines
        require(records <= self.configuration['rawFrames'], 'Native MD produced unexpected extra raw records')
        if records == 0:
            return None
        step = (records - 1) * self.configuration['dumpSteps']
        if step <= self.last_step:
            return None
        self.last_step = step
        retained = [s for s in self.configuration['expectedSteps'] if s <= step]
        return dict(kind='progress', step=step, phase='native-md', frameCount=len(retained),
                    candidateCount=sum(s % self.configuration['sampleInterval'] == 0 for s in retained))


class TrajectoryReader:
    """Parse only complete xyz+velocity records; preserve partial bytes until EOF."""
    def __init__(self, atoms, dump_steps, total_steps):
        self.atoms = atoms; self.dump_steps = dump_steps; self.total_steps = total_steps
        self.pending = b''; self.offset = 0; self.raw_index = 0; self.identity = None
        self.lines = deque()

    def drain(self, path, *, final=False):
        return list(self.iter_drain(path, final=final))

    def iter_drain(self, path, *, final=False):
        """Deliver each validated record before inspecting a possibly bad tail."""
        if not path.exists():
            require(not final, 'Native MD trajectory is missing')
            return
        info = bounded_file(path, allow_empty=True); identity = (info.st_dev, info.st_ino)
        require(self.identity is None or self.identity == identity, 'Native trajectory file identity changed')
        self.identity = identity
        require(info.st_size >= self.offset, 'Native trajectory was truncated during sampling')
        with path.open('rb') as stream:
            stream.seek(self.offset)
            while block := stream.read(64 * 1024):
                self.offset += len(block); self.pending += block
                complete = self.pending.split(b'\n'); self.pending = complete.pop()
                self.lines.extend(row.rstrip(b'\r') for row in complete)
                n = len(self.atoms)
                while True:
                    needed = 2 + 2 * n
                    if len(self.lines) < needed:
                        break
                    record = [self.lines.popleft() for _ in range(needed)]
                    require(record[0].strip().isdigit() and int(record[0]) == n, 'Native trajectory atom count changed')
                    comment = record[1].decode('ascii')
                    match = re.search(r'energy:\s*(' + NUMBER.pattern[:-2] + r')', comment, re.I)
                    require(match is not None, 'Native trajectory has no energy field')
                    energy = number(match.group(1)); coordinates = []; velocities = []
                    for atom, row in zip(self.atoms, record[2:2+n]):
                        fields = row.decode('ascii').split()
                        require(len(fields) == 4 and fields[0].lower() == atom['element'].lower(), 'Native MD element/order changed')
                        coordinates.append([number(v) for v in fields[1:]])
                    for row in record[2+n:]:
                        fields = row.decode('ascii').split(); require(len(fields) == 3, 'Incomplete native velocity row')
                        velocities.append([number(v) * BOHR_ANGSTROM / ATOMIC_TIME_FS for v in fields])
                    step = self.raw_index * self.dump_steps
                    require(step < self.total_steps, 'Native MD produced an unexpected extra raw frame')
                    value = dict(rawIndex=self.raw_index, step=step, energyHartree=energy,
                                 coordinates=coordinates, velocities=velocities)
                    self.raw_index += 1
                    yield value
        if final:
            require(not self.pending.strip() and not self.lines, 'Native MD ended with an incomplete raw frame')


def restart_frame(path, atom_count):
    bounded_file(path)
    rows = path.read_text(encoding='ascii').splitlines()
    require(len(rows) == atom_count + 1 and number(rows[0].strip()) == -1, 'Incomplete final MD restart')
    coordinates = []; velocities = []
    for row in rows[1:]:
        fields = row.split(); require(len(fields) == 6, 'Malformed final native MD restart')
        values = [number(v) for v in fields]
        coordinates.append([v * BOHR_ANGSTROM for v in values[:3]])
        velocities.append([v * BOHR_ANGSTROM / ATOMIC_TIME_FS for v in values[3:]])
    return dict(coordinates=coordinates, velocities=velocities)


def temperature_observations(output, request, configuration):
    """Read the sparse native observations without inventing a frame temperature.

    Locked dynamic.f90:487-495 writes before the current integration step.
    For printed nstep=N>0, T/Ekin are from the previous iteration's centred
    velocity (559-566), at the *coordinate* step N-1.  The trajectory instead
    contains half-step velocities after SHAKE and rmrottr (576-582).  Neither
    the initial T=0 sentinel nor the final average is a frame observation.
    """
    # A killed writer can end halfway through a numeric row; retain only the
    # newline-terminated prefix even when its last token looks like a number.
    output = output[:output.rfind('\n')+1]
    heading = re.search(r'^\s*time \(ps\)\s+<Epot>\s+Ekin\s+<T>\s+T\s+Etot\s*$', output, re.M)
    if heading is None:
        return []
    body = output[heading.end():].split('average properties', 1)[0]
    observations = []
    seen = set()
    for line in body.splitlines():
        fields = line.split()
        if len(fields) != 7 or not fields[0].isdigit() or not all(NUMBER.fullmatch(v) for v in fields[1:]):
            continue
        printed_step = int(fields[0])
        if printed_step == 0:
            continue
        require(printed_step % 200 == 0 and printed_step < configuration['steps'] and printed_step not in seen,
                'Native temperature observation has an invalid or duplicate step')
        values = [number(v) for v in fields[1:]]
        require(abs(values[0] - printed_step * request['dtFs'] / 1000) <= .00500001,
                'Native temperature observation time does not match its printed step')
        require(values[2] >= 0 and values[4] >= 0,
                'Native temperature observation contains negative kinetic energy or temperature')
        seen.add(printed_step)
        observations.append(dict(step=printed_step-1, timeFs=(printed_step-1)*request['dtFs'],
            printedAtStep=printed_step, temperatureK=values[4], kineticEnergyEV=values[2]*units.Hartree,
            sourceArtifact='stdout.txt', sourceCommit=SOURCE_COMMIT,
            velocityPhase='centred-before-SHAKE-and-rmrottr',
            temperatureResolutionK=1., kineticEnergyResolutionHartree=.0001))
    return observations


def validate_header(output, request, configuration, version):
    match = re.search(r'\bxtb version\s+(\d+\.\d+\.\d+(?:pre)?)', output, re.I)
    require(match is not None and match.group(1) == version, 'Native MD version does not match its host runtime')
    headings = [re.sub(r'\s+', '', title).upper() for title in re.findall(r'^\s*\|\s*([^|\r\n]+?)\s*\|\s*$', output, re.M)]
    methods = [title for title in headings if re.fullmatch(r'GFN(?:\d+-XTB|-FF)', title)]
    expected = 'GFN-FF' if request['method'] == 'gfnff' else 'GFN' + request['method'][-1] + '-XTB'
    require(methods and all(title == expected for title in methods), 'Native MD actual method heading differs')
    def read(label):
        found = re.search(label + r'\s*:\s*([-+\d.eEdD]+)', output, re.M)
        require(found is not None, 'Native MD effective parameter is missing: ' + label)
        return number(found.group(1))
    require(read('max steps') == configuration['steps'], 'Native MD effective step count differs')
    require(abs(read('dt /fs') - request['dtFs']) <= .00500001, 'Native MD effective timestep differs')
    require(abs(read('MD time /ps') - dynamics_settings(request)['durationFs'] / 1000) <= .00500001, 'Native MD effective duration differs')
    require(abs(read('temperature /K') - dynamics_settings(request)['temperatureK']) <= .00500001, 'Native MD effective temperature differs')
    require(abs(read('SCC accuracy') - request['calculator']['accuracy']) <= .00500001, 'Native MD effective SCC accuracy differs')
    require(re.search(r'dumpstep\(trj\) /fs\s*:\s*[-+\d.]+\s+' + str(configuration['dumpSteps']) + r'\b', output), 'Native output interval differs')
    if configuration['shakeHydrogenBonds']:
        actual = re.search(r'SHAKE on\. # bonds\s*:\s*(\d+)\s+all:\s*F\b', output)
        require(actual is not None and int(actual.group(1)) == configuration['expectedConstraintCount'],
                'Native X-H-only SHAKE actual constraint count differs from the source bond graph')
        count = int(actual.group(1))
    else:
        require('SHAKE off' in output and 'SHAKE on' not in output, 'Native SHAKE-off setting did not take effect')
        count = 0
    require('Berendsen THERMOSTAT on' in output, 'Native thermostat setting differs')
    meta = configuration.get('metadynamics')
    if meta:
        require('--- metadynamics parameter ---' in output and read('update') == meta['maxHistory']
                and abs(read('kpush')-meta['factorHartree']) <= .00050001
                and abs(read('alpha')-meta['alphaInverseBohr2']) <= .00050001
                and read('number of input RMSDs') == 1, 'Native MTD effective bias parameters differ')
    else:
        require('--- metadynamics parameter ---' not in output, 'Unexpected native MTD bias')
    # Locked dynamic.f90 assigns md_hmass * amutoau directly to every hydrogen;
    # the neighbouring-heavy-atom mass correction is commented out (no HMR).
    printed_mass = re.findall(r'H atoms mass \(amu\)\s*:\s*([-+\d.eEdD]+)', output)
    if configuration['hydrogenMassAmu'] is None:
        require(not printed_mass, 'Native natural hydrogen mass setting differs')
    else:
        require(len(printed_mass) == 1 and number(printed_mass[0]) == configuration['hydrogenMassAmu'],
                'Native actual hydrogen mass does not match requested 4 amu')
    protection = configuration['nativeProtection']
    if protection['core']:
        core = protection['core']
        require(re.search(r'applying\s+' + str(len(core['pairs'])) + r'\s+atom pairwise harmonic potentials', output),
                'Native core pair inventory was not confirmed')
        applied = read(r'applied force constant per pair')
        expected_fc = core['inputForceConstantHartreePerBohr2']/(len(core['atomIds'])-1)
        require(abs(applied-expected_fc) <= 5.1e-8, 'Native core effective pair force constant differs')
    if protection['sphere']:
        radius = re.search(r'spherical wallpotential with radius\s+([-+\d.eEdD]+)', output)
        requested = protection['sphere']['radiusAngstrom']
        require(radius is not None and abs(number(radius.group(1))-requested) <= .02 + 2*math.ulp(requested),
                'Native sphere effective radius was not confirmed')
    return dict(enabled=configuration['shakeHydrogenBonds'], actualConstraintCount=count,
                hydrogenBondCount=len(configuration['hydrogenBondReferences']), algorithm='native-xTB-SHAKE',
                reference='input-geometry', maxBondResidualAngstrom=0.)


def validate_completion_output(output, errors, request, configuration, version):
    """Keep fatal/early-exit rejection separate from xTB's final mean-T warning.

    Locked dynamic.f90:645-653 prints this nonfatal diagnostic after the loop,
    then still writes the final restart and success marker. Full raw/restart
    inventory and frame validation remain mandatory in NativeMDSession.run.
    """
    require('normal termination of xtb' in errors.lower() and 'normal exit of md()' in output
            and not BAD_NATIVE.search(output+'\n'+errors), 'Native MD failed or terminated before its requested trajectory')
    validate_header(output, request, configuration, version)
    warnings = re.findall(r'^\s*thermostating problem\s*$', output, re.M)
    if not warnings:
        return None
    averages = re.findall(r'^\s*T\s*:\s*([-+\d.eEdD]+)\s*$', output, re.M)
    # dynamic.f90 tests the Fortran DO variable k after normal exhaustion:
    # k is requested_steps + 1, so k > 500 also permits exactly 500 steps.
    require(len(warnings) == 1 and len(averages) == 1 and 'average properties' in output
            and configuration['steps'] >= 500, 'Native temperature warning lacks its final average or valid step count')
    average = number(averages[0]); target = dynamics_settings(request)['temperatureK']
    require(0 < average <= 10000 and target > 0, 'Native temperature warning contains invalid temperatures')
    relative = (average-target)/target
    require(abs(relative) > .02, 'Native temperature warning conflicts with its actual average')
    return dict(kind='average-temperature-deviation', message='thermostating problem',
                targetTemperatureK=target, averageTemperatureK=average, relativeDeviation=relative)


class NativeMDSession:
    def __init__(self, request, context, *, process_factory=subprocess.Popen, job_factory=_windows_owned_job,
                 clock=time.monotonic, sleep=time.sleep):
        self.request = copy.deepcopy(request); self.configuration = settings(self.request)
        require(isinstance(context, dict) and all(k in context for k in ('runtime', 'workspacePath', 'emit', 'check', 'cancelled')),
                'Host-owned native MD context is required')
        self.runtime = context['runtime']
        self.runtime_identity = admitted_md_engine_identity(self.runtime)
        for key in ('executable', 'directory', 'dataDirectory'):
            require(isinstance(self.runtime.get(key), str) and Path(self.runtime[key]).is_absolute(), 'Native MD runtime paths must be host-resolved')
        require(Path(self.runtime['executable']).name.lower() in ('xtb', 'xtb.exe'), 'Invalid native MD executable')
        self.workspace = ordinary_directory(context['workspacePath']); self.emit = context['emit']
        self.external_check = context['check']; self.cancelled = context['cancelled']
        self.memory = context.get('memoryBudgetBytes')
        require(self.memory is None or type(self.memory) is int and self.memory > 0, 'Invalid granted native MD memory budget')
        self.process_factory = process_factory; self.job_factory = job_factory; self.clock = clock; self.sleep = sleep
        self.current = None; self.last_frame = None; self.frame_count = self.candidate_count = 0
        self.started = None; self.header_confirmed = False
        self.effective_shake = None
        self.bias_history = []
        self.native_temperature_observations = []

    def check(self):
        self.external_check()
        if self.cancelled.is_set():
            raise NativeMDError('Sampling stopped; complete native frames remain separate', 'SAMPLING_CANCELLED')
        if self.started is not None:
            limit = self.request.get('maxWallTimeSeconds')
            require(limit is None or self.clock() - self.started <= limit, 'Native MD walltime budget exhausted', 'SAMPLING_WALLTIME')

    def native_closed(self):
        return self.current is None or self.current.poll() is not None

    def _frame(self, raw, source, final=False):
        step = self.configuration['steps'] if final else raw['step']
        require(self.effective_shake is not None, 'Native effective SHAKE header is not confirmed')
        observed = [math.dist(raw['coordinates'][p['a']], raw['coordinates'][p['b']])
                    for p in self.configuration['hydrogenBondReferences']]
        residual = max([abs(length-p['lengthAngstrom']) for length, p in
                        zip(observed, self.configuration['hydrogenBondReferences'])] or [0.])
        require(math.isfinite(residual), 'Native X-H distance is nonfinite')
        if self.configuration['shakeHydrogenBonds']:
            require(residual <= SHAKE_BOND_TOLERANCE_ANGSTROM,
                    'Native requested X-H SHAKE did not preserve source bond lengths')
        candidate = final or step % self.configuration['sampleInterval'] == 0
        protection = self.configuration['nativeProtection']; transform = protection['coordinateTransform']
        source_points = [[v-offset for v, offset in zip(point, transform['offsetAngstrom'])] for point in raw['coordinates']]
        atoms = copy.deepcopy(self.request['structure']['atoms'])
        for atom, point in zip(atoms, source_points):
            require(all(math.isfinite(v) and abs(v) <= 1e6 for v in point), 'Nonfinite or unbounded native MD geometry')
            atom.update(zip(('x', 'y', 'z'), point))
        energy = None if final else raw['energyHartree'] * units.Hartree
        meta = self.configuration.get('metadynamics')
        if meta and not final and step > 0 and step % meta['depositSteps'] == 0:
            from conformer_native_metadynamics import entry
            history = entry(self.configuration, atoms, source_points, step, len(self.bias_history), self.request['dtFs'])
            self.bias_history.append(history)
            self.emit(dict(kind='bias', stageId='metadynamics', historyEntry=history))
        if not final and (step == 0 or step not in self.configuration['expectedSteps']):
            return
        # Cancellation stops the native process, not delivery of its complete
        # buffered prefix. The polling loop owns cancellation/deadline checks;
        # each already parsed frame still passes all geometry/output bounds.
        require(self.frame_count < self.request['maxFrames'], 'Native MD retained-frame limit', 'SAMPLING_FRAME_LIMIT')
        has_protection = bool(protection['core'] or protection['sphere'] or meta)
        penetration = 0.
        if protection['sphere']:
            sphere = protection['sphere']
            penetration = max([max(0., math.dist(p, sphere['centerAngstrom'])-sphere['radiusAngstrom']) for p in source_points] or [0.])
        core_residual = 0.
        core_diagnostics = None
        if protection['core']:
            core_residual = max(abs(math.dist(source_points[p['nativeAtomIndices'][0]-1], source_points[p['nativeAtomIndices'][1]-1])
                                    -p['referenceDistanceAngstrom']) for p in protection['core']['pairs'])
            from conformer_sampling import core_diagnostic
            indices = [i-1 for i in protection['core']['nativeAtomIndices']]
            reference = [[self.request['structure']['atoms'][i][k] for k in ('x','y','z')] for i in indices]
            _, core_diagnostics = core_diagnostic([source_points[i] for i in indices], reference)
        value = dict(kind='frame', driver='native-xtb-md', stageId=self.request['operation'],
            collectionId='sampled-candidates' if candidate else 'sampling-trajectory', frameIndex=self.frame_count,
            role='sampled-candidate' if candidate else 'trajectory', step=step, timeFs=step*self.request['dtFs'],
            coordinates=atoms, velocitiesAngstromPerFs=raw['velocities'], physicalEnergyEV=None if has_protection else energy, sampledPotentialEV=energy,
            coreBiasEV=None if protection['core'] else 0., metaBiasEV=None if meta else 0., sphereBiasEV=None if protection['sphere'] else 0., kineticEnergyEV=None, temperatureK=None,
            targetTemperatureK=dynamics_settings(self.request)['temperatureK'], biasHistoryCount=len(self.bias_history),
            diagnostics=dict(maxWallPenetrationAngstrom=penetration, nativeCoreMaxPairResidualAngstrom=core_residual,
                **({'core': core_diagnostics} if core_diagnostics is not None else {}), shake={**self.effective_shake,
                'maxBondResidualAngstrom': residual, 'observedBondLengthsAngstrom': observed}),
            requiresUnbiasedOptimization=candidate, optimizationPerformed=False,
            nativeMD=dict(method=self.request['method'], version=self.runtime['version'], inputSha256=self.input_sha,
                shakeHydrogenBonds=self.configuration['shakeHydrogenBonds'],
                hydrogenMassAmu=self.configuration['hydrogenMassAmu'], hydrogenMassMode=self.configuration['hydrogenMassMode'],
                **({'hydrogenMassScaling': 1} if self.configuration['hydrogenMassAmu'] is None else {}),
                nativeProtection=copy.deepcopy(protection),
                **({'metadynamics': copy.deepcopy(meta)} if meta else {}),
                energyDefinition='native-total-including-sampling-potentials' if has_protection else 'native-physical-potential',
                sourceArtifact=source, rawIndex=raw.get('rawIndex', 0), frameTiming='restart-final' if final else 'pre-step',
                velocityPhase='restart' if final else 'half-step', nativeClosed=self.current is None),
            units=dict(coordinates='angstrom', velocity='angstrom/fs', energy='eV', time='fs', temperature='K'))
        self.frame_count += 1; self.candidate_count += int(candidate); self.last_frame = copy.deepcopy(value); self.emit(value)

    def _drain(self, reader, directory, final=False):
        if not self.header_confirmed:
            output = (directory/'stdout.txt').read_text(encoding='utf-8', errors='replace')
            if 'Berendsen THERMOSTAT on' not in output:
                require(not final, 'Native MD effective header was not received')
                return
            self.effective_shake = validate_header(output, self.request, self.configuration, self.runtime['version']); self.header_confirmed = True
        for raw in reader.iter_drain(directory/'xtb.trj', final=final):
            if raw['rawIndex'] == 0:
                offset = self.configuration['nativeProtection']['coordinateTransform']['offsetAngstrom']
                expected = [[a[k]+offset[i] for i, k in enumerate(('x', 'y', 'z'))] for a in self.request['structure']['atoms']]
                require(max(abs(v-w) for p, q in zip(raw['coordinates'], expected) for v, w in zip(p, q)) <= 5e-6,
                        'Native MD initial raw frame was transformed or belongs to another input')
            self._frame(raw, 'xtb.trj')

    def run(self):
        self.check(); self.started = self.clock(); directory = self.workspace/'native-md'; directory.mkdir(); ordinary_directory(directory)
        transform = self.configuration['nativeProtection']['coordinateTransform']
        text = isolated_coordinate_input(self.request['structure']['atoms'],
            [[(a[k]+transform['offsetAngstrom'][i])/BOHR_ANGSTROM for i, k in enumerate(('x', 'y', 'z'))] for a in self.request['structure']['atoms']])
        control = control_input(self.request, self.configuration); self.input_sha = hashlib.sha256(text.encode('ascii')).hexdigest()
        for name, content in [('input.coord', text), ('md.inp', control), ('request.json', json.dumps(self.request, allow_nan=False))]:
            with (directory/name).open('x', encoding='utf-8', newline='\n') as handle: handle.write(content)
        if self.configuration.get('metadynamics'):
            from conformer_native_metadynamics import reference_xyz, entry
            reference_text = reference_xyz(self.request['structure']['atoms'], transform['offsetAngstrom'])
            with (directory/'mtd-reference.xyz').open('x', encoding='ascii', newline='\n') as handle:
                handle.write(reference_text)
            history = entry(self.configuration, self.request['structure']['atoms'],
                [[a[k] for k in ('x','y','z')] for a in self.request['structure']['atoms']], 0, 0, self.request['dtFs'])
            self.bias_history.append(history)
            self.emit(dict(kind='bias', stageId='metadynamics', historyEntry=history))
        argv = native_arguments(self.request, self.runtime)
        env = {k: v for k, v in os.environ.items() if k.upper() in ('SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE')}
        env.update(PATH=self.runtime['directory'], XTBPATH=self.runtime['dataDirectory'], HOME=str(directory), USERPROFILE=str(directory),
            TEMP=str(directory), TMP=str(directory), LANG='C', LC_ALL='C', OMP_NUM_THREADS=str(self.request['threads']), OMP_MAX_ACTIVE_LEVELS='1',
            OMP_DYNAMIC='FALSE', MKL_NUM_THREADS=str(self.request['threads']), OPENBLAS_NUM_THREADS=str(self.request['threads']))
        record = dict(driver='native-xtb-md', argv=argv, environment=env, inputSha256=self.input_sha,
            controlSha256=hashlib.sha256(control.encode('ascii')).hexdigest(), requestedSettings=self.configuration,
            evaluationBudget=dict(upperBound=self.configuration['evaluationUpperBound'], observed=None, sourceCommit=SOURCE_COMMIT,
                engineIdentity=copy.deepcopy(self.runtime_identity),
                source='prog/main.F90 initial SP + dynamic.f90 pre-loop SP + bounded one-SP-per-step loop'),
            requestedSeed=self.request['seed'], nativeEffectiveSeed=None, seedTreatment='native-internal-initialization',
            memoryBudgetBytes=self.memory, memoryHardLimitApplied=False, pid=None, closed=False)
        reader = TrajectoryReader(self.request['structure']['atoms'], self.configuration['dumpSteps'], self.configuration['steps'])
        progress_reader = NativeProgressReader(len(self.request['structure']['atoms']), self.configuration)
        process = job = None; native_announced = False; observation_error = None
        self.emit(dict(kind='stage', stageId='sampling', status='started', step=0, configuration=copy.deepcopy(self.request),
            integration=dict(driver='native-xtb-md', dtFs=self.request['dtFs'], shakeHydrogenBonds=self.configuration['shakeHydrogenBonds'], thermostat='Berendsen',
                hydrogenMassAmu=self.configuration['hydrogenMassAmu'], hydrogenMassMode=self.configuration['hydrogenMassMode'],
                seedTreatment='native-internal-initialization', requestedSeed=self.request['seed'], effectiveSeed=None,
                frictionTreatment='not-applicable-native-Berendsen'),
            coordinateTransform=copy.deepcopy(transform)))
        try:
            with (directory/'stdout.txt').open('xb') as stdout, (directory/'stderr.txt').open('xb') as stderr:
                try:
                    process = self.current = self.process_factory(argv, cwd=directory, env=env, stdin=subprocess.DEVNULL,
                        stdout=stdout, stderr=stderr, shell=False, creationflags=0x08000000 if os.name == 'nt' else 0)
                    record['pid'] = process.pid
                    job = self.job_factory(process, memory_limit=self.memory)
                    record['memoryHardLimitApplied'] = bool(job and self.memory and os.name == 'nt')
                    self.emit(dict(kind='native-started', pid=process.pid)); native_announced = True
                    while process.poll() is None:
                        self.check()
                        for name in ('stdout.txt', 'stderr.txt'):
                            bounded_file(directory/name, allow_empty=True)
                        progress = progress_reader.drain(directory/'xtb.trj')
                        if progress is not None: self.emit(progress)
                        self.sleep(.05)
                finally:
                    if process is not None:
                        if process.poll() is None: process.kill()
                        try: process.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            if job: job[0].CloseHandle(job[1]); job = None
                            process.wait(timeout=2)
                        record.update(code=process.returncode, closed=process.poll() is not None)
                        if record['closed']:
                            if native_announced: self.emit(dict(kind='native-closed', pid=process.pid, code=process.returncode))
                            self.current = None
                    if job: job[0].CloseHandle(job[1]); job = None
        finally:
            # Stop/error and success all prepare their complete valid prefix
            # only after the owned native writer has really ended. A partial
            # killed tail is ignored here and strictly checked on success below.
            active_error = sys.exc_info()[0] is not None
            prefix_error = None
            if process is not None and native_announced and self.native_closed():
                try: self._drain(reader, directory)
                except Exception as exc: prefix_error = exc
            # The final read is independent of stdout buffering during polling.
            # Keep observations available to the outer error/cancelled terminal,
            # but never mask its original exception with optional parsing work.
            try:
                bounded_file(directory/'stdout.txt', allow_empty=True)
                output = (directory/'stdout.txt').read_text(encoding='utf-8', errors='replace')
                self.native_temperature_observations = temperature_observations(output, self.request, self.configuration)
            except (NativeMDError, OSError) as exc:
                observation_error = exc
            record.update(elapsedSeconds=self.clock()-self.started, frameCount=self.frame_count,
                          nativeTemperatureObservations=copy.deepcopy(self.native_temperature_observations),
                          **({'temperatureObservationError': str(observation_error)} if observation_error else {}),
                          **({'terminalPrefixError': str(prefix_error)} if prefix_error else {}),
                          verifiedHydrogenMass=dict(amu=self.configuration['hydrogenMassAmu'],
                              mode=self.configuration['hydrogenMassMode']) if self.header_confirmed else None)
            with (directory/'process.json').open('x', encoding='utf-8') as stream: json.dump(record, stream, allow_nan=False)
            if prefix_error is not None and not active_error:
                raise prefix_error
        if observation_error is not None:
            raise observation_error
        self.check(); require(process is not None and process.returncode == 0 and record['closed'], 'Native MD process did not close successfully')
        bounded_file(directory/'stdout.txt', allow_empty=True)
        bounded_file(directory/'stderr.txt', allow_empty=True)
        output = (directory/'stdout.txt').read_text(encoding='utf-8', errors='replace')
        errors = (directory/'stderr.txt').read_text(encoding='utf-8', errors='replace')
        thermostat_warning = validate_completion_output(output, errors, self.request, self.configuration, self.runtime['version'])
        self._drain(reader, directory, final=True)
        require(reader.raw_index == self.configuration['rawFrames'], 'Native MD raw frame inventory is incomplete')
        if self.configuration.get('metadynamics'):
            require(output.count('adding snapshot to metadynamics bias') == len(self.bias_history)-1,
                    'Native MTD observed deposition count differs from complete raw history')
        require((directory/'input.coord').read_text(encoding='ascii') == text and (directory/'md.inp').read_text(encoding='ascii') == control,
                'Native MD inputs changed')
        if self.configuration.get('metadynamics'):
            require((directory/'mtd-reference.xyz').read_text(encoding='ascii') == reference_text,
                    'Native MTD initial reference changed')
        bounded_file(directory/'xtbmdok', 1024, allow_empty=True)
        final = restart_frame(directory/'mdrestart', len(self.request['structure']['atoms'])); final['rawIndex'] = 0
        self._frame(final, 'mdrestart', final=True)
        require(self.frame_count == len(self.configuration['expectedSteps']), 'Native MD retained frame schedule is incomplete')
        if self.request['method'] == 'gfnff':
            bounded_file(directory/'gfnff_topo')
        self.emit(dict(kind='progress', step=self.configuration['steps'], phase='native-md',
                       frameCount=self.frame_count, candidateCount=self.candidate_count))
        self.emit(dict(kind='stage', stageId='sampling', status='completed', step=self.configuration['steps'], candidates=self.candidate_count))
        return dict(kind='completed', driver='native-xtb-md', workerSettled=True, samplingCompleted=True,
            optimizationPerformed=False, requiresUnbiasedOptimization=True, candidateCount=self.candidate_count, frameCount=self.frame_count,
            step=self.configuration['steps'], evaluations=None, evaluationCountSource='not-reported-native-md',
            budgetEvaluationUpperBound=self.configuration['evaluationUpperBound'],
            seed=self.request['seed'], lastFrame=self.last_frame, biasHistory=copy.deepcopy(self.bias_history),
            nativeTemperatureObservations=copy.deepcopy(self.native_temperature_observations),
            **({'thermostatWarning': thermostat_warning} if thermostat_warning is not None else {}),
            postSamplingPotentials=dict(core=False, metadynamics=False, sphere=False), nativeClosed=self.native_closed())
