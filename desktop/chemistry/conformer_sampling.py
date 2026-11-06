"""Explicit bounded conformer sampling, separate from subsequent optimization.

ASE integrates one continuous physical trajectory. Added potentials retain their
own energy identity; sampled candidates are never claimed to be optimized.
"""
from __future__ import annotations
import copy
import hashlib
import json
import math
import os
import re
import sys
import threading
import time
from types import SimpleNamespace

import numpy as np
from ase import Atoms, units, __version__ as ase_version
from ase.calculators.calculator import Calculator, all_changes
from ase.constraints import FixAtoms, FixBondLengths
from ase.data import atomic_numbers
from ase.md.langevin import Langevin
from ase.md.velocitydistribution import MaxwellBoltzmannDistribution
from native_stdin import control_blocks

METHODS = ('MMFF94', 'MMFF94s', 'UFF', 'gfn0', 'gfn1', 'gfn2', 'gfnff')
OPERATIONS = ('md', 'metadynamics', 'spherical-md')
DEFAULTS = dict(threads=2, maxSteps=100000, maxEvaluations=200001,
                maxFrames=2000, seed=731,
                dtFs=2, frictionPerFs=.01, reportEvery=20, shakeHydrogenBonds=True)
ANNEAL_DEFAULTS = dict(lowTemperatureK=0, highTemperatureK=600, cycleDurationFs=10000, cycles=5)
META_DEFAULTS = dict(temperatureK=300, durationFs=50000, sampleEveryFs=100,
                    depositEveryFs=100, heightEV=.01, sigmaAngstrom=.5, maxHistory=1000)
SPHERE_DEFAULTS = dict(temperatureK=300, durationFs=50000, sampleEveryFs=100)
MD_DEFAULTS = dict(temperatureK=600, durationFs=50000, sampleEveryFs=100)
MAX_LINE = 16 * 1024 * 1024
ALPB_SOLVENTS = ('acetone', 'acetonitrile', 'aniline', 'benzaldehyde', 'benzene', 'ch2cl2', 'chcl3', 'cs2', 'dioxane', 'dmf', 'dmso', 'ethanol', 'ether', 'ethylacetate', 'furane', 'hexadecane', 'hexane', 'methanol', 'nitromethane', 'octanol', 'woctanol', 'phenol', 'toluene', 'thf', 'water')
GBSA_SOLVENTS = ('acetone', 'acetonitrile', 'benzene', 'ch2cl2', 'chcl3', 'cs2', 'dmso', 'ether', 'water', 'methanol', 'thf', 'toluene')


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
    if request['operation'] in ('md', 'metadynamics') and request['method'] in ('gfnff', 'gfn0', 'gfn1', 'gfn2'):
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


