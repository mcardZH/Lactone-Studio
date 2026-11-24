"""Owned Sella IRC branches sharing the source geometry and curvature."""

from importlib.metadata import version

import numpy as np

from pes_coordinates import CentroidComponent, CoordinateError
from pes_core import BOHR_ANGSTROM, HARTREE_EV, PesCancelled, PesError, atom_numbers, frame, require
from pes_scan_ts import (
    DIFFERENCE_STEP_BOHR, constraint_valid, convergence, error_details, harmonic_result,
    hessian_for_optimizer, physical_hessian, positive, recoverable_geometry_error, vibrational_space,
)


def periodic_hessian_subset(ctx, provided, matrix):
    space = ctx.constraints
    try:
        space.geometry.assert_same({'cell': provided.get('cell')})
    except ValueError:
        return None
    matrix_space = provided.get('space', {'kind':'cartesian-full'})
    if not isinstance(matrix_space, dict) or matrix_space.get('kind') not in ('cartesian-full','cartesian-active'):
        return None
    source_indices = (matrix_space.get('activeDofs') if matrix_space['kind'] == 'cartesian-active' else
                      list(range(space.reference.size)))
    if (not isinstance(source_indices, list)
            or any(type(index) is not int or not 0 <= index < space.reference.size for index in source_indices)
            or len(set(source_indices)) != len(source_indices) or matrix.shape != (len(source_indices),) * 2):
        return None
    lookup = {column: index for index, column in enumerate(source_indices)}
    if not all(column in lookup for column in space.free):
        return None
    subset = [lookup[column] for column in space.free]
    return matrix[np.ix_(subset, subset)]


def start_curvature(ctx, positions, parameters, step):
    provided = parameters.get('initialHessian')
    if isinstance(provided, dict):
        try:
            matrix = np.asarray(provided.get('matrixHartreePerBohr2'), dtype=float)
        except (TypeError, ValueError):
            matrix = np.empty(0)
        atom_ids = provided.get('atomIds')
        geometry = provided.get('geometryAngstrom')
        current_order = atom_ids is None or isinstance(atom_ids, (list, tuple)) and tuple(atom_ids) == ctx.atom_ids
        current_geometry = geometry is None or np.array_equal(geometry, positions)
        space = getattr(ctx, 'constraints', None)
        if getattr(space, 'geometry', None) is not None:
            matrix = periodic_hessian_subset(ctx, provided, matrix) if atom_ids is not None and geometry is not None else None
        elif matrix.shape != (positions.size,) * 2:
            matrix = None
        if current_order and current_geometry and matrix is not None and np.isfinite(matrix).all():
            asymmetry = float(np.max(np.abs(matrix - matrix.T), initial=0.))
            ctx.last_hessian = dict(
                derivativeMethod='reused-physical-hessian',
                derivativeEvaluations=0, nativeHessianCalls=0,
                maximumRawAntisymmetryHartreePerBohr2=asymmetry,
            )
            if isinstance(provided.get('source'), dict):
                ctx.last_hessian['source'] = provided['source']
            return (matrix + matrix.T) * .5, asymmetry
    return physical_hessian(positions, ctx, 'initial-hessian', step)


def downhill_direction(space, positions, masses, raw):
    basis, _ = vibrational_space(positions, masses, space.tangent(positions), periodic=space.geometry is not None)
    movable = basis.T @ raw['gradientHartreePerBohr'].ravel()
    return -basis @ movable


def initial_direction(space, positions, masses, raw, frequencies, endpoint, choice):
    scale = max((abs(item['wavenumberCm1']) for item in frequencies), default=1.)
    noise = np.sqrt(np.finfo(float).eps) * max(1., scale)
    modes = [item for item in frequencies if item['wavenumberCm1'] < -noise]
    projected = space.project_vector(positions, raw['gradientHartreePerBohr'])
    force = np.linalg.norm(projected, axis=1).max() * HARTREE_EV / BOHR_ANGSTROM
    if force > endpoint or not modes:
        direction = downhill_direction(space, positions, masses, raw)
        if np.linalg.norm(direction) <= np.finfo(float).eps:
            return 'stationary', None, None, len(modes)
        return 'downhill', direction, None, len(modes)
    mode = min(modes, key=lambda item: item['wavenumberCm1'])
    if choice not in (None, 'auto'):
        selected = next((item for item in modes if item['mode'] == choice), None)
        require(selected is not None, 'The selected IRC mode is not in the usable imaginary modes')
        mode = selected
    kind = 'bidirectional' if len(modes) == 1 else 'exploration'
    return kind, np.asarray(mode['displacements']).ravel(), mode['mode'], len(modes)


