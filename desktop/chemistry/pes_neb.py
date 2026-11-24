"""Cartesian CI-NEB with stable physical nodes and observed force criteria.

The caller owns S-IDPP preparation and whole-round persistence. Each calculator
owns one stable electronic node; geometry optimizers update the coupled band.
"""
from __future__ import annotations

import math

import numpy as np
from ase import Atoms, __version__ as ase_version
from ase.calculators.calculator import Calculator, all_changes
from ase.mep import NEB
from ase.mep.neb import ImprovedTangentMethod
from ase.optimize import FIRE, LBFGS
from ase.optimize.fire2 import FIRE2

from pes_coordinates import CoordinateError
from pes_core import BOHR_ANGSTROM, HARTREE_EV, PesError


EV_PER_ANGSTROM = HARTREE_EV / BOHR_ANGSTROM
PRESETS = {
    'loose': (.020, .010, .002, .001),
    'medium': (.005, .0025, .0005, .00025),
    'normal': (.005, .0025, .0005, .00025),
    'tight': (.001, .0005, .0001, .00005),
}


class NebInputError(PesError):
    pass


def _positive(options, name, default):
    value = options.get(name, default)
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or value <= 0:
        raise NebInputError(f'{name} requires a positive finite value')
    return float(value)


def neb_settings(options):
    """New profiles use four independent criteria; old explicit scales survive."""
    profile = options.get('executionProfile')
    if profile not in (None, 'pes-v222'):
        raise NebInputError('Unsupported CI-NEB execution profile')
    modern = profile == 'pes-v222'
    unified = options.get('policyVersion') == 'v212'
    optimizer = options.get('nebOptimizer', 'fire2' if modern else 'fire')
    allowed = ('fire2', 'lbfgs') if unified else ('fire', 'fire2', 'lbfgs')
    if not isinstance(optimizer, str) or optimizer.lower() not in allowed:
        raise NebInputError('Unsupported CI-NEB geometry optimizer')
    if options.get('coordinateSystem', 'xyz') != 'xyz':
        raise NebInputError('CI-NEB requires Cartesian XYZ coordinates')
    maximum = options.get('nebIterations', 1000)
    if type(maximum) is not int or maximum < 1:
        raise NebInputError('nebIterations requires a positive integer')
    preset = options.get('nebConvergencePreset', 'loose' if modern else 'legacy-explicit')
    if modern and preset not in (*PRESETS, 'custom'):
        raise NebInputError('Unknown CI-NEB convergence preset')
    defaults = PRESETS.get(preset, PRESETS['loose']) if modern else (.001, .0005, .0005, .00025)
    fields = ('nebMaxForce', 'nebRmsForce', 'ciMaxForce', 'ciRmsForce')
    if modern and preset == 'custom' and any(key not in options for key in fields):
        raise NebInputError('Custom CI-NEB convergence requires all four force thresholds')
    normal_max, normal_rms, ci_max, ci_rms = (defaults if unified and preset != 'custom' else
        [_positive(options, key, default) for key, default in zip(fields, defaults)])
    scale = _positive(options, 'ciToleranceScale', 10.) if not modern else None
    return dict(profile=profile, modern=modern, optimizer=optimizer.lower(), preset=preset,
                maximum=maximum, normal_max=normal_max, normal_rms=normal_rms,
                ci_max=ci_max, ci_rms=ci_rms, scale=scale,
                final_normal_max=normal_max if modern else ci_max * scale,
                final_normal_rms=normal_rms if modern else ci_rms * scale,
                trigger=_positive(options, 'ciTriggerForce', .2),
                spring=_positive(options, 'springConstantEvAngstrom2', .1),
                step=_positive(options, 'nebComponentStepAngstrom', .1))


def _bounded_project(space, base, displacement, limit):
    proposed = float(np.max(np.abs(displacement)))
    fraction = min(1., limit / proposed) if proposed else 1.
    while fraction >= np.finfo(float).eps:
        try:
            trial = space.project(base + fraction * displacement)
        except CoordinateError:
            fraction *= .5
            continue
        if np.max(np.abs(trial - base)) <= limit + 1e-12:
            return trial
        fraction *= .5
    raise NebInputError('Could not retract the NEB step inside its Cartesian component bounds')


