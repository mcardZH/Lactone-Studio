"""Fixed-step ASE Bussi dynamics with coupled, mass-weighted RATTLE."""
from __future__ import annotations

import copy
import math
import time

import ase
import numpy as np
from ase import Atoms, units
from ase.constraints import FixConstraint
from ase.md.bussi import Bussi
from ase.md.velocitydistribution import MaxwellBoltzmannDistribution

from pes_coordinates import ConstraintSpace, CoordinateError, CoordinateSet, primitive
from pes_periodic import FixedCellGeometry

DT_FS = 2
TAUT_FS = 500
POSITION_TOLERANCE = {'B': 1e-9, 'A': 1e-8, 'D': 1e-8}
VELOCITY_TOLERANCE = {'B': 1e-9, 'A': 1e-8, 'D': 1e-8}


class MDError(ValueError):
    def __init__(self, message, code='md-ase-settings'):
        super().__init__(message)
        self.code = code


def require(condition, message, code='md-ase-settings'):
    if not condition:
        raise MDError(message, code)


def constraint_rows(request, ids, reference, geometry):
    coordinates = CoordinateSet(ids, geometry=geometry)
    seen = set()
    rows = []
    for definition in request.get('constraints', ()):
        require(isinstance(definition, dict), 'MD requires a defined internal coordinate.')
        name = definition.get('id')
        kind = definition.get('type')
        target = definition.get('value')
        atom_ids = definition.get('atomIds')
        require(isinstance(name, str) and bool(name) and name not in seen and definition.get('action', 'freeze') == 'freeze'
                and type(target) in (float, int) and math.isfinite(target)
                and (kind != 'B' or target > 0) and (kind != 'A' or 0 < target < 180)
                and isinstance(atom_ids, (list, tuple)) and all(isinstance(i, str) and i in coordinates.indices for i in atom_ids),
                'Invalid MD internal-coordinate constraint.')
        images = definition.get('images')
        indices, _ = coordinates.resolve_endpoints(definition)
        if geometry is not None and images is None:
            images = geometry.coordinate_images(reference[list(indices)]).tolist()
        row = {key: copy.deepcopy(definition[key]) for key in ('id', 'type', 'atomIds', 'objectId') if key in definition}
        row.update(value=target, action='freeze')
        if images is not None:
            row['images'] = copy.deepcopy(images)
        rows.append(row)
        seen.add(name)
    return rows


def hydrogen_rows(request, ids, reference, geometry, existing):
    if not request['shakeHydrogenBonds']:
        return []
    atoms = request['structure']['atoms']
    rows = []
    for bond in request['structure'].get('bonds', ()):
        a, b = bond['a'], bond['b']
        require(type(a) is int and type(b) is int and 0 <= a < len(ids) and 0 <= b < len(ids)
                and (a != b or geometry is not None and any(bond.get('image', ()))),
                'Invalid X–H bond atom identities.')
        if not any(atoms[index]['element'] == 'H' for index in (a, b)):
            continue
        images = None
        offsets = None
        if geometry is not None:
            images = [[0, 0, 0], bond['image']] if 'image' in bond else geometry.coordinate_images(reference[[a, b]]).tolist()
            offsets = geometry.cartesian_offsets(images, 2)
        length, _ = primitive(reference[[a, b]], 'B', (0, 1), offsets)
        identity = f'ase-xh:{len(rows)}'
        while identity in existing:
            identity += '_'
        row = dict(id=identity, type='B', atomIds=[ids[a], ids[b]], value=length, constant=a == b)
        if images is not None:
            row['images'] = images
        rows.append(row)
    return rows


def connected_constraints(rows, frozen):
    """Independent graphs have independent small RATTLE systems."""
    roots = {}

    def root(atom_id):
        while roots[atom_id] != atom_id:
            roots[atom_id] = roots[roots[atom_id]]
            atom_id = roots[atom_id]
        return atom_id

    for row in rows:
        free = [atom_id for atom_id in row['atomIds'] if atom_id not in frozen]
        for atom_id in free:
            roots.setdefault(atom_id, atom_id)
        for atom_id in free[1:]:
            roots[root(atom_id)] = root(free[0])
    groups = {}
    for ordinal, row in enumerate(rows):
        first = next((atom_id for atom_id in row['atomIds'] if atom_id not in frozen), None)
        key = root(first) if first is not None else ordinal
        groups.setdefault(key, []).append(row)
    return groups.values()