def validate_request(raw):
    require(isinstance(raw, dict), 'Sampling request object required')
    keys(raw, {'schema', 'stamp', 'runIdentity', 'segment', 'operation', 'structure', 'method', 'charge', 'uhf',
               'frozenAtomIds', 'constraints', 'calculator', 'solvation', 'annealing', 'metadynamics',
               'molecularMD', 'sphericalMD', 'sphere', 'coreProtection', 'nativeProtection', 'memoryBudgetBytes', 'driver', 'driverReason', 'hydrogenMassAmu', 'maxWallTimeSeconds', *DEFAULTS})
    require(raw.get('schema') == 1 and raw.get('operation') in OPERATIONS and raw.get('method') in METHODS,
            'Unsupported sampling operation/method')
    request = copy.deepcopy({**DEFAULTS, **raw})
    if 'segment' in request:
        segment = request['segment']; keys(segment, {'id', 'previousSegmentId', 'completedStepsBefore'})
        require(request['operation'] in ('md', 'metadynamics') and identity(segment.get('id'))
                and ('previousSegmentId' not in segment or identity(segment['previousSegmentId']) and segment['previousSegmentId'] != segment['id'])
                and integer(segment.get('completedStepsBefore'), 0, 2**53-1), 'Invalid fresh sampling segment identity or completed step count')
    # Missing wall time means no calculation deadline. Historical explicit
    # values remain readable; never encode unlimited execution as a huge value.
    if request['method'] == 'gfnff' and 'shakeHydrogenBonds' not in raw:
        request['shakeHydrogenBonds'] = False
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
    require(not structure.get('periodicSource') and not any(structure.get('cell', {}).get('pbc', []))
            and not any(any(b.get('image', [0, 0, 0])) for b in structure.get('bonds', [])), 'Sampling requires an isolated structure')
    atoms = structure['atoms']; ids = [a.get('id') for a in atoms]
    require(all(isinstance(i, str) and i for i in ids) and len(set(ids)) == len(ids), 'Unique stable atom IDs required')
    require(all(a.get('element') in atomic_numbers and 1 <= atomic_numbers[a['element']] <= 86
                and integer(a.get('formalCharge', 0), -100, 100)
                and all(finite(a.get(k), -1e6, 1e6) for k in ('x', 'y', 'z')) for a in atoms), 'Invalid atom or coordinates')
    neighbours = [set() for _ in atoms]; edges = set()
    for bond in structure.get('bonds', []):
        a, b = bond.get('a'), bond.get('b')
        require(integer(a, 0, len(atoms)-1) and integer(b, 0, len(atoms)-1) and a != b
                and bond.get('order') in (.5, 1, 1.5, 2, 3), 'Invalid explicit sampling graph')
        edge = tuple(sorted((a, b))); require(edge not in edges, 'Duplicate explicit bond'); edges.add(edge)
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
    require(electrons > 0 and integer(request.get('uhf'), 0, electrons) and (electrons-request['uhf']) % 2 == 0, 'Charge/UHF parity mismatch')
    if request['method'] == 'gfnff':
        require(request['uhf'] == 0, 'GFN-FF has no spin Hamiltonian')
    require(('charge' not in structure or structure['charge'] == request['charge'])
            and ('multiplicity' not in structure or structure['multiplicity'] == request['uhf']+1), 'Source charge/multiplicity differ from sampling request')
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
    if sampling_driver(request)[0] == 'native-xtb-md':
        if request['method'] == 'gfnff':
            if 'shakeHydrogenBonds' not in raw: request['shakeHydrogenBonds'] = False
            require(request['shakeHydrogenBonds'] is False, 'Locked native GFN-FF MD does not apply SHAKE; explicitly enable only a supported method')
        require('coreProtection' not in request and 'sphere' not in request and request['frozenAtomIds'] == [],
                'Ordinary xTB MD stays native; core/sphere/XYZ protection requires an explicitly supported native definition')
    # This is an absolute hydrogen mass, not HMR or a mass multiplier. Missing
    # fields intentionally retain the natural masses of historical requests.
    require('hydrogenMassAmu' not in request or (type(request['hydrogenMassAmu']) in (int, float)
            and request['hydrogenMassAmu'] == 4 and request['method'] == 'gfnff'),
            'Fixed hydrogen mass is supported only as 4 amu for GFN-FF sampling')
    frozen = request['frozenAtomIds']
    require(isinstance(frozen, list) and len(set(frozen)) == len(frozen) and set(frozen) < set(ids), 'Invalid or fully frozen sampling atoms')
    require(request['constraints'] == [], 'Internal-coordinate momentum constraints are not validated for sampling')
    require(type(request['shakeHydrogenBonds']) is bool and ('memoryBudgetBytes' not in request or integer(request['memoryBudgetBytes'], 1, 2**53-1)), 'Invalid SHAKE/host memory budget')
    if request['shakeHydrogenBonds']:
        pairs = hydrogen_bond_pairs(request); fixed_indices = {ids.index(id) for id in frozen}
        require(all(sum((atoms[a][k]-atoms[b][k])**2 for k in ('x','y','z')) > 1e-16 for a,b in pairs), 'SHAKE requires nonzero source X-H bond lengths')
        active_pairs = [(a,b) for a,b in pairs if a not in fixed_indices or b not in fixed_indices]
        require(3*(len(atoms)-len(frozen)) > len(active_pairs), 'SHAKE leaves no free physical degrees of freedom')
    require(integer(request['threads'], 1, 2**53-1) and integer(request['seed'], 0, 2**32-1)
            and integer(request['maxSteps'], 1, 2**53-1) and integer(request['maxEvaluations'], 1, 2**53-1)
            and ('maxWallTimeSeconds' not in request or finite(request['maxWallTimeSeconds'], .01, 7200)) and integer(request['maxFrames'], 1, 2**53-1)
            and integer(request['reportEvery'], 1, 2**53-1) and finite(request['dtFs'], .01, 2)
            and finite(request['frictionPerFs'], 1e-6, 1), 'Invalid sampling integration/resource budget')
    calc = dict(accuracy=1, maxIterations=250, electronicTemperatureK=300)
    keys(request.get('calculator', {}), calc); calc.update(request.get('calculator', {}))
    require(finite(calc['accuracy'], .001, 10) and integer(calc['maxIterations'], 1, 2000)
            and finite(calc['electronicTemperatureK'], 0, 10000), 'Invalid electronic settings')
    request['calculator'] = calc
    if 'solvation' in request:
        keys(request['solvation'], ['model', 'solvent']); sol = request['solvation']
        require(request['method'] in ('gfn1', 'gfn2') and set(sol) == {'model', 'solvent'}
                and sol['model'] in ('alpb', 'gbsa') and isinstance(sol['solvent'], str)
                and re.fullmatch(r'[a-z0-9]{1,40}', sol['solvent']), 'Invalid or unsupported sampling solvation')
        supported = ALPB_SOLVENTS if sol['model'] == 'alpb' else GBSA_SOLVENTS + (('dmf', 'hexane') if request['method'] == 'gfn2' else ())
        require(sol['solvent'] in supported, 'Solvent is not parametrized for the selected method/model')
    if request['method'] in ('MMFF94', 'MMFF94s', 'UFF'):
        require(sum(a.get('formalCharge', 0) for a in atoms) == request['charge'],
                'Force-field graph formal charges differ from requested total charge')
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
    return request


