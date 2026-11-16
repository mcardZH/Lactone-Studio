"""Relaxed scans, transition-state optimization and physical finite-difference Hessians."""

from contextlib import ExitStack
from importlib.metadata import version
import math

import numpy as np
from scipy.constants import physical_constants, speed_of_light
from scipy.linalg import null_space, orth, qr
from scipy.optimize import minimize

from pes_coordinates import CentroidComponent, CoordinateError
from pes_core import BOHR_ANGSTROM, HARTREE_EV, PesCancelled, PesError, atom_numbers, frame, require


CONSTRAINT_TOLERANCE = 1e-7
DIFFERENCE_STEP_BOHR = .002
FORCE_LIMITS = dict(maxForceHartreePerBohr=.000450, rmsForceHartreePerBohr=.000300)
DISPLACEMENT_LIMITS = dict(maxDisplacementBohr=.001800, rmsDisplacementBohr=.001200)
SELLA_PROFILE = 'pes-v222'
SELLA_CMAX = 1e-5


def positive(parameters, key, default, integer=False):
    value = parameters.get(key, default)
    types = (int,) if integer else (float, int)
    require(type(value) in types and math.isfinite(value) and value > 0, f'{key} must be positive')
    return value


def error_details(error):
    return dict(code=getattr(error, 'code', 'PES_OPTIMIZATION_FAILED'), message=str(error),
                **({'diagnostics': error.diagnostics} if getattr(error, 'diagnostics', None) else {}))


def constraint_valid(space, positions):
    return (np.array_equal(positions[space.frozen], space.reference[space.frozen])
            and all(abs(value) <= CONSTRAINT_TOLERANCE for value in space.residuals(positions).values()))


def force_metrics(positions, gradient, space):
    projected, dof = space.project_vector(positions, gradient, return_dof=True)
    return dict(
        maxForceHartreePerBohr=float(np.max(np.abs(projected))),
        rmsForceHartreePerBohr=float(np.linalg.norm(projected) / math.sqrt(dof)) if dof else 0.0,
        maxAtomForceHartreePerBohr=float(np.linalg.norm(projected, axis=1).max()),
        effectiveDegreesOfFreedom=dof,
    )


def convergence(positions, gradient, space, displacement=None):
    result = force_metrics(positions, gradient, space)
    result['constraintResiduals'] = space.residuals(positions)
    result['constraintsSatisfied'] = constraint_valid(space, positions)
    if displacement is not None:
        move = np.asarray(displacement) / BOHR_ANGSTROM
        dof = result['effectiveDegreesOfFreedom']
        result.update(
            maxDisplacementBohr=float(np.max(np.abs(move))),
            rmsDisplacementBohr=float(np.linalg.norm(move) / math.sqrt(dof)) if dof else 0.0,
            maxAtomDisplacementBohr=float(np.linalg.norm(move, axis=1).max()),
        )
    return result


def meets_limits(metrics, limits):
    return metrics['constraintsSatisfied'] and all(metrics[key] <= value for key, value in limits.items())


def bounded_move(space, before, trial, maximum):
    step = trial - before
    length = np.linalg.norm(step, axis=1).max()
    if length == 0.0:
        return before.copy()
    factor = min(1., maximum / length)
    for _ in range(30):
        try:
            after = space.project(before + factor * step)
            if np.linalg.norm(after - before, axis=1).max() <= maximum * (1 + 1e-10):
                return after
        except CoordinateError:
            pass
        factor *= .5
    raise CoordinateError('Could not retract the trial step within the maximum atomic displacement')


def relax(positions, ctx, space, max_steps, limits=None, observe=None):
    """Run SLSQP on movable XYZ variables, preserving the last feasible E/G."""
    limits = limits or FORCE_LIMITS
    start = space.project(positions)
    initial = ctx.evaluate(start)
    best = [start, initial]

    def observe_candidate(x):
        ctx.check_cancelled()
        candidate = space.expand(x)
        if constraint_valid(space, candidate):
            raw = ctx.evaluate(candidate)
            best[:] = candidate, raw
            if observe:
                observe(candidate, raw)

    _, jacobian = space.equations_at(start)
    jacobian = jacobian[:, space.free]
    row_norms = np.linalg.norm(jacobian, axis=1)
    active = np.flatnonzero(row_norms > 1e-12)
    if len(active):
        _, _, pivots = qr((jacobian[active] / row_norms[active, None]).T, pivoting=True)
        rank = np.linalg.matrix_rank(jacobian[active] / row_norms[active, None])
        selected = active[pivots[:rank]]
    else:
        selected = np.empty(0, dtype=int)

    def objective(x):
        raw = ctx.evaluate(space.expand(x))
        return raw['energyHartree'], raw['gradientHartreePerBohr'].ravel()[space.free] / BOHR_ANGSTROM

    def equalities(x):
        return space.equations_at(space.expand(x))[0][selected] / row_norms[selected]

    def equalities_jacobian(x):
        return space.equations_at(space.expand(x))[1][selected][:, space.free] / row_norms[selected, None]

    def pack(final, raw, optimizer):
        metrics = convergence(final, raw['gradientHartreePerBohr'], space)
        return dict(positions=final, energyHartree=raw['energyHartree'], convergence=metrics,
                    converged=meets_limits(metrics, limits), optimizer=optimizer)

    if meets_limits(convergence(start, initial['gradientHartreePerBohr'], space), limits):
        return pack(start, initial, dict(steps=0, success=True, message='Initial geometry satisfies the thresholds'))
    optimization = None
    try:
        constraints = [dict(type='eq', fun=equalities, jac=equalities_jacobian)] if len(selected) else []
        target_accuracy = min(1e-11, (min(limits.values()) / BOHR_ANGSTROM)**2 * .001)
        optimization = minimize(objective, start.ravel()[space.free], jac=True, constraints=constraints,
                                method='SLSQP', callback=observe_candidate,
                                options=dict(maxiter=max_steps, ftol=target_accuracy))
        final = space.project(space.expand(optimization.x))
        best[:] = final, ctx.evaluate(final)
    except (CoordinateError, PesError) as error:
        if isinstance(error, PesCancelled):
            return dict(pack(*best, dict(steps=None, success=False, message=str(error))),
                        converged=False, stopped=True)
        if isinstance(error, PesError) and error.code not in ('PES_XTB_SCC', 'PES_XTB_GEOMETRY'):
            raise
        return dict(pack(*best, dict(steps=None, success=False, message=str(error))),
                    converged=False, warning=error_details(error))
    metadata = dict(steps=int(optimization.nit), success=bool(optimization.success), message=str(optimization.message))
    result = pack(*best, metadata)
    result['converged'] = result['converged'] and metadata['success']
    return result