class RattleBlock:
    def __init__(self, rows, ids, indices, reference, frozen, inverse_masses, geometry):
        members = sorted({indices[atom_id] for row in rows for atom_id in row['atomIds']})
        self.indices = np.array(members)
        block_ids = [ids[index] for index in members]
        self.space = ConstraintSpace(reference[self.indices], block_ids,
            dict(frozenAtomIds=frozen.intersection(block_ids), coordinates=rows), geometry=geometry)
        self.inverse_mass = np.repeat(inverse_masses[self.indices], 3)[self.space.free]
        self.sqrt_inverse = np.sqrt(self.inverse_mass)
        kinds = {row['id']: row['type'] for row in rows}
        self.position_tolerance = np.array([POSITION_TOLERANCE[kinds[key]] for key in self.space.definition_ids])
        self.velocity_tolerance = np.array([VELOCITY_TOLERANCE[kinds[key]] for key in self.space.definition_ids])
        self.rank = None
        self.record = {}

    def equations(self, positions):
        residual, derivative = self.space.equations_at(positions)
        return residual, derivative[:, self.space.free]

    def positions(self, original, trial):
        local = trial[self.indices]
        _, old_jacobian = self.equations(original[self.indices])
        weighted = old_jacobian * self.sqrt_inverse
        scale = np.linalg.norm(weighted, axis=1)
        scale[scale < np.finfo(float).tiny] = 1.
        direction = self.inverse_mass[:, None] * (old_jacobian / scale[:, None]).T
        free = self.space.free
        # RATTLE's position impulse uses the previous geometry's gradients.
        # Current gradients only linearize the nonlinear endpoint equations.
        for _ in range(100):
            residual, jacobian = self.equations(local)
            if np.all(np.abs(residual) <= self.position_tolerance):
                trial[self.indices] = local
                return
            error = np.linalg.norm(residual / scale)
            update = direction @ np.linalg.lstsq((jacobian @ direction) / scale[:, None], -residual / scale, rcond=None)[0]
            for exponent in range(18):
                candidate = local.copy()
                candidate.ravel()[free] += update * (0.5 ** exponent)
                try:
                    proposed_error = np.linalg.norm(self.equations(candidate)[0] / scale)
                except CoordinateError:
                    continue
                if proposed_error < error:
                    local = candidate
                    break
            else:
                break
        raise MDError(f'RATTLE could not satisfy the position equations {self.space.definition_ids}.', 'md-rattle-position')

    def momenta(self, positions, momenta):
        residual, jacobian = self.equations(positions[self.indices])
        weighted = jacobian * self.sqrt_inverse
        lengths = np.linalg.norm(weighted, axis=1)
        active = weighted[lengths > np.finfo(float).tiny]
        active = active / lengths[lengths > np.finfo(float).tiny, None]
        local = momenta[self.indices]
        free = self.space.free
        rank = 0
        if active.size:
            _, singular, vectors = np.linalg.svd(active, full_matrices=False)
            rank = self.space._rank(active, singular)
            basis = vectors[:rank]
            velocity_mass_weighted = local.ravel()[free] * self.sqrt_inverse
            velocity_mass_weighted -= basis.T @ (basis @ velocity_mass_weighted)
            local.ravel()[free] = velocity_mass_weighted / self.sqrt_inverse
        if self.rank is None:
            self.rank = rank
        require(rank == self.rank, 'The active RATTLE constraint rank changed.', 'md-rattle-degrees-of-freedom')
        speed_residual = units.fs * (jacobian @ (local.ravel()[free] * self.inverse_mass))
        require(np.all(np.abs(residual) <= self.position_tolerance),
                'Actual ASE positions violate the RATTLE equations.', 'md-rattle-position')
        require(np.all(np.abs(speed_residual) <= self.velocity_tolerance),
                'Actual ASE momenta violate the RATTLE tangent equations.', 'md-rattle-momenta')
        momenta[self.indices] = local
        self.record = dict(zip(self.space.definition_ids, zip(map(float, residual), map(float, speed_residual))))