class HydrogenBondShake(FixBondLengths):
    """Reuse ASE RATTLE with zero inverse mass for exact XYZ-fixed endpoints.

    The proxy is used only inside constraint projection; physical masses and
    the original Atoms remain unchanged. Fully fixed pairs need no projection.
    """
    def __init__(self, pairs, fixed, lengths):
        super().__init__(pairs, tolerance=1e-10, bondlengths=lengths)
        self.fixed = fixed

    def view(self, atoms):
        masses = atoms.get_masses().copy(); masses[self.fixed] = np.inf
        return SimpleNamespace(positions=atoms.positions, cell=atoms.cell, pbc=atoms.pbc,
                               get_masses=lambda: masses, get_distance=atoms.get_distance)

    def adjust_positions(self, atoms, new):
        return super().adjust_positions(self.view(atoms), new)

    def adjust_momenta(self, atoms, momenta):
        super().adjust_momenta(self.view(atoms), momenta)
        # RATTLE stores the fixed endpoint's reaction impulse as momentum even
        # with zero inverse mass. XYZ-frozen atoms must retain exact zero p.
        momenta[self.fixed] = 0.


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


def sphere_potential(positions, center, radius, strength):
    delta = np.asarray(positions)-np.asarray(center); distances = np.linalg.norm(delta, axis=1)
    penetration = np.maximum(0, distances-radius)
    force = -strength * penetration[:, None] * delta / np.maximum(distances[:, None], 1e-30)
    return .5*strength*float(penetration @ penetration), force, float(np.max(penetration))


def suggested_sphere(positions, margin_angstrom=3):
    xyz = np.asarray(positions, dtype=float)
    require(xyz.ndim == 2 and xyz.shape[1] == 3 and len(xyz) and np.isfinite(xyz).all() and finite(margin_angstrom, .01, 1000), 'Invalid sphere preview coordinates/margin')
    center = xyz.mean(axis=0)
    return dict(centerAngstrom=center.tolist(), radiusAngstrom=float(np.max(np.linalg.norm(xyz-center, axis=1)))+margin_angstrom,
                forceConstantEVPerAngstrom2=1)