def scan_sequence(axes):
    if len(axes) == 1:
        yield from ((i,) for i in range(len(axes[0])))
    else:
        for i in range(len(axes[0])):
            second = range(len(axes[1]))
            yield from ((i, j) for j in (reversed(second) if i % 2 else second))


def coordinate_parameter(parameters, coordinates, positions):
    expression = parameters.get('expression') or parameters.get('coordinateId')
    return coordinates.compile(expression, reference=positions)


def run_scan(request, ctx):
    parameters = request['parameters']
    modern = request['algorithm'] == 'sella-scan'
    require(request['algorithm'] in ('slsqp', 'sella-scan'), 'Unsupported SCAN optimizer')
    if modern:
        require(parameters.get('executionProfile') == SELLA_PROFILE, 'Sella SCAN requires the pes-v222 execution profile')
    coordinate_system = parameters.get('coordinateSystem', 'ric') if modern else 'xyz'
    require(coordinate_system in ('xyz', 'ric'), 'Unsupported Sella coordinate system')
    definitions = parameters.get('axes', ())
    require(len(definitions) in (1, 2), 'SCAN requires one or two axes')
    steps = positive(parameters, 'maxSteps', 200, integer=True)
    limits = ({'fmaxHartreePerBohr': positive(parameters, 'fmaxHartreePerBohr', .0025)} if modern else
              {key: positive(parameters, key, default) for key, default in FORCE_LIMITS.items()})
    previous = ctx.constraints.project(ctx.initial)
    expressions = [coordinate_parameter(axis, ctx.coordinates, previous) for axis in definitions]
    axes = []
    for axis, expression in zip(definitions, expressions):
        ctx.constraints.require_variable(expression, previous)
        start, end = axis.get('start', expression.value(previous)), axis.get('end')
        require(type(start) in (float, int) and type(end) in (float, int)
                and math.isfinite(start) and math.isfinite(end), 'SCAN requires finite endpoints')
        points = positive(axis, 'points', 11, integer=True)
        require(points >= 2, 'SCAN axes require at least two endpoint-inclusive points')
        require(start != end, 'SCAN axis endpoints must differ')
        require(not expression.periodic or abs(end - start) / (points - 1) < 180,
                'A dihedral scan needs adjacent targets separated by less than 180 degrees')
        axes.append(np.linspace(start, end, points))
    if len(axes) == 2:
        tangent = ctx.constraints.tangent(previous)
        jacobian = np.array([expression.gradient(previous).ravel() @ tangent for expression in expressions])
        require(np.linalg.matrix_rank(jacobian / np.linalg.norm(jacobian, axis=1)[:, None]) == 2,
                'SCAN axes must be independent in the available constraint space')

    frames, records = [], []
    def keep_point(record):
        records.append(record)
        ctx.emit('scan-point', record)
    terminal, failure = 'completed', None
    total = math.prod(len(axis) for axis in axes)
    ctx.emit('progress', dict(phase='scan', completed=0, total=total))
    for step, indices in enumerate(scan_sequence(axes)):
        targets = [float(axis[index]) for axis, index in zip(axes, indices)]
        record = dict(pointIndex=step, indices=list(indices), targets=targets, energyHartree=None, status='failed')
        try:
            ctx.check_cancelled()
            expressions = [expression.rebase(previous) for expression in expressions]
            equations = [(f'scan-axis-{i + 1}', expression, target)
                         for i, (expression, target) in enumerate(zip(expressions, targets))]
            space = ctx.constraints.with_equations(equations)
            def observe(_, __):
                ctx.emit('progress', dict(phase='scan', completed=step, total=total, pointIndex=step))
            if modern:
                result = relax_sella(previous, ctx, space, steps, limits['fmaxHartreePerBohr'], observe,
                                     coordinate_system=coordinate_system)
            else:
                result = relax(previous, ctx, space, steps, limits, observe)
            previous = result['positions']
            status = ('stopped' if result.get('stopped') else 'failed' if result.get('failed') else
                      'converged' if result['converged'] else 'unconverged')
            values = []
            for expression, target in zip(expressions, targets):
                value = expression.value(previous)
                if expression.periodic:
                    value = target + ((value - target + 180.) % 360. - 180.)
                values.append(value)
            point = frame(request, previous, result['energyHartree'], step, 'scan', 'scan', status,
                          converged=result['converged'], cv=values, cvTargets=targets, gridIndices=list(indices),
                          convergence=result['convergence'], optimizer=result['optimizer'])
            record.update(status=status, energyHartree=point['energyHartree'], actual=values, frameId=point['id'])
            if result.get('warning'):
                record['error' if result.get('failed') else 'warning'] = result['warning']
            if modern:
                record['terminationReason'] = result['optimizer']['terminationReason']
                record['optimizer'] = result['optimizer']
            frames.append(point)
            ctx.emit('frame', point)
            if result.get('stopped'):
                keep_point(record)
                terminal = 'stopped'
                break
        except PesCancelled:
            keep_point(dict(record, status='stopped'))
            terminal = 'stopped'
            break
        except CoordinateError as error:
            record['error'] = error_details(error)
        except PesError as error:
            record['error'] = error_details(error)
            if error.code not in ('PES_XTB_SCC', 'PES_XTB_GEOMETRY'):
                failure = record['error']
                keep_point(record)
                terminal = 'partial' if frames else 'failed'
                break
        keep_point(record)
        ctx.emit('progress', dict(phase='scan', completed=len(records), total=total))

    processed_records = list(records)
    for step, indices in enumerate(scan_sequence(axes)):
        if step >= len(records):
            keep_point(dict(pointIndex=step, indices=list(indices),
                            targets=[float(axis[index]) for axis, index in zip(axes, indices)],
                            energyHartree=None, status='missing'))
    if terminal == 'completed' and any(record['status'] != 'converged' for record in records):
        terminal = 'partial' if frames else 'failed'
    provenance = dict(ctx.provenance(), optimizer='sella' if modern else 'scipy-slsqp',
                      traversal='ascending-first-axis-and-serpentine-second-axis',
                      continuation='last-feasible-geometry', pointCount=total,
                      forceThresholds=limits, coordinateUnits=[expression.unit for expression in expressions])
    if modern:
        used = any(record.get('optimizer', {}).get('initialized', False) for record in processed_records)
        provenance['optimizer'] = 'sella' if used else 'none'
        provenance.update(executionProfile=SELLA_PROFILE, optimizerVersion=version('sella'), order=0,
                          requestedOptimizer='sella', optimizerInitialized=used,
                          optimizerStepCount=sum(record.get('optimizer', {}).get('steps', 0) for record in processed_records),
                          coordinateSystem=coordinate_system, maxStepsPerPoint=steps,
                          convergencePreset=parameters.get('convergencePreset', 'custom'),
                          convergenceCriterion='sella-max-atom-projected-force-and-exact-equalities',
                          nativeConstraintNormTolerance=SELLA_CMAX, nativeConstraintNormRole='diagnostic',
                          formalConstraintTolerance=CONSTRAINT_TOLERANCE,
                          constraintNormalization='one source unit per equation; fixed XYZ in angstrom')
    else:
        provenance['scipyVersion'] = version('scipy')
    return dict(frames=frames, series=[dict(id='scan', label='SCAN', frameIds=[row['id'] for row in frames])],
                points=processed_records, scanPoints=records, status=terminal, provenance=provenance,
                **({'error': failure} if failure else {}))