class PhysicalNodeCalculator(Calculator):
    implemented_properties = ['energy', 'forces']

    def __init__(self, ctx, node_id):
        super().__init__()
        self.ctx, self.node_id = ctx, node_id
        self.energy_hartree = None
        self.evaluated_positions = None
        self.active_dofs = None

    def calculate(self, atoms=None, properties=('energy', 'forces'), system_changes=all_changes):
        super().calculate(atoms, properties, system_changes)
        # A failed native evaluation cannot re-sign the previous energy with
        # Calculator.calculate()'s newly assigned atoms/positions.
        self.energy_hartree = self.evaluated_positions = self.active_dofs = None
        xyz = atoms.get_positions()
        value = self.ctx.evaluate(xyz, node_id=self.node_id)
        force = -value['gradientHartreePerBohr'] * EV_PER_ANGSTROM
        force, self.active_dofs = self.ctx.constraints.project_vector(xyz, force, return_dof=True)
        self.results = {'energy': value['energyHartree'] * HARTREE_EV,
                        'forces': force}
        self.energy_hartree = value['energyHartree']
        self.evaluated_positions = xyz.copy()


class ConstrainedTangent(ImprovedTangentMethod):
    def __init__(self, neb, space):
        super().__init__(neb)
        self.space, self.tangents = space, {}

    def get_tangent(self, state, spring1, spring2, i):
        tangent = super().get_tangent(state, spring1, spring2, i)
        if np.linalg.norm(tangent) <= 1e-12:
            tangent = spring1.t + spring2.t
        tangent = self.space.project_vector(state.images[i].positions, tangent)
        length = float(np.linalg.norm(tangent))
        if not math.isfinite(length) or length <= 1e-12:
            raise NebInputError('NEB tangent vanished in the allowed Cartesian space')
        self.tangents[i] = tangent / length
        return self.tangents[i]


class BoundedBand(NEB):
    def __init__(self, images, space, spring=.1, component_step=.1):
        super().__init__(images, k=spring, climb=False, method='improvedtangent', parallel=False)
        self.neb_method = ConstrainedTangent(self, space)
        self.space, self.component_step = space, component_step
        self.largest_step, self.last_effective, self.step_origin = 0., None, None

    def begin_step(self):
        # FIRE2 may backtrack and evaluate more than once in one update. All
        # proposals are bounded against this same accepted outer-step origin.
        self.step_origin = self.get_positions().reshape(-1, self.natoms, 3).copy()

    def finish_step(self):
        displacement = self.get_positions().reshape(-1, self.natoms, 3) - self.step_origin
        self.largest_step = max(self.largest_step, float(np.max(np.abs(displacement))))
        self.step_origin = None

    def set_positions(self, positions, adjust_positions=True):
        proposals = np.asarray(positions).reshape(-1, self.natoms, 3)
        bases = self.step_origin if self.step_origin is not None else [image.positions for image in self.images[1:-1]]
        updates = [_bounded_project(self.space, base, proposal - base, self.component_step)
                   for base, proposal in zip(bases, proposals)]
        # The bundled ASE NEB derives through DyNEB, whose public setter does
        # not expose BaseNEB's adjust_positions keyword.
        super().set_positions(np.concatenate(updates))
        self.last_effective = None

    def get_forces(self):
        if self.last_effective is None:
            forces = super().get_forces().reshape(-1, self.natoms, 3)
            self.last_effective = np.concatenate([self.space.project_vector(image.positions, force)
                                                for image, force in zip(self.images[1:-1], forces)])
        return self.last_effective.copy()

    def activate_climbing(self):
        self.climb, self.last_effective, self.step_origin = True, None, None


class BandLBFGS(LBFGS):
    """ASE L-BFGS on the coupled NEB force field, with safe curvature resets."""

    def update(self, pos, forces, r0, f0):
        if self.iteration > 0:
            step, delta = pos - r0, f0 - forces
            curvature = float(np.dot(step, delta))
            if not math.isfinite(curvature) or curvature <= 1e-12 * np.linalg.norm(step) * np.linalg.norm(delta):
                # A stationary or nonpositive secant carries no usable
                # inverse-curvature information for this projected force field.
                self.initialize()
        super().update(pos, forces, r0, f0)

    def determine_step(self, displacement):
        band = self.atoms
        blocks = np.asarray(displacement).reshape(-1, band.natoms, 3)
        projected = np.concatenate([band.space.project_vector(image.positions, block)
                                    for image, block in zip(band.images[1:-1], blocks)]).ravel()
        extent = float(np.max(np.abs(projected)))
        return projected * (band.component_step / extent) if extent > band.component_step else projected


