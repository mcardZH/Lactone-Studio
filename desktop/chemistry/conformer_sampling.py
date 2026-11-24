"""Owned molecular MD and native RMSD-metadynamics sampling."""
from __future__ import annotations
from contextlib import ExitStack
import copy
import json
import math
import os
from pathlib import Path
import re
import sys
import threading
import time

import numpy as np
from ase.data import atomic_numbers
from native_stdin import control_blocks, route_native_output
from conformer_solvation import CAPABILITY, native_alpb_supported

METHODS = tuple(CAPABILITY['methodDefinitions'])
OPERATIONS = ('md', 'metadynamics')
DEFAULTS = dict(threads=2, maxSteps=100000, maxEvaluations=200001,
                maxFrames=2000, seed=731,
                dtFs=2, frictionPerFs=.01, reportEvery=20, shakeHydrogenBonds=True)
ANNEAL_DEFAULTS = dict(lowTemperatureK=0, highTemperatureK=600, cycleDurationFs=10000, cycles=5)
META_DEFAULTS = dict(temperatureK=300, durationFs=50000, sampleEveryFs=100,
                    depositEveryFs=100, heightEV=.01, sigmaAngstrom=.5, maxHistory=1000)
SPHERE_DEFAULTS = dict(temperatureK=300, durationFs=50000, sampleEveryFs=100)
MD_DEFAULTS = dict(temperatureK=600, durationFs=50000, sampleEveryFs=100)
MAX_LINE = 16 * 1024 * 1024


class SamplingError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Cancelled(SamplingError):
    pass


def require(condition, message, code='SAMPLING_INVALID'):
    if not condition:
        raise SamplingError(code, message)


def finite(value, lower=-1e12, upper=1e12):
    return type(value) in (int, float) and math.isfinite(value) and lower <= value <= upper


def integer(value, lower, upper):
    return type(value) is int and lower <= value <= upper


def keys(value, allowed):
    require(isinstance(value, dict) and set(value) <= set(allowed), 'Unknown or invalid sampling field')


def identity(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value) is not None


def sampling_segment_event(value, request):
    """Annotate actual local steps; a new segment never restores velocity/bias."""
    if request.get('segment') is None:
        return value
    result = dict(value, segment=copy.deepcopy(request['segment']), velocityInitialization='fresh',
                  biasInitialization='fresh' if request['operation'] == 'metadynamics' else 'not-applicable')
    if isinstance(result.get('lastFrame'), dict):
        result['lastFrame'] = sampling_segment_event(result['lastFrame'], request)
    step = result.get('step')
    if step is None and result.get('kind') in ('completed', 'stopped', 'error'):
        step = result.get('lastFrame', {}).get('step', 0) if result.get('lastFrame') else 0
        result['step'] = step
    if step is not None:
        cumulative = request['segment']['completedStepsBefore'] + step
        require(type(step) is int and step >= 0 and cumulative <= 2**53-1, 'Sampling segment step cannot be represented exactly')
        result.update(localStep=step, localTimeFs=step*request['dtFs'], cumulativeStep=cumulative, cumulativeTimeFs=cumulative*request['dtFs'])
    return result


def step_count(duration, dt, allow_zero=False):
    require(finite(duration, 0 if allow_zero else dt, 2**53-1), 'Invalid duration')
    count = round(duration / dt)
    require(abs(count * dt - duration) <= 1e-9, 'Durations must be integer multiples of the MD timestep')
    return int(count)


def sampling_driver(request):
    if request.get('integrator') == 'ase':
        return 'ase-bussi', 'ase-bussi-ordinary-md'
    if request['operation'] in ('md', 'metadynamics') and request['method'] in CAPABILITY['methodDefinitions']:
        return 'native-xtb-md', 'native-rmsd-metadynamics' if request['operation'] == 'metadynamics' else 'native-ordinary-md'
    return 'ase-langevin', 'ase-forcefield-or-temperature-bias-route'