class CompoundRattle(FixConstraint):
    def __init__(self, reference, masses, ids, frozen_ids, rows, shake_rows, geometry):
        self.reference = reference.copy()
        frozen = set(frozen_ids)
        self.frozen = np.array([atom_id in frozen for atom_id in ids], dtype=bool)
        self.rows = rows
        self.shake_rows = shake_rows
        indices = {identity: index for index, identity in enumerate(ids)}
        inverse_masses = 1 / masses
        active = [*rows, *(row for row in shake_rows if not row['constant'])]
        self.blocks = [RattleBlock(group, ids, indices, reference, frozen, inverse_masses, geometry)
                       for group in connected_constraints(active, frozen)]

    def adjust_positions(self, atoms, new):
        new[self.frozen] = self.reference[self.frozen]
        original = atoms.get_positions()
        for block in self.blocks:
            block.positions(original, new)

    def adjust_momenta(self, atoms, momenta):
        momenta[self.frozen] = 0
        for block in self.blocks:
            block.momenta(atoms.positions, momenta)

    def get_removed_dof(self, atoms):
        return 3 * int(np.count_nonzero(self.frozen)) + sum(block.rank for block in self.blocks)

    def adjust_forces(self, atoms, forces):
        # Velocity Verlet applies force impulses before its RATTLE projections.
        pass

    def evidence(self, atoms, enabled):
        position_delta = np.abs(atoms.positions[self.frozen] - self.reference[self.frozen])
        fixed_speed = np.abs(atoms.get_velocities()[self.frozen] * units.fs)
        fixed_position = float(position_delta.max(initial=0.))
        fixed_velocity = float(fixed_speed.max(initial=0.))
        require(fixed_position == fixed_velocity == 0., 'Actual frozen ASE positions or velocities changed.', 'md-rattle-frozen')
        records = {key: value for block in self.blocks for key, value in block.record.items()}
        # The two endpoints of a self-image bond follow the same particle.
        # Fixed lattice translations make its position and tangent identities exact.
        records.update((row['id'], (0., 0.)) for row in self.shake_rows if row['constant'])
        internal = []
        for row in self.rows:
            delta, rate = records[row['id']]
            target = row['value']
            actual = target + delta
            if row['type'] == 'D':
                actual = (actual + 180) % 360 - 180
            internal.append(dict({k:v for k,v in row.items() if k != 'value'}, target=target, actual=actual, residual=delta,
                                 velocityResidual=rate, unit='angstrom' if row['type'] == 'B' else 'degree', mode='ase-rattle'))
        shake = dict(enabled=enabled, algorithm='ASE-RATTLE', hydrogenBondCount=len(self.shake_rows),
            maxBondResidualAngstrom=max((abs(records[row['id']][0]) for row in self.shake_rows), default=0.),
            maxBondVelocityResidualAngstromPerFs=max((abs(records[row['id']][1]) for row in self.shake_rows), default=0.),
            observedBondLengthsAngstrom=[row['value'] + records[row['id']][0] for row in self.shake_rows])
        return dict(internalConstraints=internal, shake=shake,
                    fixedPositionResidualAngstrom=fixed_position, fixedVelocityResidualAngstromPerFs=fixed_velocity)