def force_stats(force, dofs):
    values = np.asarray(force)
    if not values.size:
        return dict(maxHartreePerBohr=0., rmsHartreePerBohr=0., activeDofs=0)
    if dofs <= 0:
        raise NebInputError('NEB has no active Cartesian coordinates')
    return dict(maxHartreePerBohr=float(np.max(np.abs(values))) / EV_PER_ANGSTROM,
                rmsHartreePerBohr=float(np.linalg.norm(values)) / (EV_PER_ANGSTROM * math.sqrt(dofs)),
                activeDofs=int(dofs))


def neb_state(band):
    effective = band.get_forces().reshape(-1, band.natoms, 3)
    statistics, perpendiculars, dofs = {}, {}, {}
    for i, image in enumerate(band.images[1:-1], 1):
        physical, tangent = band.real_forces[i], band.neb_method.tangents[i]
        perpendicular = physical - np.vdot(physical, tangent) * tangent
        dofs[i] = getattr(image.calc, 'active_dofs', None)
        if dofs[i] is None:
            _, dofs[i] = band.space.project_vector(image.positions, physical, return_dof=True)
        perpendiculars[i] = perpendicular
        statistics[i] = dict(physicalForce=force_stats(physical, dofs[i]),
                             perpendicularForce=force_stats(perpendicular, dofs[i]),
                             effectiveForce=force_stats(effective[i - 1], dofs[i]))
    normal = [i for i in statistics if not band.climb or i != band.imax]
    pool = force_stats([perpendiculars[i] for i in normal], sum(dofs[i] for i in normal))
    trigger = max(row['perpendicularForce']['maxHartreePerBohr'] for row in statistics.values())
    return statistics, pool, trigger


def _within(stats, maximum, rms):
    return stats['maxHartreePerBohr'] <= maximum and stats['rmsHartreePerBohr'] <= rms


def make_optimizer(name, band):
    optimizer = {'fire': FIRE, 'fire2': FIRE2, 'lbfgs': BandLBFGS}[name]
    if name == 'lbfgs':
        # NEB forces include perpendicular and spring terms. A line search
        # on the physical image energies would optimize the wrong objective.
        return optimizer(band, logfile=None, use_line_search=False)
    limit = band.component_step * math.sqrt(3 * band.natoms * (band.nimages - 2))
    return optimizer(band, logfile=None, maxstep=limit)