class BiasPotential:
    def __init__(self, request, positions, ids):
        self.request = request; index = {id: i for i, id in enumerate(ids)}
        core = request.get('coreProtection'); meta = request.get('metadynamics')
        self.core_indices = [index[id] for id in core['atomIds']] if core else []
        self.core_reference = positions[self.core_indices].copy()
        self.meta_indices = [index[id] for id in meta['atomIds']] if meta else []
        self.history = []; self.revision = 0

    def deposit(self, positions, step):
        settings = self.request['metadynamics']
        require(len(self.history) < settings['maxHistory'], 'Complete metadynamics history budget exhausted', 'SAMPLING_HISTORY_LIMIT')
        entry = dict(index=len(self.history), step=step, timeFs=step*self.request['dtFs'],
                     atomIds=settings['atomIds'].copy(), coordinatesAngstrom=positions[self.meta_indices].tolist(),
                     heightEV=settings['heightEV'], sigmaAngstrom=settings['sigmaAngstrom'])
        self.history.append(entry); self.revision += 1
        return copy.deepcopy(entry)

    def evaluate(self, positions):
        forces = np.zeros_like(positions); energies = dict(coreBiasEV=0., metaBiasEV=0., sphereBiasEV=0.)
        diagnostics = dict(maxWallPenetrationAngstrom=0.)
        if self.core_indices:
            residual, metadata = core_diagnostic(positions[self.core_indices], self.core_reference)
            strength = self.request['coreProtection']['forceConstantEVPerAngstrom2']
            energies['coreBiasEV'] = .5*strength*float(np.sum(residual**2)); forces[self.core_indices] -= strength*residual
            diagnostics['core'] = metadata
        if self.meta_indices:
            for hill in self.history:
                residual, _ = fitted_residual(positions[self.meta_indices], hill['coordinatesAngstrom'])
                sigma2 = hill['sigmaAngstrom']**2; n = len(self.meta_indices)
                energy = hill['heightEV']*math.exp(-float(np.sum(residual**2))/(2*n*sigma2))
                energies['metaBiasEV'] += energy; forces[self.meta_indices] += energy*residual/(n*sigma2)
        sphere = self.request.get('sphere')
        if sphere is not None:
            energy, force, penetration = sphere_potential(positions, sphere['centerAngstrom'], sphere['radiusAngstrom'], sphere['forceConstantEVPerAngstrom2'])
            energies['sphereBiasEV'] = energy; forces += force; diagnostics['maxWallPenetrationAngstrom'] = penetration
        return energies, forces, diagnostics


def physical_calculator(request, native_context=None):
    if request['method'] in ('MMFF94', 'MMFF94s', 'UFF'):
        from dynamics import RDKitCalculator
        calculator = RDKitCalculator(request['structure'], request['method'])
        require(calculator.forcefield == request['method'], 'Selected force field lacks parameters; no fallback is permitted', 'SAMPLING_PARAMETERIZATION')
        return calculator
    if request['method'] == 'gfnff':
        from conformer_gfnff import IsolatedGfnffCalculator
        return IsolatedGfnffCalculator(request, native_context)
    if request['method'] == 'gfn0':
        from conformer_gfn0 import IsolatedGfn0Calculator
        return IsolatedGfn0Calculator(request, native_context)
    from tblite.ase import TBLite
    settings = request['calculator']
    kwargs = dict(method={'gfn1': 'GFN1-xTB', 'gfn2': 'GFN2-xTB'}[request['method']], charge=request['charge'],
                  multiplicity=request['uhf']+1, accuracy=settings['accuracy'], max_iterations=settings['maxIterations'],
                  electronic_temperature=settings['electronicTemperatureK'], verbosity=0)
    if request.get('solvation'):
        kwargs['solvation'] = (request['solvation']['model'], request['solvation']['solvent'])
    return TBLite(**kwargs)