class FlatBottomSphere(FixConstraint):
    def __init__(self, settings):
        self.center = np.asarray(settings['centerAngstrom'], dtype=float)
        self.radius = settings['radiusAngstrom']
        self.spring = settings['forceConstantEVPerAngstrom2']
        require(self.center.shape == (3,) and np.isfinite(self.center).all() and
                all(type(value) in (float, int) and math.isfinite(value) and value > 0 for value in (self.radius, self.spring)),
                'The ASE sphere requires a finite center, positive radius and positive force constant.')

    def get_removed_dof(self, atoms):
        return 0

    def adjust_momenta(self, atoms, momenta):
        # The wall acts through its force, with Verlet's normal timestep.
        pass

    def penetration(self, atoms):
        delta = atoms.positions - self.center
        radius = np.linalg.norm(delta, axis=1)
        return delta, radius, np.maximum(0., radius - self.radius)

    def adjust_potential_energy(self, atoms):
        depth = self.penetration(atoms)[2]
        return float(.5 * self.spring * (depth @ depth))

    def adjust_forces(self, atoms, forces):
        delta, radius, depth = self.penetration(atoms)
        outside = depth > 0
        forces[outside] -= self.spring * (depth[outside] / radius[outside])[:, None] * delta[outside]


class Integrator:
    def __init__(self, request, context, frozen_ids, temperature):
        self.setup_started = time.perf_counter()
        self.timing = dict(setupSeconds=0., initialForceSeconds=0., stepSeconds=0.,
                           stepCalculatorSeconds=0., frameAssemblySeconds=0., frameOutputSeconds=0.)
        self.request = request
        self.context = context
        self.temperature = temperature
        self.calculator = None
        self.closed = True
        self.forces = None
        require(isinstance(context, dict) and context.get('backend') in ('libxtb', 'tblite'),
                'ASE MD requires the owned energy/force context.', 'md-ase-context')
        structure = request['structure']
        atoms = structure['atoms']
        ids = [atom['id'] for atom in atoms]
        require(ids and len(set(ids)) == len(ids) and set(frozen_ids) <= set(ids) and len(set(frozen_ids)) == len(frozen_ids),
                'ASE MD needs unique and resolved source and frozen atom identities.')
        require(type(temperature) in (float, int) and math.isfinite(temperature) and temperature > 0,
                'ASE Bussi dynamics requires a positive target temperature.')
        self.frozen_ids = list(frozen_ids)
        self.geometry = FixedCellGeometry.from_structure(structure)
        require(not self.geometry or bool(self.geometry.pbc.all()), 'ASE periodic MD requires the full fixed XYZ lattice.')
        require(not structure.get('periodicSource') or self.geometry is not None, 'ASE periodic MD requires the actual fixed XYZ lattice.')
        require(not self.geometry or not request.get('sphere'), 'A molecular sphere cannot be used in a periodic lattice.')
        require(not self.geometry or not request.get('solvation'), 'Fixed-cell ASE MD does not use molecular implicit solvent.')
        method = request['method']
        backend = 'tblite' if self.geometry and method in ('gfn1', 'gfn2') else 'libxtb'
        require(method in ('gfnff', 'gfn0', 'gfn1', 'gfn2') and context['backend'] == backend and 'device' not in request,
                'The ASE MD method and source boundary do not match the owned provider.')
        reference = np.array([[atom[k] for k in ('x', 'y', 'z')] for atom in atoms])
        require(np.isfinite(reference).all(), 'ASE MD needs finite source coordinates.')
        self.atoms = Atoms([atom['element'] for atom in atoms], positions=reference,
                          **(dict(cell=self.geometry.vectors, pbc=True) if self.geometry else {}))
        self.mass = request['hydrogenMassAmu']
        self.shake_enabled = request['shakeHydrogenBonds']
        require(type(self.mass) is int and type(self.shake_enabled) is bool and self.mass == (1 if self.shake_enabled else 4)
                and (request['method'] != 'gfnff' or not self.shake_enabled), 'ASE MD hydrogen mass must follow the applied SHAKE setting.')
        masses = self.atoms.get_masses()
        masses[self.atoms.numbers == 1] = self.mass
        self.atoms.set_masses(masses)
        rows = constraint_rows(request, ids, reference, self.geometry)
        shake = hydrogen_rows(request, ids, reference, self.geometry, {row['id'] for row in rows})
        self.rattle = CompoundRattle(reference, masses, ids, frozen_ids, rows, shake, self.geometry)
        self.wall = FlatBottomSphere(request['sphere']) if request.get('sphere') else None
        self.atoms.set_constraint([self.rattle, self.wall] if self.wall else [self.rattle])
        self.atoms.set_positions(reference)
        specified = request.get('seed') if request.get('seedMode') != 'auto' else None
        require(specified is None or type(specified) is int and 0 <= specified <= 2**32 - 1, 'Invalid ASE MD seed.')
        self.seed = specified if specified is not None else int(np.random.SeedSequence().generate_state(1)[0])
        self.seed_treatment = 'specified' if specified is not None else 'program-random'
        self.rng = np.random.default_rng(self.seed)
        MaxwellBoltzmannDistribution(self.atoms, temperature_K=temperature, rng=self.rng)
        require(self.atoms.get_number_of_degrees_of_freedom() > 0, 'ASE MD has no free dynamical degrees of freedom.')
        self.dynamics = Bussi(self.atoms, DT_FS * units.fs, temperature_K=temperature,
                              taut=TAUT_FS * units.fs, rng=self.rng)

    def start(self, check):
        from ase_md_provider import create_calculator
        self.calculator = create_calculator(self.request, self.context, check)
        self.closed = False
        self.atoms.calc = self.calculator
        force_started = time.perf_counter()
        self.timing['setupSeconds'] = force_started - self.setup_started
        self.forces = self.atoms.get_forces(md=True)
        self.check_forces()
        self.timing['initialForceSeconds'] = time.perf_counter() - force_started

    def check_forces(self):
        require(self.forces.shape == self.atoms.positions.shape and np.isfinite(self.forces).all(),
                'ASE MD energy provider returned invalid forces.', 'md-ase-forces')

    def step(self):
        started = time.perf_counter()
        calculator_before = getattr(self.calculator, 'elapsed_seconds', 0.)
        self.forces = self.dynamics.step(self.forces)
        self.check_forces()
        require(np.isfinite(self.atoms.positions).all() and np.isfinite(self.atoms.get_momenta()).all(),
                'ASE MD integration produced nonfinite state.', 'md-ase-state')
        self.timing['stepSeconds'] += time.perf_counter() - started
        self.timing['stepCalculatorSeconds'] += getattr(self.calculator, 'elapsed_seconds', 0.) - calculator_before

    def timing_evidence(self):
        whole = self.timing['stepSeconds']
        calculator = self.timing['stepCalculatorSeconds']
        return {**self.timing, 'stepIntegrationSeconds': max(0., whole - calculator)}

    def close(self):
        if self.calculator is not None and not self.closed:
            self.calculator.close()
            self.closed = True

    def metadata(self):
        return dict(driver='ase-bussi', method=self.request['method'], aseVersion=ase.__version__,
            backend=self.context['backend'], dtFs=DT_FS, thermostat='Bussi', thermostatTimeConstantFs=TAUT_FS,
            hydrogenMassAmu=self.mass, shakeHydrogenBonds=self.shake_enabled, frozenAtomIds=self.frozen_ids,
            degreesOfFreedom=self.atoms.get_number_of_degrees_of_freedom(), periodic=self.geometry is not None,
            effectiveSeed=self.seed, seedTreatment=self.seed_treatment, nativeClosed=self.closed,
            **({'solvation': self.request['solvation']} if self.request.get('solvation') else {}),
            **({'device': self.request['device']} if self.request.get('device') else {}))

    def frame(self):
        started = time.perf_counter()
        physical = float(self.atoms.get_potential_energy(apply_constraint=False))
        bias = self.wall.adjust_potential_energy(self.atoms) if self.wall else 0.
        penetration = float(self.wall.penetration(self.atoms)[2].max()) if self.wall else 0.
        kinetic = float(self.atoms.get_kinetic_energy())
        temperature = float(self.atoms.get_temperature())
        require(all(math.isfinite(v) for v in (physical, bias, physical + bias, kinetic, temperature)),
                'ASE MD has invalid energy or temperature.', 'md-ase-state')
        evidence = dict(self.metadata(), **self.rattle.evidence(self.atoms, self.shake_enabled),
            physicalEnergyEV=physical, sphereBiasEV=bias, sampledPotentialEV=physical + bias,
            maxWallPenetrationAngstrom=penetration, calculatorEvidence=self.calculator.evidence())
        atoms = copy.deepcopy(self.request['structure']['atoms'])
        for atom, point in zip(atoms, self.atoms.positions.tolist(), strict=True):
            atom.update(zip(('x', 'y', 'z'), point))
        velocities = (self.atoms.get_velocities() * units.fs).tolist()
        self.timing['frameAssemblySeconds'] += time.perf_counter() - started
        evidence['timing'] = self.timing_evidence()
        return atoms, velocities, kinetic, temperature, evidence