def annealing_segments(settings):
    low, high = settings['lowTemperatureK'], settings['highTemperatureK']
    if 'cycleDurationFs' in settings:
        duration = settings['cycleDurationFs']
        return [('heating', duration*.1, low, high), ('high-hold', duration*.7, high, high), ('cooling', duration*.2, high, low)]
    return [('heating', settings['heatingFs'], low, high), ('high-hold', settings['highHoldFs'], high, high),
            ('cooling', settings['coolingFs'], high, low), ('low-hold', settings['lowHoldFs'], low, low)]


def hydrogen_bond_pairs(request):
    atoms = request['structure']['atoms']
    return [(b['a'], b['b']) for b in request['structure'].get('bonds', [])
            if atoms[b['a']]['element'] == 'H' or atoms[b['b']]['element'] == 'H']


def hydrogen_settings(request):
    """An explicit new integration uses absolute masses. Old omissions use natural mass."""
    method = request['method']
    explicit = 'integrator' in request
    default_shake = method != 'gfnff' and not explicit
    shake = request.get('shakeHydrogenBonds', default_shake)
    require(type(shake) is bool and (method != 'gfnff' or not shake), 'GFN-FF MD requires X–H constraints off.')
    mass = request.get('hydrogenMassAmu', (1 if shake else 4) if explicit else None)
    require(mass is None and not explicit or type(mass) in (int, float) and mass == (1 if shake else 4)
            and (explicit or method == 'gfnff'),
            'MD hydrogen mass must be 1 amu with X–H constraints on or 4 amu with them off.')
    return shake, int(mass) if mass is not None else None


