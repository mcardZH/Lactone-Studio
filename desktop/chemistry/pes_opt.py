"""Ordinary minimization on the shared physical E/G and exact constraint space."""

from contextlib import ExitStack
from importlib.metadata import version
import math

import numpy as np

from pes_coordinates import CoordinateError
from pes_core import BOHR_ANGSTROM, HARTREE_EV, PesCancelled, PesError, frame, require
from pes_scan_ts import (ase_atoms, attach_constraints, bounded_move, constraint_valid,
                         convergence, error_details, positive,
                         recoverable_geometry_error, sella_optimizer)


OPT_PRESETS = {
    'loose': (5e-5, 4e-3),
    'normal': (5e-6, 1e-3),
    'tight': (1e-6, 8e-4),
}


def optimization_limits(parameters):
    preset = parameters.get('convergencePreset', 'loose')
    preset = 'normal' if preset == 'medium' else preset
    require(preset in OPT_PRESETS or preset == 'custom', 'Unknown OPT convergence preset')
    defaults = dict(zip(('energyDifferenceHartree', 'gradientNormHartreePerBohr'),
                        OPT_PRESETS['loose' if preset == 'custom' else preset]))
    if preset == 'custom':
        return {key: positive(parameters, key, value) for key, value in defaults.items()}
    return defaults


class ProjectedLBFGS:
    """L-BFGS with secants transported to the current tangent and a retracted line search."""

    def __init__(self, ctx, space, maximum, *, initial_inverse=None):
        self.ctx = ctx
        self.space = space
        self.maximum = maximum
        self.history = []
        self.initial_inverse = initial_inverse

    def direction(self, positions, gradient):
        pairs = []
        for displacement, difference in self.history:
            tangent_step = self.space.project_vector(positions, displacement)
            tangent_delta = self.space.project_vector(positions, difference)
            curvature = float(np.vdot(tangent_step, tangent_delta))
            if curvature > 1e-12 * np.linalg.norm(tangent_step) * np.linalg.norm(tangent_delta):
                pairs.append((tangent_step, tangent_delta, curvature))
        vector = gradient.copy()
        coefficients = []
        for step, delta, curvature in reversed(pairs):
            coefficient = float(np.vdot(step, vector)) / curvature
            vector -= coefficient * delta
            coefficients.append(coefficient)
        # ASE's ordinary LBFGS uses a 70 eV/Å² initial curvature.
        if self.initial_inverse is not None:
            vector = self.space.project_vector(positions, self.initial_inverse(positions, vector))
        elif pairs:
            _, delta, curvature = pairs[-1]
            vector *= curvature / float(np.vdot(delta, delta))
        else:
            vector *= HARTREE_EV / (70. * BOHR_ANGSTROM)
        for (step, delta, curvature), coefficient in zip(pairs, reversed(coefficients)):
            vector += step * (coefficient - float(np.vdot(delta, vector)) / curvature)
        return -vector

    def step(self, positions, raw):
        gradient = self.space.project_vector(positions, raw['gradientHartreePerBohr'])
        displacement = self.direction(positions, gradient)
        if np.vdot(gradient, displacement) >= 0.:
            self.history.clear()
            displacement = -gradient * HARTREE_EV / (70. * BOHR_ANGSTROM)
        length = float(np.linalg.norm(displacement, axis=1).max())
        if length == 0.:
            return positions, raw
        displacement *= min(1., self.maximum / length)
        factor = 1.
        for _ in range(25):
            self.ctx.check_cancelled()
            try:
                trial = bounded_move(self.space, positions, positions + factor * displacement, self.maximum)
            except CoordinateError:
                factor *= .5
                continue
            step = trial - positions
            descent = float(np.vdot(gradient, step)) / BOHR_ANGSTROM
            if descent >= 0.:
                factor *= .5
                continue
            try:
                evaluated = self.ctx.evaluate(trial)
            except PesError as error:
                if not recoverable_geometry_error(error):
                    raise
                factor *= .5
                continue
            if evaluated['energyHartree'] <= raw['energyHartree'] + 1e-4 * descent + 1e-13:
                delta = self.space.project_vector(trial, evaluated['gradientHartreePerBohr'] - gradient)
                self.history.append((step, delta))
                self.history = self.history[-10:]
                return trial, evaluated
            factor *= .5
        raise PesError('L-BFGS could not find a feasible descending step', 'PES_OPT_LINE_SEARCH')


def exp_inverse(atoms, space):
    from ase.constraints import FixAtoms
    from ase.optimize.precon import Exp

    atoms.set_constraint(FixAtoms(mask=space.frozen))
    # A fixed scale leaves every physical trial with the same chosen provider.
    preconditioner = Exp(A=3., mu=1., solver='direct', apply_cell=False)

    def apply(positions, gradient):
        atoms.positions = positions
        preconditioner.make_precon(atoms)
        return preconditioner.solve(gradient.ravel()).reshape(gradient.shape) * (HARTREE_EV / BOHR_ANGSTROM)

    return apply