class ModelingSession:
    def __init__(self, request, context):
        from conformer_sampling import hydrogen_settings
        self.request = copy.deepcopy(request)
        require(request.get('dtFs', DT_FS) == DT_FS, 'ASE Bussi MD uses a fixed 2 fs timestep.')
        require(not request.get('protectedAtomIds'), 'ASE modeling MD uses exact XYZ frozen atoms.')
        shake, mass = hydrogen_settings(request)
        structure = request['structure']
        ids = [atom['id'] for atom in structure['atoms']]
        movable = request['movableAtomIds']
        require(isinstance(movable, list) and len(set(movable)) == len(movable) and set(movable) <= set(ids),
                'ASE MD requires resolved movable atoms.')
        frozen = [atom_id for atom_id in ids if atom_id not in movable]
        require('frozenAtomIds' not in request or request['frozenAtomIds'] == frozen,
                'ASE MD frozen/movable atom identities differ.')
        self.target_temperature = request['temperatureK']
        self.started = time.monotonic()
        self.paused = False
        self.stopped = False
        self.max_wall_seconds = request.get('maxWallTimeSeconds')
        self.report_every = 10
        # The ASE force-provider contract uses the same electronic snapshot
        # as modeling's native MD path.
        calculator = dict(accuracy=2, maxIterations=250, electronicTemperatureK=300)
        numerical = dict(self.request, shakeHydrogenBonds=shake, hydrogenMassAmu=mass, calculator=calculator,
            charge=structure.get('charge') if structure.get('charge') is not None else 0,
            uhf=0 if request['method'] == 'gfnff' else (structure.get('multiplicity') or 1)-1)
        self.integration = Integrator(numerical, context, frozen, self.target_temperature)
        self.last_validated = self.snapshot(0)

    def running_seconds(self):
        return time.monotonic() - self.started

    def snapshot(self, step, frame=None):
        output = copy.deepcopy(self.request['structure'])
        metadata = self.integration.metadata()
        actual = {}
        if frame is not None:
            atoms, velocities, kinetic, temperature, metadata = frame
            output['atoms'] = atoms
            output.pop('molfile', None)
            actual.update(energyEV=metadata['physicalEnergyEV'], temperatureK=temperature,
                          kineticEnergyEV=kinetic, velocitiesAngstromPerFs=velocities)
        return dict(stamp=self.request['stamp'], operation='md', step=step, timeFs=step*DT_FS,
            structure=output, movableAtomIds=self.request['movableAtomIds'],
            engine='ASE Bussi MD', engineVersion=ase.__version__, targetTemperatureK=self.target_temperature,
            timestepFs=DT_FS, aseMD=metadata, units=dict(positions='angstrom', energy='eV', time='fs', temperature='K'),
            **actual)

    def run(self, emit, controls):
        try:
            controls()
            self.integration.start(controls)
            step = 0
            while True:
                if step % self.report_every == 0:
                    self.last_validated = self.snapshot(step, self.integration.frame())
                    output_started = time.perf_counter()
                    emit('frame')
                    self.integration.timing['frameOutputSeconds'] += time.perf_counter() - output_started
                controls()
                self.integration.step()
                step += 1
        finally:
            self.integration.close()
            self.last_validated['aseMD']['nativeClosed'] = self.integration.closed