def physical_hessian(positions, ctx, phase, step=DIFFERENCE_STEP_BOHR):
    """Central differences of the unprojected physical gradient, in Eh/Bohr²."""
    geometry = np.asarray(positions, dtype=float)
    dimensions = geometry.size
    ctx.last_hessian = dict(derivativeMethod='central-unprojected-physical-gradient-difference',
                            displacementBohr=step, derivativeEvaluations=2 * dimensions,
                            nativeHessianCalls=0)
    provider = getattr(ctx, 'physical_hessian', None)
    if provider is not None:
        ctx.emit('progress', dict(phase=phase))
        result = provider(geometry, step)
        if result is not None:
            return result
    hessian = np.empty((dimensions, dimensions))
    delta = step * BOHR_ANGSTROM
    completed = 0
    ctx.emit('progress', dict(phase=phase, completed=completed, total=2 * dimensions))
    for column in range(dimensions):
        gradients = []
        for sign in (1., -1.):
            displaced = geometry.copy()
            displaced.flat[column] += sign * delta
            gradients.append(ctx.evaluate(displaced)['gradientHartreePerBohr'].ravel())
            completed += 1
            ctx.emit('progress', dict(phase=phase, completed=completed, total=2 * dimensions))
        hessian[:, column] = (gradients[0] - gradients[1]) / (2 * step)
    asymmetry = float(np.max(np.abs(hessian - hessian.T)))
    ctx.last_hessian['maximumRawAntisymmetryHartreePerBohr2'] = asymmetry
    return .5 * (hessian + hessian.T), asymmetry


def lagrangian_hessian(hessian, positions, gradient, space):
    """Remove the equality curvature from the physical Hessian before projection."""
    if not space.equations:
        return hessian
    _, jacobian = space.equations_at(positions)
    jacobian = jacobian[:, space.free] * BOHR_ANGSTROM
    multipliers = np.linalg.lstsq(jacobian.T, gradient.ravel()[space.free], rcond=None)[0]
    curvature = np.zeros_like(hessian)
    delta = DIFFERENCE_STEP_BOHR * BOHR_ANGSTROM
    for column in space.free:
        plus, minus = positions.copy(), positions.copy()
        plus.flat[column] += delta
        minus.flat[column] -= delta
        derivative = space.equations_at(plus)[1] - space.equations_at(minus)[1]
        curvature[:, column] = multipliers @ derivative * BOHR_ANGSTROM / (2 * DIFFERENCE_STEP_BOHR)
    return hessian - .5 * (curvature + curvature.T)