def validate_request(raw):
    require(isinstance(raw, dict), 'Sampling request object required')
    keys(raw, {'schema', 'stamp', 'runIdentity', 'segment', 'operation', 'structure', 'method', 'charge', 'uhf',
               'frozenAtomIds', 'constraints', 'calculator', 'solvation', 'annealing', 'metadynamics',
               'molecularMD', 'sphericalMD', 'sphere', 'coreProtection', 'nativeProtection', 'memoryBudgetBytes', 'driver', 'driverReason',
               'hydrogenMassAmu', 'integrator', 'device', 'maxWallTimeSeconds', 'seedMode', *DEFAULTS})
    require(raw.get('schema') == 1 and raw.get('operation') in OPERATIONS and raw.get('method') in METHODS,
            'Unsupported sampling operation/method')
    require(raw.get('integrator', 'xtb') in ('xtb', 'ase'), 'Unsupported sampling integrator')
    request = copy.deepcopy({**DEFAULTS, **raw})
    native = sampling_driver(request)[0] == 'native-xtb-md'
    require(native or request.get('integrator') == 'ase' and request['operation'] == 'md',
            'RMSD metadynamics requires the native xTB molecular route.')
    require(request['method'] != 'gxtb' or native, 'g-xTB sampling requires native MD/MTD')
    require('device' not in request, 'This sampling method uses its CPU evaluator.')
    if native:
        if 'seed' not in raw or request['method'] == 'gxtb':
            request.pop('seed', None)
        if request['method'] == 'gxtb':
            request.pop('seedMode', None)
    if 'segment' in request:
        segment = request['segment']; keys(segment, {'id', 'previousSegmentId', 'completedStepsBefore'})
        require(request['operation'] in ('md', 'metadynamics') and identity(segment.get('id'))
                and ('previousSegmentId' not in segment or identity(segment['previousSegmentId']) and segment['previousSegmentId'] != segment['id'])
                and integer(segment.get('completedStepsBefore'), 0, 2**53-1), 'Invalid fresh sampling segment identity or completed step count')
    shake, mass = hydrogen_settings(raw)
    request['shakeHydrogenBonds'] = shake
    if mass is not None:
        request['hydrogenMassAmu'] = mass
    stamp, run = request.get('stamp'), request.get('runIdentity')
    keys(stamp, ['documentId', 'revision', 'activationEpoch', 'graphFingerprint', 'coordinatesFingerprint', 'constraintsFingerprint'])
    require(isinstance(stamp.get('documentId'), str) and bool(stamp['documentId']) and integer(stamp.get('revision'), 0, 2**53-1)
            and all(isinstance(stamp.get(k), str) and len(stamp[k].encode()) <= 1024*1024 for k in ('graphFingerprint', 'coordinatesFingerprint', 'constraintsFingerprint'))
            and ('activationEpoch' not in stamp or integer(stamp['activationEpoch'], 0, 2**53-1)), 'Invalid sampling source stamp')
    keys(run, ['taskId', 'runId'])
    require(set(run) == {'taskId', 'runId'} and all(identity(v) for v in run.values()), 'Invalid task/run identity')
    structure = request.get('structure')
    require(isinstance(structure, dict) and isinstance(structure.get('atoms'), list) and len(structure['atoms']) >= 1,
            'Complete nonempty atom structure required')
    require(structure.get('dimension', 3) == 3, 'Sampling requires actual three-dimensional coordinates')
    cell = structure.get('cell', {})
    periodic = any(cell.get('pbc', []))
    require(not structure.get('periodicSource') or periodic, 'Sampling requires a full source XYZ cell for periodic structures.')
    if periodic:
        require(not native and cell.get('pbc') == [True, True, True] and not request.get('sphere') and not request.get('solvation'),
                'Periodic sampling requires ordinary ASE MD on a full fixed XYZ cell without sphere or solvation.')
        vectors = cell.get('vectors')
        require(isinstance(vectors, list) and len(vectors) == 3 and all(isinstance(row, list) and len(row) == 3
                and all(finite(value, -1e6, 1e6) for value in row) for row in vectors)
                and abs(float(np.linalg.det(vectors))) > 0, 'Periodic sampling requires finite three-dimensional lattice vectors.')
    atoms = structure['atoms']; ids = [a.get('id') for a in atoms]
    require(all(isinstance(i, str) and i for i in ids) and len(set(ids)) == len(ids), 'Unique stable atom IDs required')
    max_atomic_number = 103 if request['method'] == 'gxtb' else 86
    require(all(a.get('element') in atomic_numbers and 1 <= atomic_numbers[a['element']] <= max_atomic_number
                and integer(a.get('formalCharge', 0), -100, 100)
                and all(finite(a.get(k), -1e6, 1e6) for k in ('x', 'y', 'z')) for a in atoms), 'Invalid atom or coordinates')
    neighbours = [set() for _ in atoms]; edges = set()
    for bond in structure.get('bonds', []):
        a, b = bond.get('a'), bond.get('b')
        image = bond.get('image', [0, 0, 0])
        require(isinstance(image, list) and len(image) == 3 and all(integer(value, -(2**53-1), 2**53-1) for value in image)
                and (periodic or not any(image)), 'Invalid periodic image in the sampling graph.')
        require(integer(a, 0, len(atoms)-1) and integer(b, 0, len(atoms)-1) and (a != b or periodic and any(image))
                and bond.get('order') in (.5, 1, 1.5, 2, 3, 4), 'Invalid explicit sampling graph')
        reverse = a > b or a == b and next((value for value in image if value), 0) < 0
        edge = (b, a, tuple(-value for value in image)) if reverse else (a, b, tuple(image))
        require(edge not in edges, 'Duplicate explicit bond'); edges.add(edge)
        neighbours[a].add(b); neighbours[b].add(a)
    if request['operation'] == 'spherical-md':
        pending = set(range(len(atoms))); fragments = 0
        while pending:
            fragments += 1; stack = [pending.pop()]
            while stack:
                new = neighbours[stack.pop()] & pending; pending -= new; stack.extend(new)
        require(fragments >= 2, 'Spherical multi-molecule sampling requires at least two explicit connected components')
    require(integer(request.get('charge'), -100, 100), 'Explicit integer charge required')
    electrons = sum(atomic_numbers[a['element']] for a in atoms) - request['charge']
    require('charge' not in structure or integer(structure['charge'], request['charge'], request['charge']),
            'Source charge differs from sampling request')
    if request['method'] == 'gfnff':
        require('uhf' not in request or integer(request['uhf'], 0, 0), 'GFN-FF has no spin Hamiltonian')
        multiplicity = structure.get('multiplicity')
        require(electrons > 0 and ('multiplicity' not in structure or integer(multiplicity, 1, electrons+1)
                and (electrons - (multiplicity-1)) % 2 == 0), 'Source multiplicity/electron parity mismatch')
    else:
        require(integer(request.get('uhf'), 0, 2**53-2), 'Explicit nonnegative integer sampling UHF required')
        require(False or electrons > 0 and request['uhf'] <= electrons
                and (electrons-request['uhf']) % 2 == 0, 'Charge/UHF parity mismatch')
        multiplicity = request['uhf'] + 1
        require('multiplicity' not in structure or integer(structure['multiplicity'], multiplicity, multiplicity),
                'Source multiplicity differs from sampling request')
    request.setdefault('frozenAtomIds', []); request.setdefault('constraints', [])
    if 'nativeProtection' in request:
        require(sampling_driver(request)[0]=='native-xtb-md','Native protection belongs only to ordinary native xTB MD')
        protection=request['nativeProtection'];keys(protection,['core','sphere'])
        require(bool(protection),'Empty native protection is not a scientific definition')
        if 'core' in protection:
            core=protection['core'];keys(core,['kind','atomIds','forceConstantEVPerAngstrom2']);selected=core.get('atomIds')
            require(core.get('kind')=='pairwise-distance' and isinstance(selected,list) and len(selected)>=2 and len(set(selected))==len(selected) and set(selected)<=set(ids) and finite(core.get('forceConstantEVPerAngstrom2'),1e-6,6000),'Invalid native pairwise-distance core definition')
        if 'sphere' in protection:
            sphere=protection['sphere'];keys(sphere,['kind','centerAngstrom','radiusAngstrom','exponent']);center=sphere.get('centerAngstrom')
            require(sphere.get('kind')=='polynomial' and sphere.get('exponent')==30 and isinstance(center,list) and len(center)==3 and all(finite(v,-1e6,1e6)for v in center) and finite(sphere.get('radiusAngstrom'),.01,10000),'Invalid native polynomial sphere definition')
    if native:
        require('coreProtection' not in request and 'sphere' not in request and request['frozenAtomIds'] == [],
                'Ordinary xTB MD stays native; core/sphere/XYZ protection requires an explicitly supported native definition')
    else:
        require('coreProtection' not in request, 'ASE sampling requires explicit XYZ frozen atoms for core protection.')
    frozen = request['frozenAtomIds']
    require(isinstance(frozen, list) and len(set(frozen)) == len(frozen) and set(frozen) < set(ids), 'Invalid or fully frozen sampling atoms')
    if native:
        if request['constraints']:
            from conformer_native_md import NativeMDError, native_protection_settings
            try:
                native_protection_settings(dict(request, nativeProtection=None))
            except NativeMDError as exc:
                raise SamplingError(exc.code, str(exc)) from exc
        if request['method'] != 'gxtb':
            mode = request.get('seedMode', 'specified' if 'seed' in request else 'auto')
            require(mode in ('auto', 'specified') and (mode == 'auto' or integer(request.get('seed'), 0, 2**31-1)),
                    'Native MD seed must be within 0..2147483647')
    else:
        mode = request.get('seedMode', 'specified' if 'seed' in raw else 'auto')
        require(mode in ('auto', 'specified') and (mode == 'auto' or integer(raw.get('seed'), 0, 2**32-1)),
                'Invalid ASE sampling seed')
        if mode == 'auto':
            request.pop('seed', None)
    require(type(request['shakeHydrogenBonds']) is bool and ('memoryBudgetBytes' not in request or integer(request['memoryBudgetBytes'], 1, 2**53-1)), 'Invalid SHAKE/host memory budget')
    if native and request['shakeHydrogenBonds']:
        pairs = hydrogen_bond_pairs(request); fixed_indices = {ids.index(id) for id in frozen}
        require(all(sum((atoms[a][k]-atoms[b][k])**2 for k in ('x','y','z')) > 1e-16 for a,b in pairs), 'SHAKE requires nonzero source X-H bond lengths')
        active_pairs = [(a,b) for a,b in pairs if a not in fixed_indices or b not in fixed_indices]
        require(3*(len(atoms)-len(frozen)) > len(active_pairs), 'SHAKE leaves no free physical degrees of freedom')
    require(integer(request['threads'], 1, 2**53-1)
            and integer(request['maxSteps'], 1, 2**53-1) and integer(request['maxEvaluations'], 1, 2**53-1)
            and ('maxWallTimeSeconds' not in request or finite(request['maxWallTimeSeconds'], .01, sys.float_info.max)) and integer(request['maxFrames'], 1, 2**53-1)
            and integer(request['reportEvery'], 1, 2**53-1) and finite(request['dtFs'], .01, 2)
            and finite(request['frictionPerFs'], 1e-6, 1), 'Invalid sampling integration/resource budget')
    unprotected_native_segment = native and 'segment' in request and 'core' not in (request.get('nativeProtection') or {})
    require('integrator' not in raw or unprotected_native_segment or request['dtFs'] == 2,
            'Ordinary MD, ASE-Bussi and protected native core use a 2 fs timestep.')
    # New MD uses the common MD precision profile; historical requests retain
    # the effective defaults they were created with.
    calc = dict(accuracy=2 if 'integrator' in raw else 1, maxIterations=250, electronicTemperatureK=300)
    keys(request.get('calculator', {}), calc); calc.update(request.get('calculator', {}))
    require(finite(calc['accuracy'], .001, 10) and integer(calc['maxIterations'], 1, 2000)
            and finite(calc['electronicTemperatureK'], 0, 10000), 'Invalid electronic settings')
    request['calculator'] = calc
    if 'solvation' in request:
        keys(request['solvation'], ['model', 'solvent']); sol = request['solvation']
        require(set(sol) == {'model', 'solvent'}
                and sol['model'] in ('alpb', 'gbsa') and isinstance(sol['solvent'], str)
                and re.fullmatch(r'[a-z0-9-]{1,40}', sol['solvent']), 'Invalid or unsupported sampling solvation')
        if native:
            require(sol['model'] == 'alpb' and native_alpb_supported(request['method'], request['operation'], sol['solvent']),
                    'Solvent is not supported for this native MD/MTD method')
        else:
            require(sol['model'] == 'alpb' and native_alpb_supported(request['method'], request['operation'], sol['solvent']),
                    'Solvent is not parametrized for the selected molecular ASE MD method')
    core = request.get('coreProtection')
    if core is not None:
        keys(core, ['atomIds', 'forceConstantEVPerAngstrom2'])
        require(isinstance(core.get('atomIds'), list) and len(core['atomIds']) > 0 and len(set(core['atomIds'])) == len(core['atomIds'])
                and set(core['atomIds']) <= set(ids), 'Invalid protected core identity')
        core.setdefault('forceConstantEVPerAngstrom2', 10)
        require(finite(core['forceConstantEVPerAngstrom2'], 1e-6, 1000), 'Invalid core protection strength')
    op = request['operation']; dt = request['dtFs']
    require(all(op == operation or field not in request for operation, field in [('md', 'molecularMD'), ('anneal', 'annealing'), ('metadynamics', 'metadynamics'), ('spherical-md', 'sphericalMD')]), 'Configuration belongs to another sampling route')
    if op == 'anneal':
        legacy_keys = ('heatingFs','highHoldFs','coolingFs','lowHoldFs'); raw_settings = request.get('annealing', {})
        keys(raw_settings, {*ANNEAL_DEFAULTS, *legacy_keys}); legacy = any(k in raw_settings for k in legacy_keys)
        require(not legacy or 'cycleDurationFs' not in raw_settings, 'Do not combine canonical and legacy annealing schedules')
        defaults = dict(lowTemperatureK=0,highTemperatureK=600,cycles=5,heatingFs=100,highHoldFs=100,coolingFs=100,lowHoldFs=100) if legacy else ANNEAL_DEFAULTS
        settings = {**defaults, **raw_settings}
        require(finite(settings['lowTemperatureK'], 0, 5000) and finite(settings['highTemperatureK'], settings['lowTemperatureK'], 5000)
                and integer(settings['cycles'], 1, 1000), 'Invalid annealing temperature/cycle settings')
        require(legacy or finite(settings['cycleDurationFs'], dt, 2**53-1), 'Invalid annealing cycle duration')
        total = sum(step_count(duration, dt, legacy and 'hold' in name) for name,duration,_,_ in annealing_segments(settings)) * settings['cycles']
        require(total <= request['maxSteps'], 'Annealing exceeds step budget')
        required_frames = total // request['reportEvery'] + settings['cycles']
        request['annealing'] = settings
    else:
        field = 'metadynamics' if op == 'metadynamics' else 'molecularMD' if op == 'md' else 'sphericalMD'
        defaults = META_DEFAULTS if op == 'metadynamics' else MD_DEFAULTS if op == 'md' else SPHERE_DEFAULTS
        settings = {**defaults, **request.get(field, {})}; keys(settings, {*defaults, 'atomIds'} if op == 'metadynamics' else defaults)
        require(finite(settings['temperatureK'], .01, 5000), 'Invalid thermostat temperature')
        steps = step_count(settings['durationFs'], dt); interval = step_count(settings['sampleEveryFs'], dt)
        require(steps <= request['maxSteps'], 'Sampling duration exceeds step budget')
        if request.get('segment') is not None:
            require(request['segment']['completedStepsBefore']+steps <= 2**53-1, 'Cumulative sampling segment steps exceed exact representation')
        reports = request['reportEvery']; overlap = steps // math.lcm(interval, reports) + int(steps % reports == 0 and steps % interval != 0)
        required_frames = math.ceil(steps / interval) + steps // reports - overlap
        if op == 'metadynamics':
            settings.setdefault('atomIds', ids.copy())
            selected = settings['atomIds']
            require(isinstance(selected, list) and len(selected) >= 2 and len(set(selected)) == len(selected) and set(selected) <= set(ids), 'RMSD metadynamics requires at least two unique atoms')
            deposit = step_count(settings['depositEveryFs'], dt)
            require(finite(settings['heightEV'], 1e-8, 10) and finite(settings['sigmaAngstrom'], 1e-4, 10)
                    and integer(settings['maxHistory'], 1, 2**53-1) and (steps-int(sampling_driver(request)[0]=='native-xtb-md')) // deposit + 1 <= settings['maxHistory'], 'Invalid or excessive complete bias history')
        request[field] = settings
    sphere = request.get('sphere')
    require(op != 'spherical-md' or sphere is not None, 'Spherical MD requires an explicit sphere shared with its preview')
    if sphere is not None:
        keys(sphere, ['centerAngstrom', 'radiusAngstrom', 'forceConstantEVPerAngstrom2'])
        center = sphere.get('centerAngstrom')
        sphere.setdefault('forceConstantEVPerAngstrom2', 1)
        require(isinstance(center, list) and len(center) == 3 and all(finite(v, -1e6, 1e6) for v in center)
                and finite(sphere.get('radiusAngstrom'), .01, 1e6) and finite(sphere['forceConstantEVPerAngstrom2'], 1e-6, 1000), 'Invalid explicit sphere')
    require(required_frames <= request['maxFrames'], 'Configured sampling would exceed retained frame budget before completion')
    driver, reason = sampling_driver(request)
    require(request.get('driver',driver) == driver and request.get('driverReason',reason) == reason, 'Sampling driver differs from the actual capability route')
    request.update(driver=driver, driverReason=reason)
    if driver == 'native-xtb-md':
        dynamics = request['metadynamics'] if op == 'metadynamics' else request['molecularMD']
        require(request['maxEvaluations'] >= step_count(dynamics['durationFs'],request['dtFs'])+2,
                'Native MD requires the locked N+2 upper-bound energy/gradient budget (actual count is not reported)')
    else:
        require(request['maxEvaluations'] >= steps + 1, 'ASE MD requires a budget for the initial and each subsequent energy/force evaluation.')
    return request


def fitted_residual(positions, reference):
    """Proper-rotation RMSD. Residuals/forces are expressed in original axes.

    The minimized squared residual is differentiable away from rotational
    degeneracies. Rank metadata makes unidentifiable directions explicit.
    """
    x = np.asarray(positions, dtype=float); y = np.asarray(reference, dtype=float)
    xc = x-x.mean(axis=0); yc = y-y.mean(axis=0)
    u, singular, vt = np.linalg.svd(xc.T @ yc)
    correction = np.eye(3); correction[-1, -1] = 1 if np.linalg.det(u @ vt) >= 0 else -1
    rotation = u @ correction @ vt
    residual = xc-yc @ rotation.T
    rank = int(np.sum(singular > max(float(singular[0]), 1) * 1e-12))
    return residual, dict(rank=rank, orientationUnique=rank >= 2,
                          degeneracy='single-atom' if len(x) == 1 else 'collinear-or-coincident' if rank < 2 else 'none')


def core_diagnostic(positions, reference):
    """Report the selected core only, with an explicit degenerate-set check."""
    x = np.asarray(positions, dtype=float); y = np.asarray(reference, dtype=float)
    residual, metadata = fitted_residual(x, y)
    if len(x) == 1:
        # A one-point fit always yields zero. Its only meaningful protection is
        # source-frame displacement; use that same residual for the soft force.
        residual = x-y
    pairs = [abs(float(np.linalg.norm(x[i]-x[j])-np.linalg.norm(y[i]-y[j])))
             for i in range(len(x)) for j in range(i)]
    return residual, dict(rmsdAngstrom=math.sqrt(float(np.mean(np.sum(residual**2, axis=1)))),
        maxResidualAngstrom=float(np.max(np.linalg.norm(residual, axis=1))),
        maxPairDistanceResidualAngstrom=max(pairs, default=0.),
        assessment='source-displacement' if len(x) == 1 else 'relative-distances' if metadata['rank'] < 2 else 'rigid-fit-rmsd',
        **metadata)


def main():
    session = None; payload = None; request_validated = False; seq = 0; output_bytes = 0; cancelled = threading.Event(); reader_done = threading.Event()
    output_scope = ExitStack()
    native_protocol = None
    def emit(value):
        nonlocal seq, output_bytes
        request = payload['request']
        packet = dict(schema=1, sessionId=payload['sessionId'], stamp=request['stamp'], runIdentity=request['runIdentity'],
                      operation=request['operation'], method=request['method'], seq=seq, **(sampling_segment_event(value, request) if request_validated else value))
        # JSONEncoder streams each atomic event; the host validates complete
        # NDJSON frames and applies only an explicit scientific output budget.
        if native_protocol is None:
            json.dump(packet, sys.stdout, allow_nan=False, separators=(',', ':'))
            sys.stdout.write('\n')
            sys.stdout.flush()
        else:
            native_protocol.write((json.dumps(packet, allow_nan=False, separators=(',', ':')) + '\n').encode('utf-8'))
            native_protocol.flush()
        seq += 1
    def controls(pending):
        blocks = control_blocks(sys.stdin.fileno(), reader_done)
        while not cancelled.is_set():
            if b'\n' not in pending:
                block = next(blocks, b'')
                if not block: cancelled.set(); return
                pending += block
            if len(pending) > MAX_LINE: cancelled.set(); return
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                try:
                    obj = json.loads(line)
                    require(set(obj) == {'schema', 'sessionId', 'runIdentity', 'command'} and obj['schema'] == 1
                            and obj['sessionId'] == payload['sessionId'] and obj['runIdentity'] == payload['request']['runIdentity']
                            and obj['command'] == 'stop', 'Invalid owned sampling command')
                except Exception: cancelled.set(); return
                cancelled.set(); return
    try:
        pending = b''
        while b'\n' not in pending:
            block = os.read(sys.stdin.fileno(), 65536)
            require(bool(block), 'Initial sampling packet was not received')
            pending += block
        line, pending = pending.split(b'\n', 1)
        payload = json.loads(line, parse_constant=lambda _: (_ for _ in ()).throw(SamplingError('SAMPLING_INVALID', 'Nonfinite JSON')))
        require(isinstance(payload, dict) and isinstance(payload.get('request'), dict), 'Invalid sampling envelope')
        payload['request'] = validate_request(payload['request'])
        request_validated = True
        using_ase = payload['request']['driver'] == 'ase-bussi'
        allowed = {'aseContext'} if using_ase else {'runtime', 'workspacePath'}
        require(set(payload) == {'schema', 'sessionId', 'request', *allowed}
                and payload['schema'] == 1 and identity(payload['sessionId']), 'Invalid sampling envelope')
        threading.Thread(target=controls, args=(pending,), daemon=True).start()
        started = time.monotonic()
        def check_native():
            if cancelled.is_set(): raise Cancelled('SAMPLING_CANCELLED','Sampling stopped; complete candidates remain separate')
            limit = payload['request'].get('maxWallTimeSeconds')
            require(limit is None or time.monotonic()-started<=limit,'Sampling walltime budget exhausted','SAMPLING_WALLTIME')
        check_native()
        if using_ase:
            workspace = Path(payload['aseContext']['workspacePath'])
            native_protocol = output_scope.enter_context(route_native_output(workspace, filename='ase-native.log', restore=False))
            from ase_md import SamplingSession
            session = SamplingSession(payload['request'], payload['aseContext'], emit, check_native)
        else:
            from conformer_native_md import NativeMDSession
            session = NativeMDSession(payload['request'], dict(runtime=payload['runtime'], workspacePath=payload['workspacePath'],
                memoryBudgetBytes=payload['request'].get('memoryBudgetBytes'), emit=emit, check=check_native, cancelled=cancelled))
        emit(session.run()); return 0
    except Exception as exc:
        if isinstance(payload, dict) and isinstance(payload.get('request'), dict) and all(k in payload['request'] for k in ('stamp', 'runIdentity', 'operation', 'method')):
            observations = ({'nativeTemperatureObservations': copy.deepcopy(session.native_temperature_observations)}
                            if session is not None and hasattr(session, 'native_temperature_observations') else {})
            if session is not None and hasattr(session, 'initial_velocity_correction'):
                observations['initialVelocityCorrection'] = copy.deepcopy(session.initial_velocity_correction)
            if session is not None and getattr(session, 'optional_diagnostics', None):
                observations['optionalDiagnostics'] = copy.deepcopy(session.optional_diagnostics)
            if session is not None and getattr(session, 'native_solvation', None) is not None:
                observations['nativeSolvation'] = copy.deepcopy(session.native_solvation)
            if isinstance(exc, Cancelled) or getattr(exc,'code',None)=='SAMPLING_CANCELLED': emit(dict(kind='stopped', workerSettled=True, reason='cancelled', lastFrame=session.last_frame if session else None, nativeClosed=session.native_closed() if session else True, **observations))
            else:
                details = getattr(exc, 'details', None)
                error = dict(code=getattr(exc, 'code', 'SAMPLING_FAILED'), message=str(exc)[:8192])
                if details is not None:
                    error['details'] = copy.deepcopy(details)
                emit(dict(kind='error', workerSettled=True, error=error, lastFrame=session.last_frame if session else None, nativeClosed=session.native_closed() if session else True, **observations))
        return 0 if isinstance(exc, Cancelled) or getattr(exc,'code',None)=='SAMPLING_CANCELLED' else 1
    finally:
        reader_done.set()
        output_scope.close()


if __name__ == '__main__':
    raise SystemExit(main())