class SamplingSession:
    def __init__(self, request, context, emit, check):
        self.request = request
        self.emit = emit
        self.check = check
        self.last_frame = None
        self.frame_count = 0
        self.candidate_count = 0
        settings = request['molecularMD']
        self.steps = round(settings['durationFs'] / DT_FS)
        self.sample_interval = round(settings['sampleEveryFs'] / DT_FS)
        self.integration = Integrator(request, context, request['frozenAtomIds'], settings['temperatureK'])

    def native_closed(self):
        return self.integration.closed

    def frame(self, step, raw):
        atoms, velocities, kinetic, temperature, evidence = raw
        candidate = step == self.steps or step % self.sample_interval == 0
        value = dict(kind='frame', driver='ase-bussi', stageId='md',
            collectionId='sampled-candidates' if candidate else 'sampling-trajectory', frameIndex=self.frame_count,
            role='sampled-candidate' if candidate else 'trajectory', step=step, timeFs=step*DT_FS,
            coordinates=atoms, velocitiesAngstromPerFs=velocities,
            physicalEnergyEV=evidence['physicalEnergyEV'], sampledPotentialEV=evidence['sampledPotentialEV'],
            coreBiasEV=0., metaBiasEV=0., sphereBiasEV=evidence['sphereBiasEV'], kineticEnergyEV=kinetic, temperatureK=temperature,
            targetTemperatureK=self.integration.temperature, biasHistoryCount=0,
            diagnostics=dict(maxWallPenetrationAngstrom=evidence['maxWallPenetrationAngstrom'], shake=evidence['shake']),
            requiresUnbiasedOptimization=candidate, optimizationPerformed=False, aseMD=evidence,
            calculatorEvidence=evidence['calculatorEvidence'],
            units=dict(coordinates='angstrom', velocity='angstrom/fs', energy='eV', time='fs', temperature='K'))
        self.frame_count += 1
        self.candidate_count += int(candidate)
        self.last_frame = value
        output_started = time.perf_counter()
        self.emit(value)
        self.integration.timing['frameOutputSeconds'] += time.perf_counter() - output_started

    def run(self):
        try:
            self.check()
            self.integration.start(self.check)
            settings = self.integration.metadata()
            self.emit(dict(kind='stage', stageId='sampling', status='started', step=0,
                           configuration=self.request, integration=dict(settings, driver='ASE-Bussi')))
            for step in range(1, self.steps + 1):
                self.check()
                self.integration.step()
                if step == self.steps:
                    final = self.integration.frame()
                elif step % self.sample_interval == 0 or step % self.request['reportEvery'] == 0:
                    self.frame(step, self.integration.frame())
                    self.emit(dict(kind='progress', step=step, phase='ase-bussi',
                                   frameCount=self.frame_count, candidateCount=self.candidate_count))
        finally:
            self.integration.close()
        final[-1]['nativeClosed'] = self.native_closed()
        evaluations = final[-1]['calculatorEvidence'].get('evaluations')
        require(type(evaluations) is int and 0 < evaluations <= self.request['maxEvaluations'],
                'ASE MD provider evaluation count is absent or exceeds the request.', 'SAMPLING_EVALUATION_LIMIT')
        self.frame(self.steps, final)
        self.emit(dict(kind='progress', step=self.steps, phase='ase-bussi',
                       frameCount=self.frame_count, candidateCount=self.candidate_count))
        self.emit(dict(kind='stage', stageId='sampling', status='completed', step=self.steps,
                       candidates=self.candidate_count))
        return dict(kind='completed', driver='ase-bussi', workerSettled=True, samplingCompleted=True,
            optimizationPerformed=False, requiresUnbiasedOptimization=True, candidateCount=self.candidate_count,
            frameCount=self.frame_count, step=self.steps, evaluations=evaluations, evaluationCountSource='observed-ase-md',
            seed=self.integration.seed, lastFrame=self.last_frame, biasHistory=[],
            postSamplingPotentials=dict(core=False, metadynamics=False, sphere=False), nativeClosed=self.native_closed(),
            timing=self.integration.timing_evidence())