def vibrational_space(positions, masses, tangent):
    """Mass-weighted free tangent, with only allowed rigid motions removed."""
    mass_sqrt = np.repeat(np.sqrt(masses), 3)
    free = orth(mass_sqrt[:, None] * tangent)
    center = np.average(positions, axis=0, weights=masses)
    relative = positions - center
    motions = [np.broadcast_to(axis, positions.shape).ravel() for axis in np.eye(3)]
    motions.extend(np.cross(axis, relative).ravel() for axis in np.eye(3))
    rigid = orth(mass_sqrt[:, None] * np.array(motions).T)
    residual = rigid - free @ (free.T @ rigid)
    _, singular_values, vt = np.linalg.svd(residual, full_matrices=False)
    permitted = rigid @ vt[singular_values < 1e-9].T
    vibration = free @ null_space(permitted.T @ free, rcond=1e-9) if permitted.shape[1] else free
    return vibration / mass_sqrt[:, None], permitted.shape[1]


def harmonic_result(positions, raw, hessian, asymmetry, ctx, frame_id):
    from ase.data import atomic_masses
    space = ctx.constraints
    tangent = space.tangent(positions)
    lagrangian = lagrangian_hessian(hessian, positions, raw['gradientHartreePerBohr'], space)
    mass_basis, rigid_modes = vibrational_space(positions, atomic_masses[atom_numbers(ctx.request)], tangent)
    weighted = mass_basis.T @ lagrangian @ mass_basis
    eigenvalues, eigenvectors = np.linalg.eigh(weighted)
    eh = physical_constants['Hartree energy'][0]
    bohr = physical_constants['Bohr radius'][0]
    amu = physical_constants['atomic mass constant'][0]
    cm_factor = np.sqrt(eh / (amu * bohr**2)) / (2 * np.pi * speed_of_light * 100)
    frequencies = []
    for index, eigenvalue in enumerate(eigenvalues):
        displacements = (mass_basis @ eigenvectors[:, index]).reshape(-1, 3)
        norm = np.linalg.norm(displacements)
        frequencies.append(dict(mode=index + 1, wavenumberCm1=float(np.sign(eigenvalue) * np.sqrt(abs(eigenvalue)) * cm_factor),
                                imaginary=bool(eigenvalue < 0), displacements=(displacements / norm).tolist()))
    evidence = dict(
        atomIds=list(ctx.atom_ids),
        frameId=frame_id,
        geometryAngstrom=positions.tolist(),
        matrixHartreePerBohr2=hessian.tolist(),
        projectedMatrixHartreePerBohr2=(tangent.T @ lagrangian @ tangent).tolist(),
        projectedDegreesOfFreedom=tangent.shape[1],
        vibrationalDegreesOfFreedom=len(frequencies),
        removedRigidModes=rigid_modes,
        imaginaryCount=sum(mode['imaginary'] for mode in frequencies),
        constraintCurvatureApplied=bool(space.equations),
        constraints=space.residuals(positions),
        frozenAtomIds=[atom_id for atom_id, fixed in zip(ctx.atom_ids, space.frozen) if fixed],
    )
    evidence.update(getattr(ctx, 'last_hessian', None) or dict(
        derivativeMethod='central-unprojected-physical-gradient-difference',
        displacementBohr=DIFFERENCE_STEP_BOHR, maximumRawAntisymmetryHartreePerBohr2=asymmetry))
    return evidence, frequencies


def run_hessian(request, ctx):
    positions = ctx.initial.copy()
    require(constraint_valid(ctx.constraints, positions), 'Selected Hessian frame does not satisfy the global constraints')
    frames = []
    try:
        raw = ctx.evaluate(positions)
        item = frame(request, positions, raw['energyHartree'], 0, 'hessian', 'hessian', 'evaluated',
                     convergence=convergence(positions, raw['gradientHartreePerBohr'], ctx.constraints))
        frames.append(item)
        ctx.emit('frame', item)
        matrix, asymmetry = physical_hessian(positions, ctx, 'hessian')
        hessian, frequencies = harmonic_result(positions, raw, matrix, asymmetry, ctx, item['id'])
        return dict(frames=frames, status='completed', hessian=hessian, frequencies=frequencies,
                    provenance=dict(ctx.provenance(), stationarity='not-inferred-from-hessian'))
    except PesCancelled:
        return dict(frames=frames, status='stopped', provenance=ctx.provenance())
    except (PesError, CoordinateError) as error:
        return dict(frames=frames, status='partial' if frames else 'failed',
                    provenance=ctx.provenance(), error=error_details(error))


def ase_atoms(ctx, positions):
    from ase import Atoms
    from ase.calculators.calculator import Calculator, all_changes

    class PhysicalCalculator(Calculator):
        implemented_properties = ['energy', 'forces']

        def calculate(self, atoms=None, properties=None, system_changes=all_changes):
            super().calculate(atoms, properties, system_changes)
            raw = ctx.evaluate(self.atoms.positions)
            self.results = dict(energy=raw['energyHartree'] * HARTREE_EV,
                                forces=-raw['gradientHartreePerBohr'] * HARTREE_EV / BOHR_ANGSTROM)

    atoms = Atoms(numbers=atom_numbers(ctx.request), positions=positions)
    atoms.calc = PhysicalCalculator()
    return atoms