def run_ci_neb(reference, symbols, ctx, options, result):
    settings = neb_settings(options)
    metadata = result.provenance
    label = settings['optimizer'].upper()
    metadata.update(driver=f'ASE NEB/{label}', optimizer=label, aseVersion=ase_version,
                    tangent='improvedtangent', coordinateSystem='xyz',
                    executionProfile=settings['profile'], convergencePreset=settings['preset'],
                    forceUnit='hartree/bohr', maximumIterations=settings['maximum'],
                    springConstantEvAngstrom2=settings['spring'], maximumComponentStepAngstrom=settings['step'],
                    thresholdsHartreePerBohr=dict(normalMax=settings['normal_max'], normalRms=settings['normal_rms'],
                                                 climbMax=settings['ci_max'], climbRms=settings['ci_rms'],
                                                 climbNormalMax=settings['final_normal_max'], climbNormalRms=settings['final_normal_rms'],
                                                 climbTrigger=settings['trigger']),
                    normalForceScope='all-non-climbing-internal-components' if settings['modern'] else 'per-image-legacy',
                    ordinaryIterations=0, climbingIterations=0, totalIterations=0,
                    optimizerResets=0, largestAcceptedComponentStepAngstrom=0.)
    if settings['scale'] is not None:
        metadata['thresholdsHartreePerBohr']['climbNormalNodeScale'] = settings['scale']
    # The band uses continuous anchored Cartesian images for its springs.
    # Each physical calculator still evaluates the request's fixed cell.
    images = [Atoms(symbols, positions=xyz, pbc=False) for xyz in reference]
    node_ids = [f'ci-neb:bead:{i}' for i in range(len(images))]
    for image, node_id in zip(images, node_ids):
        image.calc = PhysicalNodeCalculator(ctx, node_id)
    metadata['physicalNodeIds'] = node_ids
    band = BoundedBand(images, ctx.constraints, settings['spring'], settings['step'])
    optimizer, completed = make_optimizer(settings['optimizer'], band), 0
    lbfgs_climbing_bead = None
    try:
        while True:
            ctx.check_cancelled()
            try:
                statistics, pool, trigger = neb_state(band)
            except Exception:
                # A dependent band step needs all forces. Keep independently
                # verified E/G from the interrupted step as a separate snapshot.
                partial = {}
                for i, image in enumerate(images):
                    calculator = image.calc
                    if (calculator.energy_hartree is not None and calculator.evaluated_positions is not None
                            and np.array_equal(calculator.evaluated_positions, image.positions)):
                        partial[i] = (image.positions.copy(), calculator.energy_hartree, completed, {})
                phase = 'ci-neb-climb' if band.climb else 'ci-neb-ordinary'
                result.remember_partial(partial, phase + '-interrupted')
                raise
            internal_barrier = bool(band.emax > max(band.energies[0], band.energies[-1]))
            if not band.climb:
                ordinary_ready = (_within(pool, settings['normal_max'], settings['normal_rms']) if settings['modern'] else
                                  all(_within(row['perpendicularForce'], settings['normal_max'], settings['normal_rms'])
                                      for row in statistics.values()))
                metadata['ordinaryCriteriaMetAtLastCheck'] = ordinary_ready
                if trigger < settings['trigger'] and internal_barrier:
                    metadata['climbActivation'] = dict(iteration=completed, nextUpdateIteration=completed + 1,
                                                       maximumPerpendicularForceHartreePerBohr=trigger,
                                                       bead=int(band.imax) + 1, nodeId=node_ids[band.imax])
                    band.activate_climbing()
                    optimizer.close()
                    optimizer = make_optimizer(settings['optimizer'], band)
                    metadata['optimizerResets'] += 1
                    # Reproject cached physical E/G into CI forces at the same
                    # geometry. Record this physical round once, not twice.
                    continue
            phase = 'ci-neb-climb' if band.climb else 'ci-neb-ordinary'
            if band.climb and settings['optimizer'] == 'lbfgs':
                if lbfgs_climbing_bead is not None and band.imax != lbfgs_climbing_bead:
                    optimizer.initialize()
                    metadata['optimizerResets'] += 1
                lbfgs_climbing_bead = band.imax
            state = {i: (image.positions.copy(), image.calc.energy_hartree, completed,
                         {**statistics.get(i, {}), **({'climbingImage': True} if band.climb and i == band.imax else {})})
                     for i, image in enumerate(images)}
            result.remember_band(state, phase)
            metadata['lastNormalPerpendicularForce'] = pool
            metadata['largestAcceptedComponentStepAngstrom'] = band.largest_step
            metadata['hasInternalBarrier'] = internal_barrier
            if band.climb:
                ci_ready = _within(statistics[band.imax]['physicalForce'], settings['ci_max'], settings['ci_rms'])
                normal_ready = (_within(pool, settings['final_normal_max'], settings['final_normal_rms']) if settings['modern'] else
                                all(_within(row['perpendicularForce'], settings['final_normal_max'], settings['final_normal_rms'])
                                    for i, row in statistics.items() if i != band.imax))
                if ci_ready and normal_ready:
                    metadata['completionReason'] = 'climbing-image-and-normal-forces-converged'
                    return 'completed'
            elif not internal_barrier and ordinary_ready:
                metadata['completionReason'] = 'ordinary-path-converged-without-internal-barrier'
                return 'completed'
            if completed >= settings['maximum']:
                return 'not-converged'
            ctx.emit('progress', dict(phase=phase, completed=completed))
            ctx.check_cancelled()
            band.begin_step()
            optimizer.step()
            band.finish_step()
            completed += 1
            metadata['climbingIterations' if band.climb else 'ordinaryIterations'] += 1
            metadata['totalIterations'] = completed
    finally:
        optimizer.close()
        release = getattr(ctx, 'release_node', None)
        if release is not None:
            for node_id in node_ids:
                release(node_id)