def branch_optimizer(ctx, positions, raw, masses, direction, matrix, radius, endpoint, inner, evaluate):
    from ase import Atoms
    from ase.calculators.calculator import Calculator, all_changes
    from sella import IRC
    from sella.internal import Constraints

    class PhysicalCalculator(Calculator):
        implemented_properties = ['energy', 'forces']

        def calculate(self, atoms=None, properties=None, system_changes=all_changes):
            super().calculate(atoms, properties, system_changes)
            point = self.atoms.positions
            values = raw if np.array_equal(positions, point) else evaluate(point)
            self.results = dict(
                energy=values['energyHartree'] * HARTREE_EV,
                forces=-values['gradientHartreePerBohr'] * HARTREE_EV / BOHR_ANGSTROM,
            )

    space = ctx.constraints
    cell = dict(cell=space.geometry.vectors, pbc=space.geometry.pbc) if space.geometry is not None else {}
    atoms = Atoms(numbers=atom_numbers(ctx.request), positions=positions, masses=masses, **cell)
    atoms.calc = PhysicalCalculator()
    constraints = Constraints(atoms)
    for index in np.flatnonzero(space.frozen):
        constraints.fix_translation(int(index))
    for _, expression, target in space.equations:
        if isinstance(expression, CentroidComponent):
            constraints.fix_translation(expression.indices, dim=expression.component, target=target)
        else:
            expression = expression.rebase(positions)
            if expression.periodic:
                current = expression.value(positions)
                target = current + ((target - current + 180.) % 360. - 180.)
            constraints.fix_other(expression.sella_coordinate(), target=target)
    optimizer = IRC(atoms, logfile=None, dx=radius, constraints=constraints)
    pes = optimizer.pes
    set_x = pes.set_x

    def retract(target):
        projected = space.project(target.reshape((-1, 3)))
        return set_x(projected.ravel())

    pes.set_x = retract
    pes.set_H(hessian_for_optimizer(matrix, space) * HARTREE_EV / BOHR_ANGSTROM**2, initialized=True)
    optimizer.d1 = direction * radius / np.linalg.norm(direction * optimizer.sqrtm)
    optimizer.fmax = endpoint
    optimizer.fmax_inner = min(endpoint, inner)
    return optimizer


def track(request, ctx, points, summary, positions, raw, masses, direction, matrix, settings):
    from sella.optimize.irc import IRCInnerLoopConvergenceFailure

    name = summary['direction']
    radius, maximum, endpoint, inner, interval, step = settings
    phase = f'irc-{name}'
    node = ctx.new_node_id(phase)
    sign = -1 if name == 'reverse' else 1
    distance = 0.
    optimizer = None
    current, value = positions.copy(), raw

    def evaluate(geometry):
        return ctx.evaluate(geometry, node_id=node)

    def reboot():
        vector = direction if summary['acceptedSteps'] == 0 else downhill_direction(
            ctx.constraints, current, masses, value)
        if np.linalg.norm(vector) <= np.finfo(float).eps:
            return None
        return branch_optimizer(ctx, current, value, masses, vector, matrix, radius, endpoint, inner, evaluate)

    def skip(attempt, error):
        details = error_details(error)
        if isinstance(error, IRCInnerLoopConvergenceFailure):
            details.update(code='PES_IRC_CORRECTOR_FAILED', message='Sella IRC point correction did not converge')
        summary['skippedSteps'].append(dict(step=attempt, **details))
        return details

    try:
        ctx.emit('progress', dict(phase=phase, completed=0, total=maximum))
        for attempt in range(1, maximum + 1):
            ctx.check_cancelled()
            summary['attemptedSteps'] = attempt
            try:
                if optimizer is None:
                    optimizer = reboot()
                require(optimizer is not None, 'No usable continuation direction')
                optimizer.step()
                candidate = optimizer.atoms.positions.copy()
                require(constraint_valid(ctx.constraints, candidate), 'IRC step could not preserve the exact constraints',
                        'PES_XTB_GEOMETRY')
                change = float(np.linalg.norm((candidate - current) * np.sqrt(masses)[:, None]))
                require(change > np.finfo(float).eps, 'IRC step did not move the geometry', 'PES_XTB_GEOMETRY')
                candidate_raw = evaluate(candidate)
            except PesCancelled:
                raise
            except (PesError, CoordinateError, IRCInnerLoopConvergenceFailure, np.linalg.LinAlgError) as error:
                details = skip(attempt, error)
                if isinstance(error, PesError) and not recoverable_geometry_error(error):
                    summary.update(status='failed', error=details)
                    return
                if optimizer is not None:
                    optimizer.pes.close()
                    optimizer = None
                radius *= .5
                ctx.emit('progress', dict(phase=phase, completed=attempt, total=maximum))
                continue

            distance += change
            metrics = convergence(candidate, candidate_raw['gradientHartreePerBohr'], ctx.constraints, candidate - current)
            current, value = candidate, candidate_raw
            summary['acceptedSteps'] += 1
            reached = optimizer.converged()
            point = frame(request, current, value['energyHartree'], len(points), 'irc', 'irc',
                          'converged' if reached else 'accepted', converged=bool(reached),
                          convergence=metrics, cv=[sign * distance], ircDirection=name,
                          ircDistance=sign * distance, ircStep=attempt)
            points.append(point)
            ctx.emit('frame', point)
            ctx.emit('progress', dict(phase=phase, completed=attempt, total=maximum))
            if interval and summary['acceptedSteps'] % interval == 0:
                try:
                    matrix, _ = physical_hessian(current, ctx, 'recalculate-hessian', step)
                    optimizer.pes.set_H(hessian_for_optimizer(matrix, ctx.constraints) * HARTREE_EV / BOHR_ANGSTROM**2, initialized=True)
                    summary['hessianRefreshes'].append(dict(
                        step=attempt, acceptedStep=summary['acceptedSteps'], **(ctx.last_hessian or {})))
                except PesCancelled:
                    raise
                except (PesError, CoordinateError, np.linalg.LinAlgError) as error:
                    summary['hessianRefreshes'].append(dict(
                        step=attempt, acceptedStep=summary['acceptedSteps'], error=error_details(error)))
                    if isinstance(error, PesError) and not recoverable_geometry_error(error):
                        raise
            if reached:
                summary['status'] = 'converged'
                return
        summary['status'] = 'step-limit'
    except PesCancelled:
        summary['status'] = 'stopped'
        raise
    except (PesError, CoordinateError, RuntimeError, ImportError, np.linalg.LinAlgError) as error:
        summary.update(status='failed', error=error_details(error))
    finally:
        if optimizer is not None:
            optimizer.pes.close()
        ctx.release_node(node)