def sella_optimizer(ctx, atoms, algorithm, strategy, maximum, *, space=None,
                    coordinate_system='xyz', order=1, modern=False):
    from sella import Sella
    from sella.internal import Constraints
    from sella.optimize.restricted_step import BaseRestrictedStep
    space = ctx.constraints if space is None else space
    require(coordinate_system in ('xyz', 'ric'), 'Unsupported Sella coordinate system')
    constraints = Constraints(atoms)
    for index in np.flatnonzero(space.frozen):
        constraints.fix_translation(int(index))
    centroid_fixed = False
    for _, expression, target in space.equations:
        if isinstance(expression, CentroidComponent):
            centroid_fixed = True
            constraints.fix_translation(expression.indices, dim=expression.component, target=target)
            continue
        if modern:
            expression = expression.rebase(atoms.positions)
            if expression.periodic:
                current = expression.value(atoms.positions)
                target = current + ((target - current + 180.) % 360. - 180.)
            constraints.fix_other(expression.sella_coordinate(), target=target)
            continue
        kind, indices = expression.definitions[expression.root[1]]
        constrain = {'B': constraints.fix_bond, 'A': constraints.fix_angle, 'D': constraints.fix_dihedral}[kind]
        constrain(indices, target=target, mic=False)

    class CartesianRadius(BaseRestrictedStep):
        """The same per-atom Cartesian trust metric in XYZ and RIC."""
        def cons(self, step, derivative=None):
            if self.pes.int is not None:
                inverse = self.pes._get_Binv()
                cartesian = (inverse @ step)[:atoms.positions.size].reshape(-1, 3)
                change = None if derivative is None else (inverse @ derivative)[:atoms.positions.size].reshape(-1, 3)
            else:
                cartesian = step.reshape(-1, 3)
                change = None if derivative is None else derivative.reshape(-1, 3)
            lengths = np.linalg.norm(cartesian, axis=1)
            index = int(np.argmax(lengths))
            value = float(lengths[index])
            return value if change is None else (value, float(cartesian[index] @ change[index] / max(value, 1e-14)))

    class ConstrainedSella(Sella):
        def _should_diagonalize(self):
            return strategy == 'auto' and super()._should_diagonalize()

        def step(self):
            self.delta = min(self.delta, maximum)
            proposal, magnitude = self._predict_step()
            diagonalize = self._should_diagonalize()
            self._record_diagonalization(diagonalize)
            original_set_x = self.pes.set_x
            accepted = {}

            def set_accepted_x(target):
                if self.pes.int is None:
                    before = self.pes.get_x().reshape(-1, 3)
                    corrected = bounded_move(space, before, target.reshape(-1, 3), maximum)
                    result = original_set_x(corrected.ravel())
                else:
                    origin = self.pes.get_x().copy()
                    before = atoms.positions.copy()
                    dummy = self.pes.dummies.positions.copy()
                    difference = target - origin
                    last_error = None
                    for attempt in range(30):
                        atoms.positions = before.copy()
                        self.pes.dummies.positions = dummy.copy()
                        try:
                            result = original_set_x(origin + difference * .5**attempt)
                            after = space.project(atoms.positions)
                            if not np.isfinite(after).all() or np.linalg.norm(after - before, axis=1).max() > maximum * (1 + 1e-10):
                                continue
                            if not np.array_equal(after, atoms.positions):
                                # Same secant convention as InternalPES's own
                                # exact-manifold projection: include its IC
                                # displacement, keeping native ODE transport.
                                q_before = self.pes.get_x().copy()
                                atoms.positions = after
                                correction = self.pes.wrap_dx(self.pes.get_x() - q_before, origin=q_before)
                                result = result[0], result[1] + correction, result[2]
                            break
                        except (CoordinateError, np.linalg.LinAlgError) as error:
                            last_error = error
                    else:
                        atoms.positions = before
                        self.pes.dummies.positions = dummy
                        raise CoordinateError('Could not retract the RIC step within the Cartesian displacement bound') from last_error
                accepted.update(step=np.array(result[0], copy=True), magnitude=float(np.linalg.norm(atoms.positions - before, axis=1).max()))
                return result

            self.pes.set_x = set_accepted_x
            try:
                ratio = self.pes.kick(proposal, False)
            finally:
                self.pes.set_x = original_set_x
            if diagonalize:
                self.pes.diag(**self.diagkwargs)
            if modern and self.pes.int is not None and self._maybe_rebuild_bad_internals():
                return
            self._update_trust_radius(ratio, accepted.get('step', proposal) if modern else proposal,
                                      accepted.get('magnitude', magnitude) if modern else magnitude)

    rigid_gauge = not np.any(space.frozen) and not centroid_fixed
    gauge = dict(proj_trans=rigid_gauge, proj_rot=rigid_gauge) if coordinate_system == 'xyz' else {}
    optimizer = ConstrainedSella(atoms, logfile=None, order=order, method=algorithm, constraints=constraints,
                                internal=coordinate_system == 'ric', rs='mis' if coordinate_system == 'ric' else 'ras',
                                delta0=maximum, max_cpu_threads=ctx.request.get('threads', 1), **gauge)
    if modern:
        optimizer.rs = CartesianRadius
    return optimizer


def sella_convergence(optimizer, positions, raw, space, threshold, displacement=None):
    """Actual Sella max-atom force plus the original per-equation contract.

    The native cmax is a norm of residuals, and is recorded as a diagnostic;
    it cannot accumulate many individually valid equalities into a stricter
    undeclared stop rule. Formal equalities keep their original Å/degree/etc.
    tolerances and fixed XYZ are checked exactly.
    """
    native = optimizer.pes.converged(threshold * HARTREE_EV / BOHR_ANGSTROM, cmax=SELLA_CMAX)
    metrics = convergence(positions, raw['gradientHartreePerBohr'], space, displacement)
    fmax = float(native[1]) * BOHR_ANGSTROM / HARTREE_EV
    metrics.update(sellaMaxAtomForceHartreePerBohr=fmax,
                   sellaNativeConstraintResidualNorm=float(native[2]),
                   sellaNativeConverged=bool(native[0]),
                   fmaxHartreePerBohr=threshold)
    return metrics, bool(metrics['constraintsSatisfied'] and np.isfinite(fmax) and fmax < threshold)