class SamplingCalculator(Calculator):
    implemented_properties = ['energy', 'forces']
    def __init__(self, session, underlying):
        super().__init__(); self.session = session; self.underlying = underlying; self.last_physical = None
    def calculate(self, atoms=None, properties=None, system_changes=all_changes):
        self.session.check(); super().calculate(atoms, properties, system_changes)
        positions = atoms.positions.copy()
        evaluated = False
        if self.last_physical is None or not np.array_equal(positions, self.last_physical[0]):
            require(self.session.evaluations < self.session.request['maxEvaluations'], 'Physical force-evaluation budget exhausted', 'SAMPLING_EVALUATION_LIMIT')
            self.session.evaluations += 1
            evaluated = True
            self.underlying.calculate(atoms, ['energy', 'forces'], system_changes)
            energy = float(self.underlying.results['energy']); forces = np.asarray(self.underlying.results['forces'], dtype=float)
            require(finite(energy) and forces.shape == positions.shape and np.isfinite(forces).all(), 'Invalid physical energy/forces', 'SAMPLING_NONFINITE')
            self.last_physical = (positions, energy, forces.copy())
        _, physical_energy, physical_forces = self.last_physical
        biases, force, diagnostics = self.session.bias.evaluate(positions)
        require(all(finite(v, 0) for v in biases.values()) and np.isfinite(force).all(), 'Nonfinite sampling bias', 'SAMPLING_NONFINITE')
        self.results = dict(energy=physical_energy+sum(biases.values()), forces=physical_forces+force,
                            physicalEnergyEV=physical_energy, **biases, diagnostics=diagnostics)
        if self.session.audit_enabled:
            self.session.audit('force-use', physicalEvaluationPerformed=evaluated,
                               physicalEvaluationIndex=self.session.evaluations, coordinatesAngstrom=positions.tolist(),
                               physicalForcesEVPerAngstrom=physical_forces.tolist(), biasForcesEVPerAngstrom=force.tolist(),
                               usedForcesEVPerAngstrom=self.results['forces'].tolist(), physicalEnergyEV=physical_energy,
                               biasEnergiesEV=biases, diagnostics=diagnostics)
        if self.session.request['method'] in ('gfnff', 'gfn0') and hasattr(self.underlying, 'evidence'):
            evidence = self.underlying.evidence()
            if evidence.get('lastEvaluation'):
                evidence['lastEvaluation'] = {k: v for k, v in evidence['lastEvaluation'].items()
                                              if k not in ('gradientHartreePerBohr', 'coordinatesBohr', 'returnedForcesEVPerAngstrom')}
            self.results['calculatorEvidence'] = evidence
        self.session.check()