def run(request, ctx):
    parameters = request.get('parameters', {})
    algorithm = request['algorithm']
    require(algorithm in ('lbfgs', 'precon-exp', 'fire2', 'sella-xyz', 'sella-ric'), 'Unsupported ordinary optimization algorithm')
    lbfgs = algorithm in ('lbfgs', 'precon-exp')
    cell = request['structure'].get('cell')
    max_steps = positive(parameters, 'maxSteps', 1000 if cell else 500, integer=True)
    maximum = positive(parameters, 'maxStepAngstrom', .1)
    limits = optimization_limits(parameters)
    space = ctx.constraints
    final_only = parameters.get('batchFinalOnly') is True
    positions = space.project(ctx.initial)
    raw = ctx.evaluate(positions)
    coordinate_system = 'ric' if algorithm == 'sella-ric' else 'xyz'
    metadata = dict(name=algorithm, coordinateSystem=coordinate_system, maximumSteps=max_steps,
                    maxStepAngstrom=maximum, limits=limits, terminationReason='step-limit')
    if cell:
        metadata['fixedCellAngstrom'] = cell['vectors']
    frames = []

    def create_optimizer(resources, radius):
        atoms = ase_atoms(ctx, positions)
        if algorithm == 'fire2':
            from ase.optimize import FIRE2
            attach_constraints(atoms, space, radius)
            optimizer = FIRE2(atoms, logfile=None, maxstep=radius)
            resources.callback(optimizer.close)
            metadata['version'] = version('ase')
        else:
            optimizer = resources.enter_context(sella_optimizer(ctx, atoms, 'qn', 'auto', radius,
                space=space, coordinate_system=coordinate_system, order=0, modern=True))
            metadata.update(version=version('sella'), order=0)
        return atoms, optimizer

    radius = maximum
    with ExitStack() as resources:
        if lbfgs:
            inverse = None
            if algorithm == 'precon-exp':
                inverse = exp_inverse(ase_atoms(ctx, positions), space)
                metadata.update(version=version('ase'), preconditioner=dict(name='Exp', A=3., mu=1.))
            optimizer = ProjectedLBFGS(ctx, space, maximum, initial_inverse=inverse)
        else:
            atoms, optimizer = create_optimizer(resources, radius)
        displacement = positions - ctx.initial
        previous_energy = None
        status = 'not-converged'
        for index in range(max_steps + 1):
            ctx.check_cancelled()
            require(constraint_valid(space, positions), 'Optimization geometry violated its exact restraints')
            metrics = convergence(positions, raw['gradientHartreePerBohr'], space, displacement)
            if previous_energy is not None:
                metrics['energyDifferenceHartree'] = abs(raw['energyHartree'] - previous_energy)
            gradient_norm = metrics['gradientNormHartreePerBohr']
            energy_difference = metrics.get('energyDifferenceHartree', math.inf)
            if gradient_norm == 0. and energy_difference > limits['energyDifferenceHartree']:
                # Verify the stationary geometry without overwriting the last accepted step's energy difference.
                verified = ctx.evaluate(positions)
                energy_difference = abs(verified['energyHartree'] - raw['energyHartree'])
                metrics['stationaryEnergyVerificationHartree'] = energy_difference
            done = (metrics['constraintsSatisfied']
                    and energy_difference <= limits['energyDifferenceHartree']
                    and gradient_norm <= limits['gradientNormHartreePerBohr'])
            item = frame(request, positions, raw['energyHartree'], index, 'opt', 'opt',
                         'converged' if done else 'accepted', converged=done, convergence=metrics)
            if done and parameters.get('rebuildBonds') and not cell and request['method'] == 'gfn2':
                try:
                    bond_data = ctx.evaluate(positions, need_bond_orders=True)
                    item['bondOrders'] = bond_data['bondOrders']
                    if 'bondOrderMissingPairUpperBound' in bond_data:
                        item['bondOrderMissingPairUpperBound'] = bond_data['bondOrderMissingPairUpperBound']
                except PesCancelled:
                    raise
                except PesError as error:
                    metadata['bondOrderWarning'] = error_details(error)
            if final_only:
                frames[:] = [item]
            else:
                frames.append(item)
                ctx.emit('frame', item)
                ctx.emit('progress', dict(stage='opt', completed=index, total=max_steps))
            if done:
                status = 'completed'
                metadata['terminationReason'] = 'converged'
                break
            if index == max_steps:
                break
            before = positions
            before_energy = raw['energyHartree']
            if lbfgs:
                try:
                    positions, raw = optimizer.step(positions, raw)
                except PesError as error:
                    if error.code != 'PES_OPT_LINE_SEARCH':
                        raise
                    metadata.update(terminationReason='no-feasible-step', lastTrialError=error_details(error))
                    break
            else:
                for retry in range(25):
                    ctx.check_cancelled()
                    if retry:
                        atoms, optimizer = create_optimizer(resources, radius)
                    try:
                        optimizer.step()
                        trial = atoms.positions.copy()
                        if not np.isfinite(trial).all() or not constraint_valid(space, trial):
                            raise CoordinateError('Optimization proposal violated its exact restraints')
                        evaluated = ctx.evaluate(trial)
                    except (CoordinateError, PesError) as error:
                        if not recoverable_geometry_error(error):
                            raise
                        # The step may already have mutated the integrator and
                        # geometry. Rebuild from the last valid accepted point.
                        resources.close()
                        radius *= .5
                        metadata['rejectedTrials'] = metadata.get('rejectedTrials', 0) + 1
                        metadata['lastTrialError'] = error_details(error)
                    else:
                        optimizer.nsteps += 1
                        positions, raw = trial, evaluated
                        break
                else:
                    metadata['terminationReason'] = 'no-feasible-step'
                    break
            displacement = positions - before
            if not np.any(displacement):
                metadata['terminationReason'] = 'no-feasible-step'
                break
            previous_energy = before_energy
    return dict(status=status, frames=frames, series=[dict(id='opt', kind='opt')],
                provenance=dict(optimizer=metadata, acceptedSteps=frames[-1]['step'], convergence=metrics,
                                convergenceCriterion='accepted-energy-difference-and-projected-gradient-norm',
                                convergenceThresholds=limits))