def relax_sella(positions, ctx, space, max_steps, threshold, observe=None, *, coordinate_system='ric'):
    """One finite order=0 run. Its last valid E/G can seed the next point."""
    start = space.project(positions)
    raw = ctx.evaluate(start)
    best = [start.copy(), raw]
    metadata = dict(name='sella', version=version('sella'), order=0, coordinateSystem=coordinate_system,
                    steps=0, success=False, terminationReason='step-limit', initialized=False)
    metrics = convergence(start, raw['gradientHartreePerBohr'], space)
    optimized = False
    try:
        atoms = ase_atoms(ctx, start)
        with sella_optimizer(ctx, atoms, 'qn', 'auto', .1, space=space,
                             coordinate_system=coordinate_system, order=0, modern=True) as optimizer:
            metadata['initialized'] = True
            for index in range(max_steps + 1):
                ctx.check_cancelled()
                current = atoms.positions.copy()
                require(np.isfinite(current).all() and constraint_valid(space, current),
                        'Sella SCAN geometry did not satisfy exact constraints')
                raw = ctx.evaluate(current)
                metrics, optimized = sella_convergence(optimizer, current, raw, space, threshold)
                best[:] = current.copy(), raw
                metadata.update(steps=index, success=optimized)
                if optimized:
                    metadata['terminationReason'] = 'converged'
                    break
                if index == max_steps:
                    break
                optimizer.step()
                optimizer.nsteps += 1
                accepted = atoms.positions.copy()
                if constraint_valid(space, accepted) and np.isfinite(accepted).all():
                    accepted_raw = ctx.evaluate(accepted)
                    best[:] = accepted.copy(), accepted_raw
                    if observe:
                        observe(accepted, accepted_raw)
                if np.array_equal(accepted, current):
                    metadata.update(steps=index + 1, terminationReason='no-feasible-step')
                    break
    except (CoordinateError, PesError, np.linalg.LinAlgError) as error:
        metadata.update(success=False, terminationReason='user-stopped' if isinstance(error, PesCancelled) else 'local-error', message=str(error))
        if isinstance(error, PesCancelled):
            return dict(positions=best[0], energyHartree=best[1]['energyHartree'], convergence=convergence(best[0], best[1]['gradientHartreePerBohr'], space),
                        converged=False, stopped=True, optimizer=metadata)
        if isinstance(error, PesError) and error.code not in ('PES_XTB_SCC', 'PES_XTB_GEOMETRY'):
            raise
        return dict(positions=best[0], energyHartree=best[1]['energyHartree'], convergence=convergence(best[0], best[1]['gradientHartreePerBohr'], space),
                    converged=False, failed=True, warning=error_details(error), optimizer=metadata)
    return dict(positions=best[0], energyHartree=best[1]['energyHartree'], convergence=metrics,
                converged=optimized, optimizer=metadata)


def attach_constraints(atoms, space, maximum=None):
    from ase.constraints import FixConstraint

    class ExactProjection(FixConstraint):
        def get_removed_dof(self, atoms):
            return atoms.positions.size - space.tangent(atoms.positions).shape[1]

        def adjust_positions(self, atoms, positions):
            if maximum is None:
                positions[:] = space.project(positions)
            else:
                positions[:] = bounded_move(space, atoms.positions, positions, maximum)

        def adjust_forces(self, atoms, forces):
            forces[:] = space.project_vector(atoms.positions, forces)

        def copy(self):
            return ExactProjection()

    atoms.set_constraint(ExactProjection())


def dimer_optimizer(ctx, atoms, maximum, resources):
    from ase.mep import DimerControl, MinModeAtoms, MinModeTranslate
    space = ctx.constraints
    attach_constraints(atoms, space)
    seed = ctx.request['parameters'].get('seed', 1)
    require(type(seed) is int and 0 <= seed < 2**32, 'Dimer seed must be an unsigned 32-bit integer')
    basis = space.tangent(atoms.positions)
    modes, _ = vibrational_space(atoms.positions, atoms.get_masses(), basis)
    require(modes.shape[1] > 0, 'Dimer has no movable nonrigid degree of freedom')
    mode = modes @ np.random.default_rng(seed).normal(size=modes.shape[1])
    mode = (mode / np.linalg.norm(mode)).reshape(-1, 3)
    control = resources.enter_context(DimerControl(logfile=None, eigenmode_logfile=None,
                                                    maximum_translation=maximum, max_num_rot=12))
    dimer = MinModeAtoms(atoms, control=control, eigenmodes=[mode], random_seed=seed)
    optimizer = resources.enter_context(MinModeTranslate(dimer, logfile=None))

    def step():
        before = atoms.positions.copy()
        current_mode = space.project_vector(before, dimer.get_eigenmode())
        length = np.linalg.norm(current_mode)
        require(length > 1e-14, 'Dimer mode vanished in the current constraint space')
        dimer.set_eigenmode(current_mode / length)
        optimizer.step()
        atoms.positions = bounded_move(space, before, atoms.positions, maximum)
        return dict(curvatureEvPerAngstrom2=float(dimer.get_curvature()))
    return step