def run(request, ctx):
    from ase.data import atomic_masses

    parameters = request.get('parameters', {})
    radius = positive(parameters, 'stepMassAngstrom', .10)
    maximum = positive(parameters, 'maxSteps', 50, integer=True)
    endpoint = positive(parameters, 'endpointForce', .05)
    inner = positive(parameters, 'correctorForce', .01)
    interval = parameters.get('recalcInterval', 0)
    require(type(interval) is int and interval >= 0, 'recalcInterval must be a nonnegative integer')
    step = positive(parameters, 'hessianStepBohr', DIFFERENCE_STEP_BOHR)
    positions = ctx.initial.copy()
    masses = atomic_masses[atom_numbers(request)]
    points = []
    record = dict(kind='stationary', branches=[], mode=None, imaginaryCount=0)
    result = dict(frames=points, irc=record)
    status = 'completed'
    try:
        require(constraint_valid(ctx.constraints, positions), 'Selected IRC frame does not satisfy the global constraints')
        raw = ctx.evaluate(positions)
        point = frame(request, positions, raw['energyHartree'], 0, 'irc', 'irc', 'evaluated',
                      convergence=convergence(positions, raw['gradientHartreePerBohr'], ctx.constraints),
                      cv=[0.], ircDirection='origin', ircDistance=0., ircStep=0)
        points.append(point)
        ctx.emit('frame', point)
        hessian, asymmetry = start_curvature(ctx, positions, parameters, step)
        evidence, frequencies = harmonic_result(positions, raw, hessian, asymmetry, ctx, point['id'])
        result.update(hessian=evidence, frequencies=frequencies)
        kind, direction, mode, count = initial_direction(
            ctx.constraints, positions, masses, raw, frequencies, endpoint, parameters.get('mode'))
        record.update(kind=kind, mode=mode, imaginaryCount=count)
        branches = () if kind == 'stationary' else ('downhill',) if kind == 'downhill' else ('forward', 'reverse')
        settings = radius, maximum, endpoint, inner, interval, step
        for name in branches:
            branch = dict(direction=name, status='starting', attemptedSteps=0,
                          acceptedSteps=0, skippedSteps=[], hessianRefreshes=[])
            record['branches'].append(branch)
            vector = -direction if name == 'reverse' else direction
            track(request, ctx, points, branch, positions, raw, masses, vector, hessian, settings)
        failure = next((item['error'] for item in record['branches'] if item['status'] == 'failed'), None)
        if failure:
            status = 'partial' if len(points) > 1 else 'failed'
            result['error'] = failure
    except PesCancelled:
        status = 'stopped'
    except (PesError, CoordinateError, RuntimeError, ImportError, np.linalg.LinAlgError) as error:
        status = 'partial' if points else 'failed'
        result['error'] = error_details(error)
    points.sort(key=lambda item: item['ircDistance'])
    result.update(status=status, provenance=dict(ctx.provenance(), optimizer='sella-irc', sellaVersion=version('sella')))
    return result
