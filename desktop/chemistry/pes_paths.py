"""Two-ended PES methods with explicit native/guided growing-string paths."""
from __future__ import annotations

import math
import copy
from pathlib import Path
import traceback
from types import FunctionType, SimpleNamespace

import numpy as np
from ase import Atoms, __version__ as ase_version, units
from ase.mep.neb import IDPP
from scipy import __version__ as scipy_version

from advanced_path import sidpp_tangent
from pes_coordinates import CoordinateError
from pes_core import PathRecords, PesCancelled, PesError, frame


EV_PER_ANGSTROM = units.Hartree / units.Bohr


class PathInputError(PesError):
    pass


def _int(options, name, default, minimum=1):
    value = options.get(name, default)
    if type(value) is not int or value < minimum:
        raise PathInputError(f'{name} requires an integer ≥ {minimum}')
    return value


def _positive(options, name, default):
    value = options.get(name, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise PathInputError(f'{name} requires a positive finite value')
    return float(value)


def _bool(options, name, default):
    value = options.get(name, default)
    if type(value) is not bool:
        raise PathInputError(f'{name} requires a boolean')
    return value


def _positions(structure, identities):
    if not isinstance(structure, dict) or not isinstance(structure.get('atoms'), list):
        raise PathInputError('Each path snapshot needs a structure')
    by_id = {atom['id']: atom for atom in structure['atoms']}
    if len(by_id) != len(structure['atoms']) or set(by_id) != set(identities):
        raise PathInputError('Path snapshots require identical stable atom IDs')
    if any(by_id[identity]['element'] != symbol for identity, symbol in identities.items()):
        raise PathInputError('Atom elements disagree between path snapshots')
    positions = np.asarray([[by_id[identity][axis] for axis in 'xyz'] for identity in identities], dtype=float)
    if positions.shape != (len(identities), 3) or not np.isfinite(positions).all():
        raise PathInputError('Path snapshots require finite Cartesian coordinates')
    return positions


def _anchors(request, space, count):
    options = request['parameters']
    identities = {atom['id']: atom['element'] for atom in request['structure']['atoms']}
    keyframes = options.get('keyframes', [])
    snapshots = [options.get('reactant', request['structure']),
                 *(row['structure'] for row in keyframes), options.get('product')]
    labels = [1, *(row.get('position') for row in keyframes), count]
    explicit = [(i, label) for i, label in enumerate(labels) if label not in (None, 'auto')]
    for (_, label) in explicit:
        if type(label) is not int or not 1 <= label <= count:
            raise PathInputError('A keyframe position must be an available 1-based bead number')
    for (ia, a), (ib, b) in zip(explicit, explicit[1:]):
        if b - a < ib - ia:
            raise PathInputError('Keyframe positions must preserve order and leave room for automatic positions')
        for i in range(ia + 1, ib):
            labels[i] = a + (i - ia) * (b - a) // (ib - ia)
    coordinates, used_images = [], []
    image_choices = options.get('periodicPath', {}).get('endpointImages', [None] * len(snapshots))
    if not isinstance(image_choices, list) or len(image_choices) != len(snapshots):
        raise PathInputError('Periodic endpoint images must follow the path snapshots in order')
    for index, (snapshot, choice) in enumerate(zip(snapshots, image_choices)):
        xyz = _positions(snapshot, identities)
        if space.geometry is not None:
            try:
                space.geometry.assert_same(snapshot)
                if choice is not None:
                    xyz += space.geometry.cartesian_offsets(choice, len(identities))
                    images = choice
                elif index:
                    base = coordinates[-1]
                    displacement, shifts = space.geometry.minimum_image(xyz - base)
                    xyz = base + displacement
                    images = shifts.tolist()
                else:
                    images = np.zeros_like(xyz, dtype=int).tolist()
            except ValueError as error:
                raise PathInputError(str(error)) from error
            used_images.append(images)
            if np.allclose(xyz[space.frozen], space.reference[space.frozen], atol=1e-8, rtol=0.):
                xyz[space.frozen] = space.reference[space.frozen]
        if (not np.array_equal(xyz[space.frozen], space.reference[space.frozen])
                or np.max(np.abs(space.project(xyz) - xyz)) > 1e-8):
            raise PathInputError('A path snapshot conflicts with the global freezes or exact coordinates')
        coordinates.append(xyz)
    return list(identities.values()), list(zip((label - 1 for label in labels), coordinates)), used_images


def _normalize(vector, message):
    length = float(np.linalg.norm(vector))
    if not np.isfinite(length) or length <= 1e-12:
        raise PathInputError(message)
    return vector / length


def _redistribute(images, project):
    points = np.asarray(images)
    arc = np.r_[0., np.cumsum(np.linalg.norm(np.diff(points, axis=0).reshape(len(points) - 1, -1), axis=1))]
    if np.any(np.diff(arc) <= 1e-12):
        raise PathInputError('S-IDPP reference contains coincident neighboring beads')
    redistributed = [images[0]]
    for target in np.linspace(0., arc[-1], len(points))[1:-1]:
        right = int(np.searchsorted(arc, target))
        weight = (target - arc[right - 1]) / (arc[right] - arc[right - 1])
        redistributed.append(project(points[right - 1] + weight * (points[right] - points[right - 1])))
    return [*redistributed, images[-1]]


def _sidpp_segment(first, last, count, ctx, steps_left, growth_tol, final_tol, reparameterize):
    """Grow sequential IDPP nodes, then relax the full geometric band."""
    if count == 2:
        return [first, last], {'iterations': 0, 'converged': True, 'maxObjectiveForce': None}
    space = ctx.constraints
    difference = last - first
    distance = float(np.linalg.norm(difference))
    if distance <= 1e-12:
        raise PathInputError('A S-IDPP segment requires distinct endpoints')
    spacing = distance / (count - 1)
    labels = [0, 1, count - 2, count - 1] if count > 3 else [0, 1, 2]
    images = [space.project(first + difference * label / (count - 1)) for label in labels]
    images[0], images[-1] = first, last
    left, right = 1, 1
    steps = 0
    trace = []
    geometry = space.geometry
    def distances(xyz):
        if geometry is not None:
            return geometry.pair_distances(xyz)
        return np.linalg.norm(xyz[:, None] - xyz[None, :], axis=2)

    initial_distances = distances(first)
    final_distances = distances(last)
    calculators = {label: IDPP(initial_distances + (final_distances - initial_distances) * label / (count - 1),
                               mic=geometry is not None) for label in range(1, count - 1)}
    cell = dict(cell=geometry.reduced, pbc=geometry.pbc) if geometry is not None else {}
    distinct_pairs = np.triu_indices(len(first), 1)
    last_force = None

    def relax(growing):
        nonlocal steps, last_force, spacing
        springs = np.ones(len(images) - 1)
        segment_lengths = [np.linalg.norm(b - a) for a, b in zip(images, images[1:])]
        if growing:
            if segment_lengths[left] <= 1e-12:
                raise PathInputError('The S-IDPP growing fronts coincide')
            spacing = sum(segment_lengths) / (count - 1)
            springs[left] = spacing / segment_lengths[left]
        velocity = np.zeros((len(images) - 2, *first.shape))
        while True:
            ctx.check_cancelled()
            energies, forces = [0.], []
            for label, xyz in zip(labels[1:-1], images[1:-1]):
                if np.any(distances(xyz)[distinct_pairs] <= 1e-8):
                    raise PathInputError('A S-IDPP bead contains coincident atoms')
                bead = Atoms('H' * len(xyz), positions=xyz, **cell)
                bead.calc = calculators[label]
                energies.append(float(bead.get_potential_energy()))
                forces.append(bead.get_forces())
            energies.append(0.)
            lengths = [np.linalg.norm(b - a) for a, b in zip(images, images[1:])]
            if min(lengths) <= 1e-12:
                raise PathInputError('S-IDPP reference contains coincident neighboring beads')
            for i, force in enumerate(forces, 1):
                tangent = sidpp_tangent(*images[i - 1:i + 2], energies[i - 1:i + 2])
                tangent = _normalize(space.project_vector(images[i], tangent),
                                     'S-IDPP tangent vanished in the allowed Cartesian space')
                spring = springs[i] * lengths[i] - springs[i - 1] * lengths[i - 1]
                forces[i - 1] = space.project_vector(images[i], force + (spring - np.vdot(force, tangent)) * tangent)
            forces = np.asarray(forces)
            maximum = np.max(np.abs(forces), axis=(1, 2))
            last_force = float(maximum.max())
            if not np.isfinite(last_force):
                raise PathInputError('Nonfinite S-IDPP objective gradient')
            if growing:
                frontier = [left, len(images) - 1 - right]
                ready = [i for i in frontier if maximum[i - 1] <= growth_tol]
                if ready:
                    index = ready[0]
                    tangent = sidpp_tangent(*images[index - 1:index + 2], energies[index - 1:index + 2], weighted=True)
                    tangent = _normalize(space.project_vector(images[index], tangent),
                                         'S-IDPP growth tangent vanished in the allowed Cartesian space')
                    return index, tangent
            elif last_force <= final_tol:
                return True
            if steps >= steps_left:
                return None
            velocity += .02 * forces
            overlap, force_squared = float(np.vdot(velocity, forces)), float(np.vdot(forces, forces))
            velocity[:] = forces * (overlap / force_squared) if overlap > 0 and force_squared > 0 else 0.
            displacement = .02 * velocity
            scale = np.linalg.norm(displacement, axis=2).max()
            if scale > .05:
                displacement *= .05 / scale
            for i, delta in enumerate(displacement, 1):
                images[i] = space.project(images[i] + delta)
            steps += 1

    while len(images) < count:
        frontier = relax(True)
        if frontier is None:
            return images, dict(iterations=steps, converged=False, maxObjectiveForce=last_force,
                                populatedLabels=labels, growth=trace, reparameterized=False)
        index, tangent = frontier
        trace.append({'frontier': labels[index], 'iterations': steps, 'maxObjectiveForce': last_force})
        if index == left:
            images.insert(index + 1, space.project(images[index] + spacing * tangent))
            labels.insert(index + 1, left + 1)
            left += 1
        else:
            images.insert(index, space.project(images[index] - spacing * tangent))
            labels.insert(index, count - 2 - right)
            right += 1
    if reparameterize and count > 3:
        images[:] = _redistribute(images, space.project)
    converged = bool(relax(False))
    return images, dict(iterations=steps, converged=converged, maxObjectiveForce=last_force,
                        populatedLabels=labels, growth=trace, reparameterized=reparameterize and count > 3)


def _progress(ctx, phase, completed, total=None, **details):
    payload = dict(phase=phase, completed=completed, **details)
    if total is not None:
        payload['total'] = total
    ctx.emit('progress', payload)


class _PathResult:
    def __init__(self, request, ctx=None):
        self.request = request
        self.reference = {}
        self.physical = {}
        self.history = []
        self.recorder = PathRecords(ctx) if ctx is not None and request['algorithm'] in ('ci-neb', 'de-gsm', 'fsm') else None
        self.last_phase = request['algorithm']
        self.provenance = {'algorithm': request['algorithm'], 'sIdpp': {'segments': [], 'objectiveGradientUnit': 'angstrom^-3'}}

    def make_frames(self, values, phase, series, status):
        frames = []
        for index, (xyz, energy, step, details) in sorted(values.items()):
            item = frame(self.request, xyz, energy, step, phase, series, status, bead=index + 1, **details)
            item['id'] += f':{phase}:{index + 1}'
            frames.append(item)
        return frames

    def remember_band(self, values, phase):
        self.physical = values
        self.last_phase = phase
        if self.recorder:
            step = max(row[2] for row in values.values())
            # FSM initialization can already have recorded physical rounds.
            # The first actual CI-NEB band still owns its own energy milestone.
            self.recorder.consider(self.make_frames(values, phase, 'path', 'accepted'), phase,
                                   step, first_physical=step == 0 and phase in ('ci-neb-ordinary', 'ci-neb-climb'))
        else:
            self.history.extend(self.make_frames(values, phase, 'path-iterations', 'accepted'))

    def remember_partial(self, values, phase):
        if values:
            self.recorder.consider_partial(self.make_frames(values, phase, 'path', 'partial'), phase,
                                           max(row[2] for row in values.values()))

    def finish(self, ctx, status, **details):
        if self.recorder:
            # S-IDPP is geometric only and is retained even if preparation
            # stops before a physical round becomes available.
            if not self.recorder.records and self.reference:
                phase = self.provenance.get('initialGeometryPhase', 's-idpp')
                self.recorder.consider(self.make_frames(self.reference, phase, 'path', 'geometry'),
                                       phase, 0, initial=True)
            last = self.recorder.finish()
            if last:
                self.provenance['candidateFrameIds'] = [item['id'] for item in sorted(
                    (item for item in self.recorder.records[last]['frames'] if item.get('localEnergyMaximum')),
                    key=lambda item: item['energyHartree'], reverse=True)]
            result = dict(status=status, frames=[], pathRecords=list(self.recorder.records.values()),
                          lastPathRecordId=last, series=[dict(id='path', kind='path')],
                          provenance={**self.provenance, **details, 'recordInterval': self.recorder.interval})
            if 'error' in details:
                result['error'] = details['error']
            return result
        frames = self.make_frames(self.reference, 's-idpp', 's-idpp', 'geometry')
        frames += self.history
        final = self.make_frames(self.physical, self.request['algorithm'], 'path', status)
        if final:
            length = 0.
            final[0]['arcLengthAngstrom'] = 0.
            for a, b in zip(final, final[1:]):
                if length is not None and b['bead'] == a['bead'] + 1:
                    length += float(np.linalg.norm(np.asarray(b['positions']) - a['positions']))
                else:
                    length = None
                b['arcLengthAngstrom'] = length
            peaks = []
            for a, b, c in zip(final, final[1:], final[2:]):
                if (c['bead'] == b['bead'] + 1 == a['bead'] + 2
                        and b['energyHartree'] >= max(a['energyHartree'], c['energyHartree'])
                        and b['energyHartree'] > min(a['energyHartree'], c['energyHartree'])):
                    b['localEnergyMaximum'] = True
                    peaks.append(b)
            self.provenance['candidateFrameIds'] = [item['id'] for item in sorted(
                peaks, key=lambda item: item['energyHartree'], reverse=True)]
        frames += final
        for accepted in frames:
            if accepted['seriesId'] != 'path-iterations':
                ctx.emit('frame', accepted)
        series = [{'id': identity, 'kind': kind} for identity, kind, populated in (
            ('s-idpp', 'geometry-reference', self.reference),
            ('path-iterations', 'path-history', self.history),
            ('path', 'path', final),
        ) if populated]
        result = {'status': status, 'frames': frames, 'series': series, 'provenance': {**self.provenance, **details}}
        if 'error' in details:
            result['error'] = details['error']
        return result


def _sidpp_reference(anchors, ctx, options, count, result):
    maximum = _int(options, 'sidppIterations', 7000)
    growth_tol = _positive(options, 'sidppGrowthTolerance', .01)
    final_tol = _positive(options, 'sidppFinalTolerance', .01)
    reparameterize = _bool(options, 'sidppReparameterize', True)
    metadata = result.provenance['sIdpp']
    metadata.update(maximumIterations=maximum, growthTolerance=growth_tol, finalTolerance=final_tol,
                    reparameterize=reparameterize, geometryIterations=0,
                    keyframeBeads=[i + 1 for i, _ in anchors[1:-1]])
    consumed = 0
    for i, xyz in anchors:
        result.reference[i] = (xyz, None, 0, {'initialAnchor': True})
    for (lo, first), (hi, last) in zip(anchors, anchors[1:]):
        _progress(ctx, 's-idpp', len(result.reference), count)
        images, trace = _sidpp_segment(first, last, hi - lo + 1, ctx, maximum - consumed,
                                       growth_tol, final_tol, reparameterize)
        consumed += trace['iterations']
        metadata['geometryIterations'] = consumed
        metadata['segments'].append({'firstBead': lo + 1, 'lastBead': hi + 1, **trace})
        for label, xyz in zip(trace.get('populatedLabels', range(len(images))), images):
            i = lo + label
            if i not in (lo, hi):
                result.reference[i] = (xyz, None, consumed, {'initialAnchor': False})
        if not trace['converged']:
            return None
    _progress(ctx, 's-idpp', count, count)
    return [result.reference[i][0] for i in range(count)]


def _bounded_project(space, base, displacement, limit):
    """Limit the actual accepted Cartesian step, including retraction."""
    proposed = np.max(np.abs(displacement))
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
    raise PathInputError('Could not retract the path step inside its Cartesian bounds')


def _rigid_basis(xyz):
    centered = xyz - xyz.mean(axis=0)
    translations = np.tile(np.eye(3), (len(xyz), 1))
    rotations = np.column_stack([np.cross(axis, centered).ravel() for axis in np.eye(3)])
    vectors, singular_values, _ = np.linalg.svd(np.column_stack((translations, rotations)), full_matrices=False)
    return vectors[:, singular_values > 1e-10 * singular_values[0]]


def _fsm_node(seed, tangent, ctx, node_steps, line_search, box, *, node_id=None, observe=None):
    from pes_strings import optimize_fsm_node
    identity = node_id if node_id is not None else ctx.new_node_id('fsm-node')
    return optimize_fsm_node(seed, tangent, ctx, node_steps, line_search, box,
                             node_id=identity, observe=observe)

def _fsm(reference, ctx, options, result, *, anchors=None, growth=None, phase='fsm-growth'):
    growth = options.get('fsmGrowth', 'sidpp') if growth is None else growth
    if growth not in ('native', 'sidpp'):
        raise PathInputError('fsmGrowth requires native or sidpp')
    node_steps = _int(options, 'fsmNodeSteps', 2)
    line_search = _int(options, 'fsmLineSearchSteps', 3)
    box = _positive(options, 'fsmBoxAngstrom', .30)
    result.provenance.update(driver='two-ended freezing string', optimizer='SciPy L-BFGS-B', scipyVersion=scipy_version,
                             growthReference='native-cartesian' if growth == 'native' else 's-idpp',
                             nodeSteps=node_steps, maxLineSearchSteps=line_search,
                             nodeBoxHalfWidthAngstrom=box, localCoordinates='Cartesian', growthRounds=0,
                             gradientProjection='fixed path-normal variables with exact physical-energy pullback',
                             nodeElectronicStates='independent stable physical node IDs; cold new nodes')
    anchors = anchors or [(0, reference[0]), (len(reference) - 1, reference[-1])]
    anchor_indices = [index for index, _ in anchors]
    result.provenance['keyframeBeads'] = [index + 1 for index in anchor_indices[1:-1]]
    result.provenance['segmentBeads'] = [[lo + 1, hi + 1] for lo, hi in zip(anchor_indices, anchor_indices[1:])]
    for index in anchor_indices:
        xyz = reference[index]
        identity = ctx.new_node_id('fsm-endpoint')
        try:
            energy = ctx.evaluate(xyz, node_id=identity)['energyHartree']
            result.physical[index] = (xyz, energy, 0,
                {'role': 'endpoint' if index in (0, len(reference) - 1) else 'keyframe', 'nodeId': identity})
        except Exception:
            if result.physical:
                result.remember_partial(dict(result.physical), phase + '-interrupted')
            raise
        finally:
            ctx.release_node(identity)
    result.remember_band(dict(result.physical), phase)
    growth_round = 0
    for segment_index, (start, end) in enumerate(zip(anchor_indices, anchor_indices[1:])):
        lo, hi = start, end
        while hi - lo > 1:
            ctx.check_cancelled()
            growth_round += 1
            left = result.physical[lo][0]
            right = result.physical[hi][0]
            left_shift = left - reference[lo] if growth == 'sidpp' else None
            right_shift = right - reference[hi] if growth == 'sidpp' else None

            def corrected_reference(i):
                fraction = (i - lo) / (hi - lo)
                proposed = ((1 - fraction) * left + fraction * right if growth == 'native'
                            else reference[i] + (1 - fraction) * left_shift + fraction * right_shift)
                return ctx.constraints.project(proposed)

            indices = sorted({lo + 1, hi - 1})
            for index in indices:
                seed = corrected_reference(index)
                tangent = (right - left if growth == 'native'
                           else corrected_reference(index + 1) - corrected_reference(index - 1))
                identity = ctx.new_node_id('fsm-node')

                def retain_candidate(xyz, energy):
                    result.physical[index] = (xyz.copy(), energy, growth_round,
                        {'role': 'valid-node-candidate', 'nodeId': identity, 'segmentIndex': segment_index,
                         'localStatus': 'in-progress'})
                try:
                    xyz, energy, evidence = _fsm_node(seed, tangent, ctx, node_steps, line_search, box,
                                                      node_id=identity, observe=retain_candidate)
                    result.physical[index] = (xyz, energy, growth_round,
                        {'role': 'frozen-node', 'nodeId': identity, 'segmentIndex': segment_index, **evidence})
                except Exception:
                    result.remember_partial(dict(result.physical), phase + '-interrupted')
                    raise
                finally:
                    ctx.release_node(identity)
                _progress(ctx, phase, len(result.physical), len(reference), rounds=growth_round,
                          segmentIndex=segment_index)
            lo, hi = indices[0], indices[-1]
            result.provenance['growthRounds'] = growth_round
            result.remember_band(dict(result.physical), phase)
    return 'completed'


def pygsm_molecule(request, ctx, initial, drives=None, *, topology_geometries=(), observe=None, node_owners=None):
    """Prepare pyGSM's DLC basis and a per-node view of the common evaluator.

    `drives` uses pyGSM's 1-based native tuples. Additional geometries supply
    primitive topologies to a DE string before the first node is grown.
    """
    # pyGSM internally uses these same legacy imports and compares primitive
    # classes by identity, so use the exact classes that its native code sees.
    import pyGSM
    from coordinate_systems import (Angle, DelocalizedInternalCoordinates, Dihedral, Distance,
                                    PrimitiveInternalCoordinates, Topology)
    from pyGSM.molecule import Molecule
    from pyGSM.potential_energy_surfaces import PES
    from utilities import elements, units as gsm_units

    space = ctx.constraints
    frozen = np.flatnonzero(space.frozen).tolist()
    symbols = [atom['element'] for atom in request['structure']['atoms']]
    table = elements.ElementData()
    element_data = [table.from_symbol(symbol) for symbol in symbols]
    drives = drives or []
    added_bonds = [tuple(int(atom) - 1 for atom in drive[1:3]) for drive in drives if drive[0] == 'ADD']
    owned_node_ids = node_owners if node_owners is not None else set()

    class ContextLot:
        do_coupling = False

        def __init__(self, geom, node_id=0):
            self.geom = geom
            self.node_id = node_id
            self.electronic_node_id = ctx.new_node_id('pygsm-node')
            owned_node_ids.add(self.electronic_node_id)
            self.owned_node_ids = owned_node_ids
            self.currentCoords = None
            self.observation = None
            self.hasRanForCurrentCoords = False

        @classmethod
        def copy(cls, lot, options, copy_wavefunction=True):
            return cls(lot.geom, options.get('node_id', lot.node_id))

        def evaluate(self, positions):
            ctx.check_cancelled()
            xyz = np.asarray(positions).reshape(-1, 3)
            if self.hasRanForCurrentCoords and np.array_equal(xyz, self.currentCoords):
                return self.observation
            exact = space.project(xyz)
            if np.max(np.abs(exact - xyz)) > 1e-8:
                raise PathInputError('pyGSM attempted to evaluate a geometry outside the exact global constraints')
            self.observation = ctx.evaluate(exact, node_id=self.electronic_node_id)
            self.currentCoords = xyz.copy()
            self.hasRanForCurrentCoords = True
            if observe is not None:
                observe(xyz, self.observation)
            return self.observation

        def get_energy(self, positions, multiplicity, state, runtype=None):
            return self.evaluate(positions)['energyHartree'] * gsm_units.KCAL_MOL_PER_AU

        def get_gradient(self, positions, multiplicity, state, frozen_atoms=None):
            xyz = np.asarray(positions).reshape(-1, 3)
            value = self.evaluate(xyz)
            return space.project_vector(xyz, value['gradientHartreePerBohr']) * gsm_units.ANGSTROM_TO_AU

    class ConstrainedDLC(DelocalizedInternalCoordinates):
        def newCartesian(self, xyz, dQ, frozen_atoms=None, verbose=True):
            ctx.check_cancelled()
            # The DLC step can pass through a singular periodic B/A/D geometry.
            # Backtrack the proposal in its own DLC space before evaluating E/G.
            scales = (1.,) if ctx.geometry is None else (1., .5, .25, .125, .0625, .03125)
            for scale in scales:
                ctx.check_cancelled()
                moved = super().newCartesian(xyz, scale * dQ, frozen_atoms=frozen or frozen_atoms, verbose=verbose)
                try:
                    return space.project(np.asarray(moved).reshape(-1, 3))
                except CoordinateError:
                    if scale == scales[-1]:
                        raise

    def primitives_at(xyz, extra_bonds=()):
        topology = Topology.build_topology(xyz=xyz, atoms=element_data, extra_bonds=list(extra_bonds))
        return PrimitiveInternalCoordinates.from_options(xyz=xyz, atoms=element_data, topology=topology, connect=True)

    initial = space.project(initial)
    primitives = primitives_at(initial, added_bonds)
    def single_primitive_block(basis):
        # An endpoint union can introduce a primitive crossing the original
        # fragment windows. Every derivative in this block sees all atoms.
        basis.block_info = [(0, len(initial), 0, len(basis.Internals), 'reg')]

    if topology_geometries or drives:
        single_primitive_block(primitives)
    for geometry in topology_geometries:
        ctx.check_cancelled()
        other = primitives_at(geometry)
        single_primitive_block(other)
        primitives.add_union_primitives(other)
    for drive in drives:
        kind = drive[0]
        if kind in ('ADD', 'BREAK'):
            primitives.add(Distance(*(int(atom) - 1 for atom in drive[1:3])))
        elif kind == 'ANGLE':
            primitives.add(Angle(*(int(atom) - 1 for atom in drive[1:4])))
        elif kind in ('TORSION', 'DIHEDRAL'):
            primitives.add(Dihedral(*(int(atom) - 1 for atom in drive[1:5])))
    if ctx.geometry is not None:
        from coordinate_systems.slots import CartesianX, CartesianY, CartesianZ
        # A fragment split across a cell face can have no local-distance
        # primitives in pyGSM's molecular topology. Include the active
        # Cartesian directions in the same DLC basis so an ICTAN node still
        # has independent transverse directions on the fixed-cell surface.
        frozen_indices = set(frozen)
        for index in range(len(initial)):
            if index not in frozen_indices:
                for coordinate in (CartesianX, CartesianY, CartesianZ):
                    primitives.add(coordinate(index, w=1.0))
    if drives or ctx.geometry is not None:
        single_primitive_block(primitives)
    coordinates = ConstrainedDLC.from_options(xyz=initial, atoms=element_data, connect=True, primitives=primitives)
    geometry = [[symbol, *xyz] for symbol, xyz in zip(symbols, initial)]
    lot = ContextLot(geometry)
    surface = PES.from_options(lot=lot, ad_idx=0, multiplicity=int(request.get('uhf', 0)) + 1)
    return Molecule.from_options(geom=geometry, PES=surface, coord_obj=coordinates, Form_Hessian=True,
                                 frozen_atoms=frozen or None)


def _write_gsm_diagnostic_xyz(filename, geometries, energies, *, scale, metadata, scope):
    from utilities import manage_xyz

    filename = Path(filename)
    try:
        filename.parent.mkdir(parents=True, exist_ok=True)
        manage_xyz.write_xyzs_w_comments(str(filename), geometries, energies, scale=scale)
    except OSError as error:
        warning = metadata.setdefault('xyzDiagnosticWriteFailures', {'count': 0, 'byScope': {}})
        warning['count'] += 1
        warning['byScope'][scope] = warning['byScope'].get(scope, 0) + 1
        warning['last'] = dict(filename=filename.name, message=str(error))


def pygsm_optimizer(ctx, *, rms, gmax, dmax, climb, metadata):
    """Use the native DLC optimizer with task-owned optional per-node output."""
    import pyGSM
    from optimizers import eigenvector_follow

    def write_node_xyz(filename, geometries, energies, *, scale):
        if ctx.workspace is not None:
            _write_gsm_diagnostic_xyz(filename, geometries, energies, scale=scale, metadata=metadata, scope='node')

    # The locked optimizer writes optional XYZ through its own module global,
    # separately from the whole-round writer hook. Bind this invocation's
    # writer without changing the imported dependency or its shared globals.
    native_optimize = eigenvector_follow.optimize
    globals_with_writer = {**native_optimize.__globals__, 'manage_xyz': SimpleNamespace(
        write_xyzs_w_comments=write_node_xyz)}
    optimize = FunctionType(native_optimize.__code__, globals_with_writer, native_optimize.__name__,
                            native_optimize.__defaults__, native_optimize.__closure__)
    optimize.__kwdefaults__ = native_optimize.__kwdefaults__

    class ContextOptimizer(eigenvector_follow):
        def optimize(self, molecule, *args, **kwargs):
            ctx.check_cancelled()
            if ctx.workspace is not None:
                token = str(molecule.PES.lot.electronic_node_id).replace(':', '_')
                kwargs['path'] = str(Path(ctx.workspace) / 'pygsm' / f'{molecule.node_id}-{token}')
            return optimize(self, molecule, *args, **kwargs)

    return ContextOptimizer.from_options(OPTTHRESH=rms, conv_gmax=gmax, DMAX=dmax, opt_climb=climb,
                                         update_hess_in_bg=not climb, print_level=0)


def _gsm_observation(lot, xyz, *, evaluate):
    if lot.hasRanForCurrentCoords and np.array_equal(xyz, lot.currentCoords):
        return lot.observation
    return lot.evaluate(xyz) if evaluate else None


def _de_gsm_segment(reference, ctx, options, result, *, offset=0, segment_index=0,
                    growth='sidpp', segmented=False, endpoint_nodes=None, node_sink=None,
                    growth_only=False, prepared_nodes=None, release_nodes=True, growth_budget=None):
    import pyGSM
    from pyGSM.growing_string_methods.de_gsm import DE_GSM as NativeDEGSM
    from pyGSM.molecule import Molecule

    growth_rounds = _int(options, 'gsmGrowthRounds', 50) if growth_budget is None else growth_budget
    optimization_rounds = _int(options, 'gsmOptimizationRounds', 50)
    node_steps = _int(options, 'gsmNodeSteps', 3)
    has_gradient_limits = 'gsmRmsGradient' in options or 'gsmMaxGradient' in options
    preset = options.get('gsmConvergencePreset', 'custom' if has_gradient_limits else 'loose')
    defaults = {'loose': (.002, .001), 'normal': (.001, .0005),
                'medium': (.001, .0005), 'tight': (.0005, .00025)}
    if options.get('policyVersion') == 'v212' and preset != 'custom':
        if preset not in defaults:
            raise PathInputError('Unknown GSM convergence preset')
        maximum, rms = defaults[preset]
    else:
        rms = _positive(options, 'gsmRmsGradient', .0005)
        maximum = _positive(options, 'gsmMaxGradient', .001)
    add_node = _positive(options, 'gsmAddNodeTolerance', .1)
    climb = _bool(options, 'gsmClimb', True)
    dmax = _positive(options, 'gsmDmax', .1)
    count = len(reference)
    global_metadata = result.provenance
    global_metadata['pygsmVersion'] = pyGSM.__version__
    metadata = {}
    if prepared_nodes is None:
        global_metadata.setdefault('segments', []).append(metadata)
    else:
        global_metadata['globalOptimization'] = metadata
    metadata.update(driver='pyGSM DE_GSM', pygsmVersion=pyGSM.__version__, internalCoordinates='DLC',
                    growthReference='native-dlc' if growth == 'native' else 's-idpp', optimizer='eigenvector_follow',
                    firstBead=offset + 1, lastBead=offset + count, segmentIndex=segment_index,
                    maximumGrowthRounds=growth_rounds,
                    maximumOptimizationRounds=optimization_rounds, nodeSteps=node_steps,
                    nativeRmsGradient=rms, nativeMaxGradient=maximum, nativeAddNodeTolerance=add_node,
                    initialNativeDmax=dmax, climbRequested=climb, growthRounds=0, optimizationRounds=0,
                    fixedTargetEdgeAugmentationRequests=0, nativeRoundCriteria=[])
    if endpoint_nodes is None:
        reactant = pygsm_molecule(result.request, ctx, reference[0], topology_geometries=[reference[-1]])
        product = Molecule.copy_from_options(reactant, xyz=reference[-1], new_node_id=count - 1, copy_wavefunction=False)
    else:
        reactant, product = endpoint_nodes
        reactant.node_id, product.node_id = 0, count - 1
    metadata['optimizationScope'] = 'complete-string' if prepared_nodes is not None else 'segment'
    optimizer = pygsm_optimizer(ctx, rms=rms, gmax=maximum, dmax=dmax, climb=climb, metadata=metadata)

    def snapshot(gsm, stage, *, evaluate=False, interrupted=False):
        stage_step = metadata['growthRounds'] if stage == 'growth' else metadata['optimizationRounds']
        step = global_metadata['growthRounds'] + global_metadata['optimizationRounds']
        states = dict(result.physical)
        observed = False
        incomplete = interrupted
        for index, node in enumerate(gsm.nodes):
            if node is None:
                continue
            xyz = node.xyz.copy()
            lot = node.PES.lot
            try:
                observation = _gsm_observation(lot, xyz, evaluate=evaluate)
            except PesCancelled:
                raise
            except Exception as error:
                incomplete = True
                observation = None
                warning = metadata.setdefault('pathObservationFailures', {'count': 0})
                warning['count'] += 1
                warning['last'] = dict(bead=offset + index + 1, step=step, stage=stage,
                                       code=getattr(error, 'code', type(error).__name__), message=str(error))
                # A node outside the exact geometry contract cannot be indexed.
                if isinstance(error, (PathInputError, CoordinateError)):
                    states.pop(offset + index, None)
                    continue
            if observation is None and not evaluate and not interrupted:
                return False
            observed |= observation is not None
            role = 'endpoint' if index in (0, count - 1) else 'grown-node'
            details = {'role': role, 'stageStep': stage_step, 'nodeId': lot.electronic_node_id,
                       'optimizationScope': metadata['optimizationScope'],
                       **({'energyUnavailable': True} if observation is None else {})}
            if prepared_nodes is None:
                details.update(segmentIndex=segment_index, segmentFirstBead=offset+1,
                               segmentLastBead=offset+count, localBead=index+1)
            else:
                details['sourceKeyframe'] = index+1 in global_metadata.get('keyframeBeads', [])
            states[offset + index] = (xyz, observation['energyHartree'] if observation else None, step, details)
        if not observed:
            return False
        phase = f'de-gsm-segment-{segment_index + 1}-{stage}' if segmented else f'de-gsm-{stage}'
        if incomplete or any(row[1] is None for row in states.values()):
            result.physical = states
            result.remember_partial(states, phase if interrupted else phase + '-incomplete')
        else:
            result.remember_band(states, phase)
        return True

    class DE_GSM(NativeDEGSM):
        # Native pyGSM selects its two-ended tangents by this class name.
        def _add_reference_node(self, *, left):
            ctx.check_cancelled()
            lower, upper = self.nR - 1, self.nnodes - self.nP
            index = lower + 1 if left else upper - 1
            frontier = lower if left else upper
            if lower >= index or index >= upper or self.nodes[index] is not None:
                raise PathInputError('DE-GSM attempted to exceed its target node positions')
            fraction = (index - lower) / (upper - lower)
            left_shift = self.nodes[lower].xyz - reference[lower]
            right_shift = self.nodes[upper].xyz - reference[upper]
            seed = ctx.constraints.project(reference[index] + (1 - fraction) * left_shift + fraction * right_shift)
            self.nodes[index] = Molecule.copy_from_options(self.nodes[frontier], xyz=seed, new_node_id=index)
            self.optimizer[index].DMAX = self.optimizer[frontier].DMAX
            self.active[index] = True
            self.current_nnodes += 1
            if left:
                self.nR += 1
            else:
                self.nP += 1

        def add_GSM_nodeR(self, newnodes=1):
            if growth == 'native':
                return super().add_GSM_nodeR(newnodes)
            for _ in range(newnodes):
                self._add_reference_node(left=True)

        def add_GSM_nodeP(self, newnodes=1):
            if growth == 'native':
                return super().add_GSM_nodeP(newnodes)
            for _ in range(newnodes):
                self._add_reference_node(left=False)

        def mult_steps(self, n, opt_steps):
            return opt_steps

        def optimize_iteration(self, opt_steps):
            ctx.check_cancelled()
            stage = 'optimization' if self.done_growing else 'growth'
            criteria = {
                'phase': stage,
                'climbing': bool(self.climb),
                'segmentIndex': segment_index,
                'activeNodes': [{'bead': offset + index + 1, 'localBead': index + 1, 'rms': float(opt.conv_grms),
                                 'maximum': float(opt.conv_gmax), 'dmax': float(opt.DMAX)}
                                for index, opt in enumerate(self.optimizer) if self.active[index]],
            }
            metadata['nativeRoundCriteria'].append(criteria)
            global_metadata.setdefault('nativeRoundCriteria', []).append(criteria)
            super().optimize_iteration(opt_steps)
            rounds = stage + 'Rounds'
            metadata[rounds] += 1
            global_metadata[rounds] += 1
            # This is the running producer boundary. Evaluate missing current
            # node energies here; reading/plotting a recorded round never does.
            actual_stage = 'climb' if self.done_growing and self.climb else stage
            metadata['lastActualStage'] = actual_stage
            snapshot(self, actual_stage, evaluate=True)
            if self.done_growing:
                _progress(ctx, 'de-gsm-optimization', global_metadata[rounds], segmentIndex=segment_index)
            else:
                _progress(ctx, 'de-gsm-growth', self.current_nnodes, count, rounds=global_metadata[rounds], segmentIndex=segment_index)

        def _record_edge_augmentation(self):
            metadata['fixedTargetEdgeAugmentationRequests'] += 1
            metadata['lastEdgeAugmentationRound'] = metadata['optimizationRounds']

        def add_node_before_TS(self):
            self._record_edge_augmentation()

        def add_node_after_TS(self):
            self._record_edge_augmentation()

        def set_stage(self, *args, **kwargs):
            changed = super().set_stage(*args, **kwargs)
            metadata['lastOptimizationStageChanged'] = bool(changed)
            return changed

    def write_native(name, geometries, energies, gradient_rms, energy_differences):
        # The product stores exact-coordinate/evaluator result series. Native
        # rounded XYZ diagnostics are optional; keep them in the run workspace.
        if ctx.workspace is not None:
            directory = Path(ctx.workspace) / 'pygsm' / ('complete-string' if prepared_nodes is not None else f'segment-{segment_index + 1}')
            _write_gsm_diagnostic_xyz(directory / Path(name).name, geometries, energies, scale=1.,
                                      metadata=metadata, scope='round')

    gsm = DE_GSM.from_options(reactant=reactant, product=product, nnodes=count, optimizer=optimizer,
                              CONV_TOL=rms, CONV_gmax=maximum, ADD_NODE_TOL=add_node,
                              growth_direction=0, mp_cores=1, print_level=0, xyz_writer=write_native)
    try:
        if prepared_nodes is not None:
            gsm.nodes = [prepared_nodes[index] for index in range(count)]
            for index, node in enumerate(gsm.nodes):
                node.node_id = index
            gsm.current_nnodes = count
            gsm.nR, gsm.nP = count - 1, 1
            gsm.active = [False] + [True] * (count - 2) + [False]
            gsm.done_growing = True
            metadata['movableInternalBeads'] = list(range(2, count))
        gsm.set_V0()
        snapshot(gsm, 'optimization' if prepared_nodes is not None else 'growth', evaluate=True)
        if prepared_nodes is None:
            gsm.add_GSM_nodes(min(2, count - 2))
            _progress(ctx, 'de-gsm-growth', gsm.current_nnodes, count)
        if not gsm.check_if_grown():
            # The locked native grow loop starts at zero and stops only when
            # iteration > max_iters.
            if growth_rounds > 0:
                gsm.grow_string(max_iters=growth_rounds - 1, max_opt_steps=node_steps)
        if not gsm.check_if_grown():
            snapshot(gsm, 'growth', evaluate=True)
            metadata['status'] = 'not-converged'
            return 'not-converged'
        if growth_only:
            snapshot(gsm, 'growth', evaluate=True)
            metadata['status'] = 'grown'
            return 'grown'
        gsm.done_growing = True
        _progress(ctx, 'de-gsm-growth', gsm.current_nnodes, count)
        gsm.reparameterize()
        gsm.optimize_string(max_iter=optimization_rounds, opt_steps=node_steps, rtype=int(climb))
        snapshot(gsm, metadata.get('lastActualStage', 'optimization'), evaluate=True)
    except Exception:
        snapshot(gsm, 'interrupted', interrupted=True)
        raise
    finally:
        if node_sink is not None:
            node_sink.update({offset + index: node for index, node in enumerate(gsm.nodes) if node is not None})
        if release_nodes:
            for identity in tuple(reactant.PES.lot.owned_node_ids):
                ctx.release_node(identity)
            reactant.PES.lot.owned_node_ids.clear()
    metadata['nativeClimbEnabledAtEnd'] = bool(gsm.climb)
    metadata['nativeStoppedAtIntermediate'] = not gsm.tscontinue
    unresolved_edge = metadata.get('lastEdgeAugmentationRound') == metadata['optimizationRounds']
    completed = (gsm.isConverged and gsm.tscontinue and not gsm.ran_out and not unresolved_edge
                 and not metadata.get('lastOptimizationStageChanged'))
    status = 'completed' if completed else 'not-converged'
    metadata['status'] = status
    return status


def _de_gsm_complete_string(reference, ctx, options, result, anchors, growth):
    """Grow anchored segments, then optimize one common DLC string.

    The primitive union and physical node objects are shared from the outset.
    Thus the complete-string phase keeps each node's own electronic owner and
    admits all internal keyframes as ordinary movable nodes, without adding a
    second per-segment optimization budget.
    """
    # The pinned pyGSM entrypoint establishes its legacy sibling import path.
    from pyGSM.growing_string_methods.de_gsm import DE_GSM as _NativeDEGSM
    from pyGSM.molecule import Molecule
    owners = set()
    nodes = {}
    growth_limit = _int(options, 'gsmGrowthRounds', 50)
    result.provenance['maximumGrowthRounds'] = growth_limit
    result.provenance['maximumOptimizationRounds'] = _int(options, 'gsmOptimizationRounds', 50)
    try:
        root = pygsm_molecule(result.request, ctx, anchors[0][1],
                              topology_geometries=[xyz for _, xyz in anchors[1:]], node_owners=owners)
        for index, xyz in anchors:
            nodes[index] = root if index == 0 else Molecule.copy_from_options(root, xyz=xyz, new_node_id=index,
                                                                              copy_wavefunction=False)
            lot = nodes[index].PES.lot
            observation = lot.observation if lot.hasRanForCurrentCoords and np.array_equal(xyz, lot.currentCoords) else None
            result.physical[index] = (xyz, observation['energyHartree'] if observation else None, 0,
                                      {'role': 'endpoint' if index in (0, len(reference)-1) else 'keyframe',
                                       'nodeId': lot.electronic_node_id})
        for segment_index, ((lo, _), (hi, _)) in enumerate(zip(anchors, anchors[1:])):
            ctx.check_cancelled()
            if hi-lo == 1:
                continue
            status = _de_gsm_segment(reference[lo:hi+1], ctx, options, result, offset=lo,
                                      segment_index=segment_index, growth=growth, segmented=len(anchors)>2,
                                      endpoint_nodes=(nodes[lo], nodes[hi]), node_sink=nodes,
                                      growth_only=True, release_nodes=False,
                                      growth_budget=max(0, growth_limit-result.provenance['growthRounds']))
            if status != 'grown':
                return 'not-converged'
        if set(nodes) != set(range(len(reference))):
            raise PathInputError('Segmented GSM did not produce every requested node')
        if len(reference) == 2:
            for index, node in nodes.items():
                observation = node.PES.lot.evaluate(node.xyz)
                result.physical[index] = (node.xyz.copy(), observation['energyHartree'], 0,
                                          {'role': 'endpoint', 'nodeId': node.PES.lot.electronic_node_id})
            result.remember_band(dict(result.physical), 'de-gsm-growth')
            return 'completed'
        complete_reference = [nodes[index].xyz.copy() for index in range(len(reference))]
        result.provenance['optimizationScope'] = 'complete-string'
        result.provenance['movableKeyframeBeads'] = [index+1 for index, _ in anchors[1:-1]]
        result.provenance['keyframeNodeIdsAtHandoff'] = {
            str(index+1): nodes[index].PES.lot.electronic_node_id for index, _ in anchors[1:-1]}
        return _de_gsm_segment(complete_reference, ctx, options, result, growth=growth,
                                endpoint_nodes=(nodes[0], nodes[len(reference)-1]), prepared_nodes=nodes,
                                release_nodes=False)
    finally:
        for identity in tuple(owners):
            ctx.release_node(identity)
        owners.clear()


def _de_gsm(reference, ctx, options, result, *, anchors=None):
    modern = options.get('executionProfile') == 'pes-v222'
    growth = options.get('gsmGrowth', 'native' if modern else 'sidpp')
    if growth not in ('native', 'sidpp'):
        raise PathInputError('gsmGrowth requires native or sidpp')
    anchors = anchors or [(0, reference[0]), (len(reference) - 1, reference[-1])]
    metadata = result.provenance
    metadata.update(driver='pyGSM DE_GSM', optimizer='eigenvector_follow', internalCoordinates='DLC',
                    growthReference='native-dlc' if growth == 'native' else 's-idpp',
                    nodeElectronicStates='independent stable physical node IDs; cold new nodes',
                    growthRounds=0, optimizationRounds=0,
                    keyframeBeads=[index + 1 for index, _ in anchors[1:-1]],
                    segmentBeads=[[lo + 1, hi + 1] for (lo, _), (hi, _) in zip(anchors, anchors[1:])])
    if options.get('pathSemantics') == 'v223':
        return _de_gsm_complete_string(reference, ctx, options, result, anchors, growth)
    statuses = []
    for segment_index, ((lo, _), (hi, _)) in enumerate(zip(anchors, anchors[1:])):
        ctx.check_cancelled()
        if hi - lo == 1:
            # Consecutive explicit anchors have no movable interior node.
            for index in (lo, hi):
                xyz = reference[index]
                if index in result.physical and np.array_equal(result.physical[index][0], xyz):
                    continue
                identity = ctx.new_node_id('gsm-anchor')
                try:
                    raw = ctx.evaluate(xyz, node_id=identity)
                    result.physical[index] = (xyz, raw['energyHartree'], metadata['growthRounds'] + metadata['optimizationRounds'],
                                               {'role': 'endpoint', 'segmentIndex': segment_index, 'nodeId': identity})
                finally:
                    ctx.release_node(identity)
            result.remember_band(dict(result.physical), f'de-gsm-segment-{segment_index + 1}-anchors')
            statuses.append('completed')
            continue
        status = _de_gsm_segment(reference[lo:hi + 1], ctx, options, result, offset=lo,
                                  segment_index=segment_index, growth=growth, segmented=len(anchors) > 2)
        statuses.append(status)
    return 'completed' if all(status == 'completed' for status in statuses) else 'not-converged'


def run(request, ctx):
    options = request.get('parameters', {})
    algorithm = request['algorithm']
    count = _int(options, 'beads', 12, minimum=2 if algorithm in ('de-gsm', 'fsm') else 3)
    result = _PathResult(request, ctx)
    try:
        ctx.check_cancelled()
        symbols, anchors, anchor_images = _anchors(request, ctx.constraints, count)
        if anchor_images:
            result.provenance['periodicPath'] = dict(endpointImages=anchor_images,
                                                      anchorBeads=[index + 1 for index, _ in anchors])
        native_gsm = (algorithm == 'de-gsm' and options.get('gsmGrowth',
                      'native' if options.get('executionProfile') == 'pes-v222' else 'sidpp') == 'native')
        initializer = options.get('pathInitializer', 'sidpp') if algorithm == 'ci-neb' else None
        if initializer is not None and initializer not in ('sidpp', 'fsm'):
            raise PathInputError('pathInitializer requires sidpp or fsm')
        fsm_growth = options.get('fsmGrowth', 'sidpp')
        if algorithm == 'fsm' and fsm_growth not in ('native', 'sidpp'):
            raise PathInputError('fsmGrowth requires native or sidpp')
        native_fsm = ((algorithm == 'fsm' and fsm_growth == 'native')
                      or initializer == 'fsm')
        if native_gsm or native_fsm:
            # Unpopulated labels are not Cartesian guesses or physical nodes.
            # Native DLC growth consumes only each segment's two endpoints.
            reference = [None] * count
            for index, xyz in anchors:
                reference[index] = xyz
            result.reference = {index: (xyz, None, 0, {'initialAnchor': True}) for index, xyz in anchors}
            result.provenance['sIdpp'] = {'used': False, 'segments': []}
            initial_phase = 'native-dlc-initial' if native_gsm else 'fsm-native-initial'
        else:
            reference = _sidpp_reference(anchors, ctx, options, count, result)
            result.provenance['sIdpp']['used'] = True
            initial_phase = 's-idpp'
        result.provenance['initialGeometryPhase'] = initial_phase
        if reference is None:
            return result.finish(ctx, 'not-converged', reason='s-idpp-geometry-iteration-limit')
        if result.recorder:
            result.recorder.consider(result.make_frames(result.reference, initial_phase, 'path', 'geometry'),
                                     initial_phase, 0, initial=True)
        if algorithm == 'ci-neb':
            from pes_neb import run_ci_neb
            result.provenance['pathInitializer'] = initializer
            if initializer == 'fsm':
                status = _fsm(reference, ctx, options, result, anchors=anchors, growth='native',
                              phase='ci-fsm-initialization')
                if status != 'completed':
                    return result.finish(ctx, status)
                if set(result.physical) != set(range(count)):
                    raise PathInputError('Native FSM did not produce every requested CI bead')
                reference = [result.physical[index][0].copy() for index in range(count)]
                # The completed initializer is a distinct physical stage. Its
                # final real batch survives even when its last round is not N.
                result.provenance['initializer'] = copy.deepcopy(result.provenance)
                result.recorder.finish()
            status = run_ci_neb(reference, symbols, ctx, options, result)
        elif algorithm == 'de-gsm':
            status = _de_gsm(reference, ctx, options, result, anchors=anchors)
        elif algorithm == 'fsm':
            status = _fsm(reference, ctx, options, result, anchors=anchors)
        else:
            raise PathInputError('Unknown two-ended PES method')
    except PesCancelled:
        return result.finish(ctx, 'stopped')
    except Exception as error:
        if not result.reference and not result.physical:
            raise
        if ctx.workspace is not None:
            try:
                (Path(ctx.workspace) / 'path-error.txt').write_text(traceback.format_exc(), encoding='utf-8')
            except OSError:
                pass
        return result.finish(ctx, 'failed', error={'code': getattr(error, 'code', 'PES_PATH_FAILED'),
                                                  'message': str(error), 'type': type(error).__name__})
    return result.finish(ctx, status)