def climbing_optimizer(ctx, atoms, maximum, limits, resources):
    from ase.optimize import BFGS
    space = ctx.constraints
    expression = coordinate_parameter(ctx.request['parameters'], ctx.coordinates, atoms.positions)
    space.require_variable(expression, atoms.positions)
    target = expression.value(atoms.positions)
    climb = resources.enter_context(BFGS(atoms, logfile=None, maxstep=maximum))
    relaxer = None

    def step():
        nonlocal expression, target, relaxer
        before = atoms.positions.copy()
        expression = expression.rebase(before)
        local_space = space.with_equations([('climb', expression, target)])
        if relaxer is None:
            relaxer = BFGS(atoms, logfile=None, maxstep=maximum)
        raw_gradient = ctx.evaluate(before)['gradientHartreePerBohr']
        local_metrics = convergence(before, raw_gradient, local_space)
        force_limits = {key: limits[key] for key in FORCE_LIMITS}
        if not meets_limits(local_metrics, force_limits):
            attach_constraints(atoms, local_space, maximum)
            relaxer.step()
            return dict(climbStage='orthogonal-relaxation', cv=[expression.value(atoms.positions)])

        direction = space.project_vector(before, expression.gradient(before))
        size = np.linalg.norm(direction)
        require(size > 1e-12, 'Climbing coordinate is fixed at the current geometry')
        direction /= size
        climb_gradient = -float(np.sum(raw_gradient * direction)) * direction * HARTREE_EV / BOHR_ANGSTROM
        if np.linalg.norm(climb_gradient) <= 1e-14:
            return dict(climbStage='ascent', cv=[target])
        proposed, lengths = climb.prepare_step(before.ravel(), climb_gradient.ravel())
        proposed = climb.determine_step(proposed, lengths).reshape(-1, 3)
        # The uphill optimizer's accumulated inverse curvature can couple
        # Cartesian components. Its motion is restricted to the current CV.
        proposed = float(np.sum(proposed * direction)) * direction
        atoms.positions = bounded_move(space, before, before + proposed, maximum)
        expression = expression.rebase(atoms.positions)
        target = expression.value(atoms.positions)
        relaxer.close()
        relaxer = None
        return dict(climbStage='ascent', cv=[target])

    def close():
        if relaxer is not None:
            relaxer.close()
    resources.callback(close)
    return step