class Session:
    def __init__(self, request, emit, *, cancelled=None, calculator_factory=physical_calculator,
                 integrator_factory=Langevin, clock=time.monotonic, native_context=None):
        self.request = validate_request(request); self.emit = emit; self.cancelled = cancelled or threading.Event()
        self.audit_enabled = os.environ.get('SCIYUE_CONFORMER_AUDIT') == '1'
        self.clock = clock; self.started = clock(); self.factory = calculator_factory; self.integrator_factory = integrator_factory
        self.native_context = native_context; self.native_calculator = None
        self.source = copy.deepcopy(self.request['structure']); self.ids = [a['id'] for a in self.source['atoms']]
        self.original = np.array([[a[k] for k in ('x', 'y', 'z')] for a in self.source['atoms']], dtype=float)
        self.bias = BiasPotential(self.request, self.original, self.ids)
        self.evaluations = self.step = self.frame_count = self.candidate_count = 0
        self.last_frame = None; self.atoms = None; self.integrator = None
        self.shake_pairs = hydrogen_bond_pairs(self.request) if self.request['shakeHydrogenBonds'] else []
        self.shake_lengths = [float(np.linalg.norm(self.original[a]-self.original[b])) for a,b in self.shake_pairs]

    def check(self):
        if self.cancelled.is_set(): raise Cancelled('SAMPLING_CANCELLED', 'Sampling stopped; completed candidates remain separate')
        limit = self.request.get('maxWallTimeSeconds')
        require(limit is None or self.clock()-self.started <= limit, 'Sampling walltime budget exhausted', 'SAMPLING_WALLTIME')

    def start(self, temperature):
        self.check()
        self.atoms = Atoms(symbols=[a['element'] for a in self.source['atoms']], positions=self.original, pbc=False)
        if self.request.get('hydrogenMassAmu') is not None:
            masses = self.atoms.get_masses()
            masses[self.atoms.numbers == 1] = self.request['hydrogenMassAmu']
            self.atoms.set_masses(masses)
        fixed = [self.ids.index(id) for id in self.request['frozenAtomIds']]
        constraints = [FixAtoms(indices=fixed)] if fixed else []
        active = [(pair,length) for pair,length in zip(self.shake_pairs,self.shake_lengths) if pair[0] not in fixed or pair[1] not in fixed]
        if active: constraints.append(HydrogenBondShake([pair for pair,_ in active],fixed,[length for _,length in active]))
        if constraints: self.atoms.set_constraint(constraints)
        if self.request['method'] in ('gfnff', 'gfn0') and self.factory is physical_calculator:
            context = dict(self.native_context or {}, emit=self.emit, check=self.check, cancelled=self.cancelled)
            underlying = self.factory(self.request, context); self.native_calculator = underlying
        else: underlying = self.factory(self.request)
        self.atoms.calc = SamplingCalculator(self, underlying)
        rng = self.rng = np.random.default_rng(self.request['seed'])
        MaxwellBoltzmannDistribution(self.atoms, temperature_K=temperature, rng=rng)
        self.integrator = self.integrator_factory(self.atoms, timestep=self.request['dtFs']*units.fs,
                                                  temperature_K=temperature, friction=self.request['frictionPerFs']/units.fs,
                                                  fixcm=False, rng=rng, logfile=None)

    def frame(self, stage, temperature, candidate=False, **extra):
        self.check(); require(self.frame_count < self.request['maxFrames'], 'Retained frame budget exhausted', 'SAMPLING_FRAME_LIMIT')
        energy = float(self.atoms.get_potential_energy()); data = self.atoms.calc.results
        xyz = self.atoms.positions; velocities = self.atoms.get_velocities()*units.fs
        require(np.isfinite(xyz).all() and np.isfinite(velocities).all(), 'Nonfinite sampled coordinates/velocities')
        coordinates = copy.deepcopy(self.source['atoms'])
        for atom, row in zip(coordinates, xyz): atom.update(zip(('x', 'y', 'z'), map(float, row)))
        kinetic = float(self.atoms.get_kinetic_energy()); actual_temperature = float(self.atoms.get_temperature())
        require(finite(energy) and finite(kinetic, 0) and finite(actual_temperature, 0), 'Nonfinite sampled state')
        diagnostics = copy.deepcopy(data['diagnostics'])
        residual = max([abs(float(np.linalg.norm(xyz[a]-xyz[b]))-length) for (a,b),length in zip(self.shake_pairs,self.shake_lengths)],default=0.)
        require(residual <= 1e-6, 'SHAKE X-H length constraint was not satisfied', 'SAMPLING_SHAKE_DRIFT')
        diagnostics['shake'] = dict(enabled=self.request['shakeHydrogenBonds'],hydrogenBondCount=len(self.shake_pairs),maxBondResidualAngstrom=residual,algorithm='ASE-RATTLE')
        value = dict(kind='frame', stageId=stage, collectionId='sampled-candidates' if candidate else 'sampling-trajectory',
                     driver='ase-langevin',
                     frameIndex=self.frame_count, role='sampled-candidate' if candidate else 'trajectory', step=self.step,
                     timeFs=self.step*self.request['dtFs'], coordinates=coordinates, velocitiesAngstromPerFs=velocities.tolist(),
                     physicalEnergyEV=data['physicalEnergyEV'], coreBiasEV=data['coreBiasEV'], metaBiasEV=data['metaBiasEV'], sphereBiasEV=data['sphereBiasEV'],
                     sampledPotentialEV=energy, kineticEnergyEV=kinetic, temperatureK=actual_temperature, targetTemperatureK=temperature,
                     biasHistoryCount=len(self.bias.history), diagnostics=diagnostics,
                     requiresUnbiasedOptimization=candidate, optimizationPerformed=False,
                     units=dict(coordinates='angstrom', velocity='angstrom/fs', energy='eV', time='fs', temperature='K'), **extra)
        if 'calculatorEvidence' in data: value['calculatorEvidence'] = copy.deepcopy(data['calculatorEvidence'])
        self.frame_count += 1
        if candidate: self.candidate_count += 1
        self.last_frame = copy.deepcopy(value); self.emit(value); return value

    def advance(self, temperature):
        self.check(); require(self.step < self.request['maxSteps'], 'MD step budget exhausted', 'SAMPLING_STEP_LIMIT')
        self.integrator.set_temperature(temperature_K=temperature)
        self.integrator.run(1); self.step += 1; self.check()

    def stage(self, stage_id, status, **data):
        if self.audit_enabled and self.atoms is not None:
            self.audit('stage-boundary', stageId=stage_id, status=status,
                       coordinatesAngstrom=self.atoms.positions.tolist(),
                       velocitiesAngstromPerFs=(self.atoms.get_velocities()*units.fs).tolist(),
                       integratorId=id(self.integrator), rngId=id(self.rng),
                       rngStateSha256=hashlib.sha256(json.dumps(self.rng.bit_generator.state,sort_keys=True,separators=(',',':')).encode()).hexdigest())
        self.emit(dict(kind='stage', stageId=stage_id, status=status, step=self.step, **data))

    def audit(self, kind, **data):
        # Test-local opt-in observes already used values; it requests no energy,
        # force, integration or RNG draw and never joins user scientific output.
        if self.audit_enabled:
            sys.stderr.write(json.dumps(dict(samplingAudit=kind,step=self.step,**data),allow_nan=False,separators=(',',':'))+'\n')
            sys.stderr.flush()

    def native_closed(self):
        process = getattr(self.native_calculator, 'current', None)
        return process is None or process.poll() is not None

    def run(self):
        self.check(); op = self.request['operation']
        settings = self.request['annealing'] if op == 'anneal' else self.request['metadynamics'] if op == 'metadynamics' else self.request['molecularMD'] if op == 'md' else self.request['sphericalMD']
        initial_temperature = settings['lowTemperatureK'] if op == 'anneal' else settings['temperatureK']
        self.start(initial_temperature)
        self.stage('sampling', 'started', configuration=copy.deepcopy(self.request), seed=self.request['seed'],
                   integration=dict(driver='ASE-Langevin', aseVersion=ase_version, fixcm=False, dtFs=self.request['dtFs'], frictionPerFs=self.request['frictionPerFs'],shakeHydrogenBonds=self.request['shakeHydrogenBonds'],constraintAlgorithm='ASE-RATTLE',hydrogenMassAmu=self.request.get('hydrogenMassAmu'),hydrogenMassMode='fixed-amu' if self.request.get('hydrogenMassAmu') is not None else 'natural'),
                   coordinateTransform=dict(kind='identity', offsetAngstrom=[0, 0, 0]))
        if op == 'anneal':
            low, high = settings['lowTemperatureK'], settings['highTemperatureK']
            segments = annealing_segments(settings)
            for cycle in range(settings['cycles']):
                for name, duration, start, end in segments:
                    stage = f'cycle-{cycle+1}-{name}'; count = step_count(duration, self.request['dtFs'], True)
                    self.stage(stage, 'started', cycleIndex=cycle, steps=count, startTemperatureK=start, endTemperatureK=end)
                    for index in range(count):
                        temperature = start+(end-start)*(index+1)/count; self.advance(temperature)
                        if self.step % self.request['reportEvery'] == 0: self.frame(stage, temperature, cycleIndex=cycle)
                    self.stage(stage, 'completed', cycleIndex=cycle, skipped=count == 0)
                self.frame(f'cycle-{cycle+1}-end', low, candidate=True, cycleIndex=cycle)
        else:
            count = step_count(settings['durationFs'], self.request['dtFs']); interval = step_count(settings['sampleEveryFs'], self.request['dtFs'])
            temperature = settings['temperatureK']
            if op == 'metadynamics':
                self.emit(dict(kind='bias', stageId='metadynamics', historyEntry=self.bias.deposit(self.atoms.positions, 0)))
                deposit = step_count(settings['depositEveryFs'], self.request['dtFs'])
            for index in range(1, count+1):
                self.advance(temperature)
                if op == 'metadynamics' and index % deposit == 0:
                    self.emit(dict(kind='bias', stageId='metadynamics', historyEntry=self.bias.deposit(self.atoms.positions, self.step)))
                    self.atoms.calc.reset()  # New bias requires refresh at unchanged physical coordinates.
                if index % interval == 0 or index == count: self.frame(op, temperature, candidate=True)
                elif self.step % self.request['reportEvery'] == 0: self.frame(op, temperature)
        self.stage('sampling', 'completed', candidates=self.candidate_count)
        return dict(kind='completed', workerSettled=True, samplingCompleted=True, optimizationPerformed=False,
                    requiresUnbiasedOptimization=True, candidateCount=self.candidate_count, frameCount=self.frame_count,
                    step=self.step, evaluations=self.evaluations, evaluationCountSource='observed-physical-calculator',driver='ase-langevin',seed=self.request['seed'], lastFrame=self.last_frame,
                    biasHistory=copy.deepcopy(self.bias.history), postSamplingPotentials=dict(core=False, metadynamics=False, sphere=False), nativeClosed=self.native_closed())