def run_ts(request, ctx):
    parameters = request['parameters']
    algorithm = request['algorithm']
    is_sella = algorithm in ('prfo', 'rfo', 'qn')
    modern = is_sella and parameters.get('executionProfile') == SELLA_PROFILE
    coordinate_system = parameters.get('coordinateSystem', 'xyz') if modern else 'xyz'
    require(coordinate_system in ('xyz', 'ric'), 'Unsupported Sella coordinate system')
    require(is_sella or algorithm in ('dimer', 'climb'), 'Unsupported transition-state algorithm')
    strategy = parameters.get('hessianStrategy', 'calcfc' if is_sella else 'auto')
    require(strategy in ('auto', 'calcfc', 'recalcfc'), 'Unsupported iterative Hessian strategy')
    require(is_sella or strategy == 'auto', 'This TS algorithm consumes automatic curvature estimates only')
    recalc = positive(parameters, 'recalcInterval', 5, integer=True) if strategy == 'recalcfc' else None
    max_steps = positive(parameters, 'maxSteps', 200, integer=True)
    maximum = positive(parameters, 'maxStepAngstrom', .10)
    limits = ({'fmaxHartreePerBohr': positive(parameters, 'fmaxHartreePerBohr', .00045)} if modern else
              {key: positive(parameters, key, default)
               for key, default in (FORCE_LIMITS | DISPLACEMENT_LIMITS).items()})
    positions = ctx.constraints.project(ctx.initial)
    require(ctx.constraints.tangent(positions).shape[1] > 0, 'TS has no movable coordinate')
    initial_projected = not np.array_equal(positions, ctx.initial)
    frames = []
    hessian_events = []
    hessian = frequencies = failure = None
    terminal, identification = 'partial', 'geometry-unconverged'
    optimized = False
    exact = None
    stationary_verification = None
    optimizer_name = {'dimer': 'ase-improved-dimer', 'climb': 'ase-bfgs-generalized-coordinate-climb'}.get(algorithm, 'sella')
    optimizer_version = None
    optimizer_initialized = False
    try:
        with ExitStack() as resources:
            raw = ctx.evaluate(positions)
            initial_metrics = convergence(positions, raw['gradientHartreePerBohr'], ctx.constraints)
            item = frame(request, positions, raw['energyHartree'], 0, 'ts', 'ts', 'evaluated', convergence=initial_metrics)
            frames.append(item)
            ctx.emit('frame', item)
            atoms = ase_atoms(ctx, positions)
            if is_sella:
                optimizer_version = version('sella')
                optimizer = resources.enter_context(sella_optimizer(ctx, atoms, algorithm, strategy, maximum,
                                                                    coordinate_system=coordinate_system, modern=modern))
                optimizer_initialized = True

                def install_hessian(step):
                    nonlocal exact
                    matrix, asymmetry = physical_hessian(atoms.positions, ctx, 'initial-hessian' if step == 0 else 'recalculate-hessian')
                    optimizer.pes.get_g()
                    installed = matrix * HARTREE_EV / BOHR_ANGSTROM**2
                    if optimizer.pes.int is not None:
                        # Sella performs B^-T (Hcart - internal curvature) B^-1
                        # and reconstructs the redundant internal subspace.
                        installed = optimizer.pes._convert_cartesian_hessian_to_internal(installed)
                    optimizer.pes.get_H().set_B(installed)
                    optimizer.pes.first_diag = False
                    optimizer.initialized = True
                    derivative = dict(ctx.last_hessian)
                    exact = (atoms.positions.copy(), matrix, asymmetry, derivative)
                    hessian_events.append(dict(step=step, use='sella-curvature-reset',
                                               optimizerCoordinates=coordinate_system,
                                               cartesianHessianTransformed=optimizer.pes.int is not None, **derivative))

                if strategy != 'auto':
                    install_hessian(0)

                def step():
                    optimizer.step()
                    optimizer.nsteps += 1
                    return {}
            else:
                optimizer_version = version('ase')
                if algorithm == 'dimer':
                    step = dimer_optimizer(ctx, atoms, maximum, resources)
                else:
                    step = climbing_optimizer(ctx, atoms, maximum, limits, resources)

            for index in range(1, max_steps + 1):
                ctx.check_cancelled()
                before = atoms.positions.copy()
                raw_before = ctx.evaluate(before)
                projected = ctx.constraints.project_vector(before, raw_before['gradientHartreePerBohr'])
                if modern:
                    check, ready = sella_convergence(optimizer, before, raw_before, ctx.constraints,
                                                     limits['fmaxHartreePerBohr'], np.zeros_like(before))
                    if ready:
                        positions, raw = before, raw_before
                        stationary_verification, optimized = check, True
                        identification = 'frequency-incomplete'
                        break
                # No optimizer step exists at an exactly stationary point.
                if np.linalg.norm(projected) <= 1e-14:
                    stationary_verification = convergence(before, raw_before['gradientHartreePerBohr'],
                                                          ctx.constraints, np.zeros_like(before))
                    optimized = (ready if modern else meets_limits(stationary_verification, limits))
                    if optimized:
                        identification = 'frequency-incomplete'
                    break
                optimizer_details = step()
                positions = atoms.positions.copy()
                require(np.isfinite(positions).all() and constraint_valid(ctx.constraints, positions),
                        'TS trial did not satisfy the frozen coordinates and internal constraints')
                raw = ctx.evaluate(positions)
                if modern:
                    metrics, optimized = sella_convergence(optimizer, positions, raw, ctx.constraints,
                                                           limits['fmaxHartreePerBohr'], positions - before)
                else:
                    metrics = convergence(positions, raw['gradientHartreePerBohr'], ctx.constraints, positions - before)
                    optimized = meets_limits(metrics, limits)
                if optimized:
                    identification = 'frequency-incomplete'
                if np.array_equal(positions, before):
                    stationary_verification = metrics
                    if not optimized:
                        failure = dict(code='PES_TS_NO_GEOMETRY_STEP',
                                       message='The TS optimizer could not produce another feasible displacement')
                    break
                item = frame(request, positions, raw['energyHartree'], index, 'ts', 'ts',
                             'converged' if optimized else 'accepted', converged=optimized,
                             convergence=metrics, **optimizer_details)
                frames.append(item)
                ctx.emit('frame', item)
                ctx.emit('progress', dict(phase='ts', acceptedSteps=index, maximumSteps=max_steps))
                if recalc and index % recalc == 0:
                    install_hessian(index)
                if optimized:
                    break

            if optimized:
                identification = 'frequency-incomplete'
                if exact is not None and np.array_equal(exact[0], positions):
                    matrix, asymmetry, derivative = exact[1:]
                    ctx.last_hessian = derivative
                    hessian_events.append(dict(step=item['step'], use='final-frequency-reused-physical-hessian',
                                               derivativeMethod=derivative['derivativeMethod'],
                                               derivativeEvaluations=0, nativeHessianCalls=0))
                else:
                    matrix, asymmetry = physical_hessian(positions, ctx, 'final-frequency')
                    hessian_events.append(dict(step=item['step'], use='final-frequency', **ctx.last_hessian))
                hessian, frequencies = harmonic_result(positions, raw, matrix, asymmetry, ctx, item['id'])
                count = hessian['imaginaryCount']
                identification = 'minimum' if count == 0 else 'first-order-saddle' if count == 1 else 'higher-order-saddle'
                terminal = 'completed'
    except PesCancelled:
        terminal = 'stopped'
    except (PesError, CoordinateError, ImportError, RuntimeError, np.linalg.LinAlgError) as error:
        terminal = 'partial' if frames else 'failed'
        failure = error_details(error)

    result = dict(frames=frames, series=[dict(id='ts', label='TS', frameIds=[row['id'] for row in frames])],
                  status=terminal, converged=optimized, stationaryPoint=identification,
                  provenance=dict(ctx.provenance(), optimizer=optimizer_name, optimizerVersion=optimizer_version,
                                  algorithm=algorithm, hessianStrategy=strategy, recalcInterval=recalc,
                                  hessianEvents=hessian_events, inputProjectedToConstraints=initial_projected,
                                  maxSteps=max_steps, maxStepAngstrom=maximum, convergenceThresholds=limits,
                                  convergenceCoordinates='constraint-tangent-cartesian'))
    if modern:
        result['provenance']['optimizer'] = 'sella' if optimizer_initialized else 'none'
        result['provenance'].update(executionProfile=SELLA_PROFILE, coordinateSystem=coordinate_system, order=1,
                                    requestedOptimizer='sella', optimizerInitialized=optimizer_initialized,
                                    convergencePreset=parameters.get('convergencePreset', 'custom'),
                                    convergenceCriterion='sella-max-atom-projected-force-and-exact-equalities',
                                    nativeConstraintNormTolerance=SELLA_CMAX, nativeConstraintNormRole='diagnostic',
                                    formalConstraintTolerance=CONSTRAINT_TOLERANCE,
                                    constraintNormalization='one source unit per equation; fixed XYZ in angstrom')
    if algorithm == 'dimer':
        result['provenance']['maximumDimerRotations'] = 12
    if hessian is not None:
        result.update(hessian=hessian, frequencies=frequencies)
    if stationary_verification is not None:
        result['stationaryVerification'] = dict(stationary_verification, frameId=frames[-1]['id'])
    if failure:
        result['error'] = failure
    return result


def run(request, ctx):
    operation = request['operation']
    require(operation in ('scan', 'ts', 'hessian'), 'Unexpected scan or TS operation')
    if operation == 'scan':
        return run_scan(request, ctx)
    if operation == 'hessian':
        return run_hessian(request, ctx)
    return run_ts(request, ctx)