def main():
    session = None; payload = None; request_validated = False; seq = 0; output_bytes = 0; cancelled = threading.Event(); reader_done = threading.Event()
    def emit(value):
        nonlocal seq, output_bytes
        request = payload['request']
        packet = dict(schema=1, sessionId=payload['sessionId'], stamp=request['stamp'], runIdentity=request['runIdentity'],
                      operation=request['operation'], method=request['method'], seq=seq, **(sampling_segment_event(value, request) if request_validated else value))
        # JSONEncoder streams each atomic event; the host validates complete
        # NDJSON frames and applies only an explicit scientific output budget.
        json.dump(packet, sys.stdout, allow_nan=False, separators=(',', ':'))
        sys.stdout.write('\n'); sys.stdout.flush(); seq += 1
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
        needs_native = payload['request']['driver'] == 'native-xtb-md' or payload['request']['method'] in ('gfnff','gfn0')
        envelope_keys = {'schema', 'sessionId', 'request', 'runtime', 'workspacePath'} if needs_native else {'schema', 'sessionId', 'request'}
        require(set(payload) == envelope_keys and payload['schema'] == 1 and identity(payload['sessionId']), 'Invalid sampling envelope')
        threading.Thread(target=controls, args=(pending,), daemon=True).start()
        native_context = dict(runtime=payload['runtime'], workspacePath=payload['workspacePath'],memoryBudgetBytes=payload['request'].get('memoryBudgetBytes')) if needs_native else None
        if payload['request']['driver'] == 'native-xtb-md':
            from conformer_native_md import NativeMDSession
            started = time.monotonic()
            def check_native():
                if cancelled.is_set(): raise Cancelled('SAMPLING_CANCELLED','Sampling stopped; complete candidates remain separate')
                limit = payload['request'].get('maxWallTimeSeconds')
                require(limit is None or time.monotonic()-started<=limit,'Sampling walltime budget exhausted','SAMPLING_WALLTIME')
            check_native()
            session = NativeMDSession(payload['request'],dict(native_context,emit=emit,check=check_native,cancelled=cancelled))
        else:
            session = Session(payload['request'], emit, cancelled=cancelled, native_context=native_context)
        emit(session.run()); return 0
    except Exception as exc:
        if isinstance(payload, dict) and isinstance(payload.get('request'), dict) and all(k in payload['request'] for k in ('stamp', 'runIdentity', 'operation', 'method')):
            observations = ({'nativeTemperatureObservations': copy.deepcopy(session.native_temperature_observations)}
                            if session is not None and hasattr(session, 'native_temperature_observations') else {})
            if isinstance(exc, Cancelled) or getattr(exc,'code',None)=='SAMPLING_CANCELLED': emit(dict(kind='stopped', workerSettled=True, reason='cancelled', lastFrame=session.last_frame if session else None, nativeClosed=session.native_closed() if session else True, **observations))
            else: emit(dict(kind='error', workerSettled=True, error=dict(code=getattr(exc, 'code', 'SAMPLING_FAILED'), message=str(exc)[:8192]), lastFrame=session.last_frame if session else None, nativeClosed=session.native_closed() if session else True, **observations))
        return 0 if isinstance(exc, Cancelled) or getattr(exc,'code',None)=='SAMPLING_CANCELLED' else 1
    finally:
        reader_done.set()


if __name__ == '__main__':
    raise SystemExit(main())
