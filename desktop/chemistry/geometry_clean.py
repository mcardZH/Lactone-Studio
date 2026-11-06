"""Explicit-graph mechanical geometry clean, NOT a molecular force field.

Only movable Cartesian positions are variables. No chemical sanitization,
hydrogens, charges, bond inference or virtual force-field particles are used.
The nonnegative dimensionless objective is an editor's weighted least-squares
geometry target; it is never reported in eV/kcal/mol or offered for MD.

Lengths prefer explicit user distances, then the application's existing
common covalent construction lengths, then installed RDKit covalent radii.
Only a known order uses the existing UFF-form correction (lambda=.1332), NOT
UFF atom-type valence radii or its electronegativity/force constants. Unknown
orders stay unknown; coordination never acquires a covalent-radius target.
This deliberately remains a geometry rule:
https://github.com/rdkit/rdkit/blob/master/Code/ForceField/UFF/BondStretch.cpp
https://github.com/rdkit/rdkit/blob/master/Code/ForceField/UFF/Params.h
Named angular templates mirror this application's explicit fragment presets.
SciPy L-BFGS-B / SLSQP provide the optimizer, NumPy the analytic objective.
"""
from __future__ import annotations

import copy
import itertools
import math
import time

import numpy as np
import scipy
from scipy.optimize import linear_sum_assignment, minimize

import engine
from bond_perception import H_SEEDS, SEEDS

TRUST_COORD = .1 / math.sqrt(3)  # <= .1 angstrom per atom per accepted move
GRAD_TOL = 1e-5
EPS = 1e-8


def _connection_key(a, b, image=(0, 0, 0)):
    image = tuple(image)
    forward, reverse = (a, b, image), (b, a, tuple(-v for v in image))
    return min(forward, reverse)


class LengthTargets:
    """One policy for isolated/periodic explicit graph length targets.

    Common lengths reuse bond_perception.SEEDS/H_SEEDS; radii keep the exact
    installed RDKit definition already used by this objective (including B).
    These geometric references never assign a bond order or electronic state.
    """
    def __init__(self, structure, radii, explicit=()):
        self.structure, self.radii, self.records = structure, radii, []
        atoms = structure['atoms']
        ids = {atom['id']: i for i, atom in enumerate(atoms)}
        pbc = structure.get('cell', {}).get('pbc', [False, False, False])
        edges = {_connection_key(edge['a'], edge['b'], edge.get('image', (0, 0, 0))): edge for edge in structure.get('bonds', [])}
        if not isinstance(explicit, (list, tuple)):
            engine.reject('geometry-distance-target', 'Explicit geometry distances must be a bounded list.')
        self.explicit = {}
        for item in explicit:
            if not isinstance(item, dict) or set(item) - {'atomIds', 'image', 'distanceAngstrom'}:
                engine.reject('geometry-distance-target', 'Unknown explicit geometry distance fields.')
            atom_ids, image, value = item.get('atomIds'), item.get('image', [0, 0, 0]), item.get('distanceAngstrom')
            if (not isinstance(atom_ids, list) or len(atom_ids) != 2 or any(not isinstance(atom_id, str) or atom_id not in ids for atom_id in atom_ids)
                    or not isinstance(image, list) or len(image) != 3 or any(type(v) is not int or abs(v) > 1000000 or v and not pbc[axis] for axis, v in enumerate(image))
                    or isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 < value <= 1000000):
                engine.reject('geometry-distance-target', 'Explicit geometry distance needs existing stable endpoints, a valid image and a positive Angstrom value.')
            key = _connection_key(ids[atom_ids[0]], ids[atom_ids[1]], image)
            if key not in edges or key in self.explicit:
                engine.reject('geometry-distance-target', 'An explicit distance must identify exactly one existing connection; it cannot add an edge.')
            if edges[key]['order'] == .5:
                engine.reject('geometry-weak-target', 'A weak 0.5 relation is not an ordinary mechanical covalent distance target.')
            self.explicit[key] = float(value)

    def resolve(self, edge):
        a, b = edge['a'], edge['b']
        atom_a, atom_b = self.structure['atoms'][a], self.structure['atoms'][b]
        image = edge.get('image', [0, 0, 0])
        key = _connection_key(a, b, image)
        target, source = None, 'weak-relation'
        if edge['order'] != .5:
            if key in self.explicit:
                target, source = self.explicit[key], 'user-distance'
            elif edge.get('kind') == 'coordination':
                source = 'unavailable-coordination'
            else:
                order_known = edge.get('orderKnown') is not False
                pair = tuple(sorted((atom_a['element'], atom_b['element'])))
                if order_known and edge['order'] in (1, 2, 3):
                    values = SEEDS.get(pair)
                    if values:
                        target = values[int(edge['order']) - 1]
                    if edge['order'] == 1 and 'H' in pair:
                        target = H_SEEDS.get(pair[1] if pair[0] == 'H' else pair[0], target)
                if target is not None:
                    source = 'typical-covalent'
                else:
                    target = float(self.radii[a] + self.radii[b])
                    if order_known:
                        target *= 1 - .1332 * math.log(float(edge['order']))
                    source = 'covalent-radii'
        self.records.append(dict(atomIds=[atom_a['id'], atom_b['id']], image=list(image),
                                 targetAngstrom=target, source=source, orderKnown=edge.get('orderKnown') is not False))
        return target

    def summary(self, angle_count=0, plane_count=0, active_collisions=0, movable_lengths=None, unresolved_immovable=0):
        targeted = sum(row['targetAngstrom'] is not None for row in self.records)
        unsupported = sum(row['source'] == 'unavailable-coordination' for row in self.records)
        weak = sum(row['source'] == 'weak-relation' for row in self.records)
        movable_lengths = targeted if movable_lengths is None else movable_lengths
        has_targets = movable_lengths + angle_count + plane_count > 0
        status = ('partial-targets' if unsupported or unresolved_immovable else 'targeted') if has_targets else 'collision-only' if active_collisions else 'no-targets'
        return dict(status=status, targetedConnectionCount=int(targeted), untargetedCoordinationCount=int(unsupported),
                    movableConnectionTargetCount=int(movable_lengths), unresolvedImmovableConnectionCount=int(unresolved_immovable),
                    weakConnectionCount=int(weak), angleTargetCount=int(angle_count), planeTargetCount=int(plane_count),
                    activeCollisionCount=int(active_collisions), connectionTargets=copy.deepcopy(self.records))


def _unit(v):
    v = np.asarray(v, dtype=float)
    return v / np.linalg.norm(v)


def _ring(n, z=0, phase=0):
    return [_unit([math.cos(phase+i*2*math.pi/n), math.sin(phase+i*2*math.pi/n), z]) for i in range(n)]


def _templates():
    tetra = [_unit(v) for v in ((1, 1, 1), (1, -1, -1), (-1, 1, -1), (-1, -1, 1))]
    axes = np.asarray(((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)), dtype=float)
    h = math.sqrt((math.cos(math.radians(107))+.5)/1.5)
    pyramid = _ring(3, -h/math.sqrt(1-h*h))
    result = {
        'c-sp-triple': [[1, 0, 0], [-1, 0, 0]], 'c-sp-double': [[1, 0, 0], [-1, 0, 0]],
        'c-sp2': _ring(3), 'c-aromatic': _ring(3), 'c-sp3': tetra,
        'n-sp3': pyramid, 'n-planar': _ring(3), 'n-sp2': _ring(3)[:2], 'n-sp': [[1, 0, 0]],
        'o-bent': [[1, 0, 0], [math.cos(math.radians(104.5)), math.sin(math.radians(104.5)), 0]],
        'o-double': [[1, 0, 0]],
        'fe-linear': [[1, 0, 0], [-1, 0, 0]], 'fe-bent': _ring(3)[:2],
        'fe-trigonal-planar': _ring(3), 'fe-trigonal-pyramidal': pyramid,
        'fe-t-shaped': [[1, 0, 0], [-1, 0, 0], [0, 1, 0]],
        'fe-tetrahedral': tetra, 'fe-square-planar': _ring(4),
        'fe-seesaw': [[0, 0, 1], [0, 0, -1], *_ring(3)[:2]],
        'fe-trigonal-bipyramidal': [*_ring(3), [0, 0, 1], [0, 0, -1]],
        'fe-square-pyramidal': [*_ring(4), [0, 0, 1]], 'fe-octahedral': axes,
        'fe-trigonal-prismatic': [*_ring(3, math.sqrt(3)/2), *_ring(3, -math.sqrt(3)/2)],
        'fe-trigonal-antiprismatic': [*_ring(3, .6), *_ring(3, -.6, math.pi/3)],
        'fe-pentagonal-bipyramidal': [*_ring(5), [0, 0, 1], [0, 0, -1]],
        'fe-capped-octahedral': [*axes, _unit([1, 1, 1])],
        'fe-square-antiprismatic': [*_ring(4, math.sqrt(math.sqrt(.5))), *_ring(4, -math.sqrt(math.sqrt(.5)), math.pi/4)],
        'fe-dodecahedral': [_unit(v) for v in ((.8, 0, 1), (-.8, 0, 1), (0, .8, -1), (0, -.8, -1), (1, 0, -.3), (-1, 0, -.3), (0, 1, .3), (0, -1, .3))],
        'fe-tricapped-trigonal-prismatic': [*_ring(3, math.sqrt(3)/2), *_ring(3, -math.sqrt(3)/2), *_ring(3, 0, math.pi/3)],
        'fe-capped-square-antiprismatic': [*_ring(4, math.sqrt(math.sqrt(.5))), *_ring(4, -math.sqrt(math.sqrt(.5)), math.pi/4), [0, 0, 1]],
        'fe-pentagonal-prismatic': [*_ring(5, .65), *_ring(5, -.65)],
    }
    return {key: np.asarray(value, dtype=float) for key, value in result.items()}


TEMPLATES = _templates()
PLANAR = {'c-sp2', 'c-aromatic', 'n-planar', 'fe-trigonal-planar', 'fe-square-planar'}


def _matching(directions, template):
    """Deterministic proper-rotation assignment; hints are geometric, not types."""
    q = np.asarray(directions, dtype=float)
    p = np.asarray(template, dtype=float)
    rotation = np.eye(3)
    assignment = None
    for _ in range(12):
        rows, cols = linear_sum_assignment(-q @ (p @ rotation).T)
        new_assignment = tuple(int(c) for c in cols)
        assigned = p[cols]
        u, _, vt = np.linalg.svd(assigned.T @ q)
        fix = np.eye(3)
        fix[-1, -1] = 1 if np.linalg.det(u @ vt) >= 0 else -1
        rotation = u @ fix @ vt
        if assignment == new_assignment:
            break
        assignment = new_assignment
    return p[list(new_assignment)]


def _graph(structure):
    result = copy.deepcopy(structure)
    result.pop('molfile', None)
    for atom in result['atoms']:
        for key in ('x', 'y', 'z'):
            atom.pop(key, None)
    return result


class Objective:
    """Analytic positive geometry penalties with immutable target provenance."""
    def __init__(self, structure, ports=(), distance_targets=()):
        self.structure = copy.deepcopy(structure)
        self.initial = np.asarray(engine.coordinates(structure), dtype=float)
        self.lengths, self.angles, self.planes = [], [], []
        n = len(structure['atoms'])
        table = engine.Chem.GetPeriodicTable()
        self.radii = np.asarray([table.GetRcovalent(table.GetAtomicNumber(a['element'])) for a in structure['atoms']])
        if np.any(self.radii <= 0) or not np.all(np.isfinite(self.radii)):
            engine.reject('geometry-radius', 'A covalent-radius geometry seed is unavailable for this element.')
        self.length_targets = LengthTargets(structure, self.radii, distance_targets)
        self.neighbours = [[] for _ in range(n)]
        connected = set()
        for b in structure.get('bonds', []):
            target = self.length_targets.resolve(b)
            if b['order'] == .5:
                continue  # drawing aids are not mechanical covalent relations
            a, c = b['a'], b['b']
            if target is not None:
                self.lengths.append((a, c, target))
            self.neighbours[a].append(c)
            self.neighbours[c].append(a)
            connected.add(tuple(sorted((a, c))))
        port_hosts, port_presets = {}, {}
        ids = {a['id']: i for i, a in enumerate(structure['atoms'])}
        seen = set()
        if not isinstance(ports, (list, tuple)):
            engine.reject('geometry-port', 'Construction hints exceed the bounded port schema.')
        for p in ports:
            if not isinstance(p, dict) or p.get('hostAtomId') not in ids or not isinstance(p.get('id'), str) or not p['id'] or p['id'] in seen:
                engine.reject('geometry-port', 'A construction port requires a unique identity and an existing host atom.')
            direction = p.get('direction')
            if not isinstance(direction, list) or len(direction) != 3 or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in direction) or np.linalg.norm(direction) < EPS or p.get('order') not in (1, 1.5, 2, 3):
                engine.reject('geometry-port', 'A construction port needs a finite nonzero direction and supported connection order.')
            seen.add(p['id'])
            port_hosts.setdefault(ids[p['hostAtomId']], []).append(_unit(direction))
            if isinstance(p.get('presetId'), str) and p['presetId'] in TEMPLATES:
                port_presets.setdefault(ids[p['hostAtomId']], set()).add(p['presetId'])
        for center, neighbours in enumerate(self.neighbours):
            neighbours.sort()
            vectors = [self.initial[j]-self.initial[center] for j in neighbours]
            directions = [_unit(v) if np.linalg.norm(v) > EPS else np.eye(3)[k % 3] for k, v in enumerate(vectors)]
            directions += port_hosts.get(center, [])
            hint = structure['atoms'][center].get('geometryPresetId')
            if hint is not None and (not isinstance(hint, str) or len(hint) > 100):
                engine.reject('geometry-preset', 'A construction geometry hint must be a bounded string.')
            if hint is None and len(port_presets.get(center, ())) == 1:
                hint = next(iter(port_presets[center]))
            template = TEMPLATES.get(hint)
            if template is not None and not hint.startswith(structure['atoms'][center]['element'].lower()+'-'):
                engine.reject('geometry-preset', 'The geometric preset belongs to a different element.')
            targets = _matching(directions, template) if template is not None and len(directions) <= len(template) and directions else None
            for i, j in itertools.combinations(range(len(neighbours)), 2):
                if targets is None:
                    continue  # no invented angular target from distorted input
                cosine = float(np.dot(targets[i], targets[j]))
                self.angles.append((neighbours[i], center, neighbours[j], cosine))
            if hint in PLANAR and 3 <= len(neighbours) <= len(template):
                for triple in itertools.combinations(neighbours, 3):
                    self.planes.append((*triple, center, max(.1, self.radii[center])**3))
        # Fractional/double relations support a mechanical coplanarity target,
        # not aromatic atom typing. Existing E/Z and tetrahedral signs remain
        # independently protected against automatic inversions.
        for b in structure.get('bonds', []):
            if b['order'] not in (1.5, 2) or b.get('kind') == 'coordination' or b.get('orderKnown') is False:
                continue
            a, c = b['a'], b['b']
            for left in self.neighbours[a]:
                for right in self.neighbours[c]:
                    if left != c and right != a and len({left, a, c, right}) == 4:
                        self.planes.append((left, a, c, right, max(.1, self.radii[a]+self.radii[c])**3))
        # Nonconnected pair exclusion is topological, never radius-perception.
        self.connected = connected
        self.pair_atoms = None
        self.pair_filter = None

    def pair_indices(self):
        n = len(self.initial)
        candidates = itertools.combinations(range(n), 2) if self.pair_atoms is None else (
            (min(a, b), max(a, b)) for a in sorted(self.pair_atoms) for b in range(n)
            if a != b and (b not in self.pair_atoms or a < b))
        for pair in candidates:
            if pair not in self.connected and (self.pair_filter is None or self.pair_filter(*pair)):
                yield pair

    @property
    def pairs(self):
        # Compatibility inspection only; the running objective uses spatial chunks.
        return np.asarray(list(self.pair_indices()), dtype=int).reshape((-1, 2))

    def collision_chunks(self, xyz):
        # Terms outside this radius are identically zero in the original objective.
        # Rebuild for each trial, so moving atoms never miss newly formed collisions.
        from scipy.spatial import cKDTree
        radius = .70 * 2 * float(np.max(self.radii))
        tree = cKDTree(xyz)
        chunk = []
        for a in range(len(xyz)):
            for b in tree.query_ball_point(xyz[a], radius, return_sorted=True):
                if b <= a or (a, b) in self.connected:
                    continue
                if self.pair_atoms is not None and a not in self.pair_atoms and b not in self.pair_atoms:
                    continue
                if self.pair_filter is not None and not self.pair_filter(a, b):
                    continue
                chunk.append((a, b))
                if len(chunk) == 8192:
                    pairs = np.asarray(chunk, dtype=int)
                    yield pairs, .70*(self.radii[pairs[:, 0]]+self.radii[pairs[:, 1]])
                    chunk = []
        if chunk:
            pairs = np.asarray(chunk, dtype=int)
            yield pairs, .70*(self.radii[pairs[:, 0]]+self.radii[pairs[:, 1]])

    def target_status(self, xyz, movable_indices=None):
        movable = set(range(len(self.initial))) if movable_indices is None else set(movable_indices)
        xyz = np.asarray(xyz)
        collisions = 0
        for pairs, minima in self.collision_chunks(xyz):
            distances = np.linalg.norm(xyz[pairs[:, 0]]-xyz[pairs[:, 1]], axis=1)
            collisions += sum(distance < minimum and (int(a) in movable or int(b) in movable) for (a, b), distance, minimum in zip(pairs, distances, minima))
        active = sum(a != b and (a in movable or b in movable) for a, b, _target in self.lengths)
        immovable = sum((a == b or a not in movable and b not in movable) and abs(np.linalg.norm(np.asarray(xyz)[a] - np.asarray(xyz)[b]) - target) > 1e-5 for a, b, target in self.lengths)
        return self.length_targets.summary(sum(any(i in movable for i in term[:3]) for term in self.angles),
                                           sum(any(i in movable for i in term[:4]) for term in self.planes), collisions, active, immovable)

    def evaluate(self, xyz):
        xyz = np.asarray(xyz, dtype=float)
        if xyz.shape != self.initial.shape or not np.all(np.isfinite(xyz)):
            engine.reject('geometry-coordinate', 'The mechanical objective received invalid Cartesian coordinates.')
        value = 0.0
        gradient = np.zeros_like(xyz)
        for a, b, target in self.lengths:
            delta = xyz[a]-xyz[b]
            distance = math.sqrt(float(np.dot(delta, delta))+EPS*EPS)
            error = (distance-target)/target
            value += 5*error*error
            g = 10*error/target*delta/distance
            gradient[a] += g
            gradient[b] -= g
        for a, c, b, target in self.angles:
            av, bv = xyz[a]-xyz[c], xyz[b]-xyz[c]
            ar = math.sqrt(float(np.dot(av, av))+EPS*EPS)
            br = math.sqrt(float(np.dot(bv, bv))+EPS*EPS)
            u, v = av/ar, bv/br
            cosine = float(np.dot(u, v))
            error = cosine-target
            value += .4*error*error
            ga = .8*error*(v-cosine*u)/ar
            gb = .8*error*(u-cosine*v)/br
            gradient[a] += ga
            gradient[b] += gb
            gradient[c] -= ga+gb
        for a, b, c, d, scale in self.planes:
            av, bv, cv = xyz[a]-xyz[d], xyz[b]-xyz[d], xyz[c]-xyz[d]
            det = float(np.dot(av, np.cross(bv, cv)))/scale
            value += .03*det*det
            factor = .06*det/scale
            ga, gb, gc = factor*np.cross(bv, cv), factor*np.cross(cv, av), factor*np.cross(av, bv)
            gradient[a] += ga
            gradient[b] += gb
            gradient[c] += gc
            gradient[d] -= ga+gb+gc
        for pairs, pair_min in self.collision_chunks(xyz):
            a, b = pairs[:, 0], pairs[:, 1]
            delta = xyz[a]-xyz[b]
            distance = np.sqrt(np.einsum('ij,ij->i', delta, delta)+EPS*EPS)
            error = np.minimum(0, (distance-pair_min)/pair_min)
            value += float(np.dot(error, error))
            g = (2*error/pair_min/distance)[:, None]*delta
            np.add.at(gradient, a, g)
            np.add.at(gradient, b, -g)
        if not math.isfinite(value) or not np.all(np.isfinite(gradient)):
            engine.reject('geometry-objective', 'The mechanical objective or gradient became nonfinite.')
        return float(value), gradient


class PeriodicObjective:
    """Fixed-lattice geometry rules over base-atom variables, never an FF.

    Every edge retains its explicit integer image. Unknown-order covalent
    connections can use a radius-sum reference without becoming single bonds;
    coordination requires an independently supplied reliable distance target.
    """
    def __init__(self, structure, ports=(), distance_targets=()):
        cell = engine.validate_periodic_cell(structure)
        self.structure = copy.deepcopy(structure)
        self.initial = np.asarray(engine.coordinates(structure), dtype=float)
        self.vectors = np.asarray(cell['vectors'], dtype=float)
        self.inverse = np.linalg.inv(self.vectors)
        self._image_work = 0
        self.pbc = tuple(cell['pbc'])
        self.lengths, self.angles, self.planes = [], [], []
        self.neighbours = [[] for _ in structure['atoms']]
        table = engine.Chem.GetPeriodicTable()
        self.radii = np.asarray([table.GetRcovalent(table.GetAtomicNumber(a['element'])) for a in structure['atoms']])
        if np.any(self.radii <= 0) or not np.all(np.isfinite(self.radii)):
            engine.reject('geometry-radius', 'A covalent-radius geometry seed is unavailable for this element.')
        self.length_targets = LengthTargets(structure, self.radii, distance_targets)
        if ports:
            engine.reject('periodic-ports', 'Periodic mechanical geometry does not interpret pending molecular attachment ports.')
        connected, neighbours = set(), [[] for _ in structure['atoms']]
        for edge in structure.get('bonds', []):
            target = self.length_targets.resolve(edge)
            if edge['order'] == .5:
                continue
            a, b = edge['a'], edge['b']
            image = tuple(edge.get('image', (0, 0, 0)))
            shift = np.asarray(image) @ self.vectors
            initial = float(np.linalg.norm(self.initial[b]+shift-self.initial[a]))
            if initial < EPS:
                engine.reject('periodic-zero-edge', 'An explicit periodic connection has coincident endpoints; repair it before mechanical geometry.')
            if target is not None:
                self.lengths.append((a, b, shift, target))
            neighbours[a].append((b, shift))
            neighbours[b].append((a, -shift))
            self.neighbours[a].append(b)
            self.neighbours[b].append(a)
            connected.add(self._key(a, b, image))
        for center, items in enumerate(neighbours):
            vectors = [self.initial[index]+shift-self.initial[center] for index, shift in items]
            if any(np.linalg.norm(vector) < EPS for vector in vectors):
                engine.reject('periodic-zero-edge', 'A periodic angle has a coincident endpoint.')
            hint = structure['atoms'][center].get('geometryPresetId')
            if hint is not None and (not isinstance(hint, str) or len(hint) > 100):
                engine.reject('geometry-preset', 'A construction geometry hint must be a bounded string.')
            template = TEMPLATES.get(hint)
            if template is not None and not hint.startswith(structure['atoms'][center]['element'].lower()+'-'):
                engine.reject('geometry-preset', 'The geometric preset belongs to a different element.')
            targets = _matching([_unit(vector) for vector in vectors], template) if template is not None and len(items) <= len(template) and items else None
            for left, right in itertools.combinations(range(len(items)), 2):
                if targets is None:
                    continue  # only explicit construction templates set angles
                a, ashift = items[left]
                b, bshift = items[right]
                cosine = float(np.dot(targets[left], targets[right]))
                self.angles.append((a, center, b, ashift, bshift, cosine))
            # Planarity is an explicit local construction hint, not a property
            # inferred from a 2D periodic material, metal, or an order placeholder.
            if hint in PLANAR and 3 <= len(items) <= len(template):
                for chosen in itertools.combinations(items, 3):
                    self.planes.append((chosen, center, max(.1, self.radii[center])**3))
        self.connected = connected

    def target_status(self, xyz, movable_indices=None):
        movable = set(range(len(self.initial))) if movable_indices is None else set(movable_indices)
        collisions = sum(a != b and (a in movable or b in movable) and distance < target for a, b, _delta, distance, target in self.contacts(np.asarray(xyz)))
        active = sum(a != b and (a in movable or b in movable) for a, b, _shift, _target in self.lengths)
        immovable = sum((a == b or a not in movable and b not in movable) and abs(np.linalg.norm(np.asarray(xyz)[b] + shift - np.asarray(xyz)[a]) - target) > 1e-5 for a, b, shift, target in self.lengths)
        angles = sum(any(i in movable for i in term[:3]) for term in self.angles)
        planes = sum(center in movable or any(index in movable for index, _shift in chosen) for chosen, center, _scale in self.planes)
        return self.length_targets.summary(angles, planes, collisions, active, immovable)

    @staticmethod
    def _key(a, b, image):
        image = tuple(int(v) for v in image)
        if a > b or a == b and next((v for v in image if v), 0) < 0:
            a, b, image = b, a, tuple(-v for v in image)
        return a, b, image

    def images(self, delta, radius):
        fractional = np.asarray(delta) @ self.inverse
        bounds = [(math.ceil(-fractional[i]-np.linalg.norm(self.inverse[:, i])*radius-1e-9),
                   math.floor(-fractional[i]+np.linalg.norm(self.inverse[:, i])*radius+1e-9)) if self.pbc[i] else (0, 0) for i in range(3)]
        self._image_work += math.prod(max(0, hi-lo+1) for lo, hi in bounds)
        for image in itertools.product(*(range(lo, hi+1) for lo, hi in bounds)):
            shifted = np.asarray(delta)+np.asarray(image) @ self.vectors
            distance = float(np.linalg.norm(shifted))
            if distance <= radius+1e-9:
                yield image, shifted, distance

    def contacts(self, xyz, radius_scale=.70):
        self._image_work = 0
        work = 0
        for a in range(len(xyz)):
            for b in range(a, len(xyz)):
                target = radius_scale*(self.radii[a]+self.radii[b])
                for image, delta, distance in self.images(xyz[b]-xyz[a], target):
                    if a == b and (not any(image) or next((v for v in image if v), 0) < 0):
                        continue
                    if self._key(a, b, image) in self.connected:
                        continue
                    work += 1
                    yield a, b, delta, distance, target

    def evaluate(self, xyz):
        xyz = np.asarray(xyz, dtype=float)
        if xyz.shape != self.initial.shape or not np.all(np.isfinite(xyz)):
            engine.reject('geometry-coordinate', 'Periodic geometry requires finite base-atom Cartesian coordinates.')
        value, gradient = 0.0, np.zeros_like(xyz)
        for a, b, shift, target in self.lengths:
            delta = xyz[a]-xyz[b]-shift
            distance = math.sqrt(float(np.dot(delta, delta))+EPS*EPS)
            error = (distance-target)/target
            value += 5*error*error
            g = 10*error/target*delta/distance
            gradient[a] += g
            gradient[b] -= g
        for a, center, b, ashift, bshift, target in self.angles:
            av, bv = xyz[a]+ashift-xyz[center], xyz[b]+bshift-xyz[center]
            ar = math.sqrt(float(np.dot(av, av))+EPS*EPS)
            br = math.sqrt(float(np.dot(bv, bv))+EPS*EPS)
            u, v = av/ar, bv/br
            cosine = float(np.dot(u, v))
            error = cosine-target
            value += .4*error*error
            ga, gb = .8*error*(v-cosine*u)/ar, .8*error*(u-cosine*v)/br
            gradient[a] += ga
            gradient[b] += gb
            gradient[center] -= ga+gb
        for chosen, center, scale in self.planes:
            vectors = [xyz[index]+shift-xyz[center] for index, shift in chosen]
            av, bv, cv = vectors
            det = float(np.dot(av, np.cross(bv, cv)))/scale
            value += .03*det*det
            factor = .06*det/scale
            terms = [factor*np.cross(bv, cv), factor*np.cross(cv, av), factor*np.cross(av, bv)]
            for (index, _shift), term in zip(chosen, terms):
                gradient[index] += term
                gradient[center] -= term
        for a, b, delta, raw_distance, target in self.contacts(xyz):
            distance = math.sqrt(raw_distance*raw_distance+EPS*EPS)
            error = min(0, (distance-target)/target)
            value += error*error
            g = 2*error/target/distance*delta
            gradient[b] += g
            gradient[a] -= g
        if not math.isfinite(value) or not np.all(np.isfinite(gradient)):
            engine.reject('geometry-objective', 'The periodic geometry objective or gradient became nonfinite.')
        return float(value), gradient


class Session:
    """Stateful geometry-only protocol adapter, separate from physical ASE MD."""
    def __init__(self, request, objective=None):
        self.request = copy.deepcopy(request)
        self.operation = 'geometry'
        checked = copy.deepcopy(dict(request, operation='geometry'))
        cell = checked.get('structure', {}).get('cell')
        if cell is not None:
            engine.validate_periodic_cell(checked['structure'])
        if isinstance(cell, dict) and isinstance(cell.get('pbc'), list) and len(cell['pbc']) == 3 and all(v is False for v in cell['pbc']):
            checked['structure'].pop('cell')
        engine.validate(checked)
        self.structure = copy.deepcopy(request['structure'])
        self.periodic = bool(self.structure.get('cell', {}).get('pbc') and any(self.structure['cell']['pbc']))
        if self.structure.get('dimension', 3) != 3:
            engine.reject('dimension', 'Mechanical geometry clean requires actual 3D positions.')
        self.max_steps = request.get('maxSteps', 300)
        self.max_wall_seconds = request.get('maxWallTimeSeconds')
        if isinstance(self.max_steps, bool) or not isinstance(self.max_steps, int) or not 1 <= self.max_steps <= 9007199254740991:
            engine.reject('maxSteps', 'Geometry iteration budget must be a positive exact JSON integer.')
        if self.max_wall_seconds is not None and (isinstance(self.max_wall_seconds, bool) or not isinstance(self.max_wall_seconds, (int, float)) or not math.isfinite(self.max_wall_seconds) or self.max_wall_seconds <= 0):
            engine.reject('maxWallTimeSeconds', 'Explicit geometry wall budget must be positive and finite.')
        self.initial_xyz = np.asarray(engine.coordinates(self.structure), dtype=float)
        self.positions = self.initial_xyz.copy()
        ids = {a['id']: i for i, a in enumerate(self.structure['atoms'])}
        movable = set(request['movableAtomIds'])
        self.fixed = [i for i, a in enumerate(self.structure['atoms']) if a['id'] not in movable]
        self.variable = [3*i+j for i, a in enumerate(self.structure['atoms']) if a['id'] in movable for j in range(3)]
        self.objective = objective if objective is not None else (PeriodicObjective if self.periodic else Objective)(self.structure, request.get('attachmentPorts', []), request.get('geometryDistanceTargets', []))
        if objective is not None and request.get('geometryDistanceTargets'):
            engine.reject('geometry-distance-mode', 'Explicit mechanical distances are not implemented for an injected hybrid objective.')
        self.movable_indices = {i for i, atom in enumerate(self.structure['atoms']) if atom['id'] in movable}
        self.graph = _graph(self.structure)
        self.freezes = [c for c in request.get('constraints', []) if c['action'] == 'freeze']
        if any(c['action'] != 'freeze' for c in request.get('constraints', [])):
            engine.reject('geometry-scan', 'Mechanical geometry clean does not run scans.')
        self.rows = [(c, tuple(ids[a] for a in c['atomIds'])) for c in self.freezes]
        self.rows = [(c, ix, engine.internal_value(self.initial_xyz, c['type'], ix)) for c, ix in self.rows]
        # Protect actual current geometry, including metadata-free tetrahedral
        # centers, rather than reviving a previous manual conformation.
        self.stereo_reference = copy.deepcopy(self.structure)
        if self.periodic and (any(atom.get('stereoParity') for atom in self.structure['atoms']) or any(bond.get('stereo') for bond in self.structure.get('bonds', []))):
            engine.reject('periodic-stereo', 'Image-aware execution of declared molecular stereo is not verified for periodic mechanical geometry.')
        for i, neighbours in enumerate(self.objective.neighbours):
            if not self.periodic and len(neighbours) == 4:
                self.stereo_reference['atoms'][i]['stereoParity'] = 1
        self.expected_tetra, self.expected_double = ({}, {}) if self.periodic else engine.stereo_geometry(self.stereo_reference)
        if any(a.get('stereoParity') and not self.expected_tetra.get(i) for i, a in enumerate(self.structure['atoms'])):
            engine.reject('geometry-stereo-singular', 'Specified tetrahedral geometry is initially singular; repair it explicitly before automatic clean.')
        self.expected_tetra = {i: sign for i, sign in self.expected_tetra.items() if sign}
        self.step = 0
        self.completion_reason = None
        self.paused = self.stopped = False
        self.started_at = time.monotonic()
        self.pause_started = None
        self.paused_seconds = 0
        self.constraint_residuals = self._residuals(self.positions)
        self.last_validated = self.snapshot()

    def pause(self):
        if not self.paused:
            self.pause_started = time.monotonic()
        self.paused = True

    def resume(self):
        if self.pause_started is not None:
            self.paused_seconds += time.monotonic()-self.pause_started
            self.pause_started = None
        self.paused = False

    def running_seconds(self):
        pending = time.monotonic()-self.pause_started if self.pause_started is not None else 0
        return time.monotonic()-self.started_at-self.paused_seconds-pending

    def set_temperature(self, _value):
        engine.reject('temperature-operation', 'Mechanical geometry clean has no physical temperature or MD potential.')

    def _residuals(self, xyz):
        residuals = []
        for c, ix, target in self.rows:
            value = engine.internal_value(xyz, c['type'], ix)
            residual = engine.coordinate_delta(value, target, c['type'])
            if abs(residual) > (1e-6 if c['type'] == 'B' else 1e-5):
                return None
            scale = 1 if c['type'] == 'B' else 180/math.pi
            residuals.append(dict(id=c.get('id'), type=c['type'], target=target*scale, actual=value*scale,
                                  residual=residual*scale, unit='angstrom' if c['type'] == 'B' else 'degree'))
        return residuals

    def snapshot(self):
        if self.fixed and not np.array_equal(self.positions[self.fixed], self.initial_xyz[self.fixed]):
            engine.reject('fixed-atom-moved', 'Mechanical geometry clean moved a frozen Cartesian atom.')
        output = copy.deepcopy(self.structure)
        for a, p in zip(output['atoms'], self.positions):
            a.update(x=float(p[0]), y=float(p[1]), z=float(p[2]))
        output.pop('molfile', None)
        if _graph(output) != self.graph:
            engine.reject('graph-change', 'Mechanical geometry clean changed atoms, graph or electronic state.')
        actual = copy.deepcopy(output)
        for i in self.expected_tetra:
            actual['atoms'][i]['stereoParity'] = 1
        tetra, double = ({}, {}) if self.periodic else engine.stereo_geometry(actual)
        if any(tetra.get(i) != sign for i, sign in self.expected_tetra.items()) or any(sign and double.get(i) != sign for i, sign in self.expected_double.items()):
            engine.reject('geometry-stereo-change', 'Automatic mechanical geometry inverted or flattened the current tetrahedral or double-bond geometry; the last valid frame is retained.')
        value, _ = self.objective.evaluate(self.positions)
        status = self.objective.target_status(self.positions, self.movable_indices) if hasattr(self.objective, 'target_status') else None
        return dict(stamp=self.request.get('stamp'), operation='geometry', step=self.step, timeFs=0,
                    structure=output, movableAtomIds=self.request['movableAtomIds'], geometryObjective=value,
                    **(dict(geometryTargetStatus=status) if status is not None else {}),
                    engine='Ester Studio geometry + SciPy', engineVersion=scipy.__version__,
                    constraintResiduals=self.constraint_residuals,
                    warnings=['Dimensionless mechanical geometry objective only; not UFF/MMFF, molecular potential energy, an electronic-state assignment or MD parameterization.'])

    def _seed_overlaps(self):
        xyz = self.positions.copy()
        pairs = [(a, b, distance) for a, b, _delta, distance, _target in self.objective.contacts(xyz) if distance < 1e-4] if self.periodic else [(i, j, np.linalg.norm(xyz[i]-xyz[j])) for i, j in itertools.combinations(range(len(xyz)), 2)]
        for i, j, distance in pairs:
            if distance >= 1e-4:
                continue
            if i == j:
                engine.reject('periodic-self-overlap', 'A base atom overlaps its own fixed-lattice image; moving that atom cannot repair the cell.')
            if i in self.fixed and j in self.fixed:
                engine.reject('geometry-fixed-overlap', 'Coincident frozen atoms cannot be separated by geometry clean.')
            if self.rows:
                engine.reject('geometry-constrained-overlap', 'Coincident atoms with exact internal constraints need an explicit manual separation.')
            index = j if j not in self.fixed else i
            direction = _unit([1+(index % 3), 1+((index+1) % 5), 1+((index+2) % 7)])
            xyz[index] += .02*direction
        return xyz

    def optimize(self, callback):
        # One local trust-region solve produces each actual published step.
        # Internal line-search trials never enter the public model.
        callback(publish=False)
        if hasattr(self.objective, 'target_status') and self.objective.target_status(self.positions, self.movable_indices)['status'] == 'no-targets':
            self.completion_reason = 'no-targets'
            self.last_validated = self.snapshot()
            return False
        seed = self._seed_overlaps()
        if not np.array_equal(seed, self.positions):
            self.positions = seed
            self.step += 1
            self.last_validated = self.snapshot()
            callback()
        variables = np.asarray(self.variable, dtype=int)
        active_rows, seen = [], set()
        for c, ix, target in self.rows:
            key = (c['type'], min(ix, ix[::-1]))
            if key not in seen and any(i not in self.fixed for i in ix):
                active_rows.append((c, ix, target))
                seen.add(key)
        while self.step < self.max_steps:
            callback(publish=False)
            base = self.positions.ravel().copy()
            x0 = base[variables]
            def full(x):
                result = base.copy()
                result[variables] = x
                return result.reshape((-1, 3))
            def fun(x):
                if self.max_wall_seconds is not None and self.running_seconds() > self.max_wall_seconds:
                    engine.reject('walltime', 'The mechanical clean walltime budget was reached before any unvalidated trial was committed.')
                value, grad = self.objective.evaluate(full(x))
                return value, grad.ravel()[variables]
            constraints = [dict(type='eq', fun=lambda x, row=row: engine.coordinate_delta(
                engine.internal_value(full(x), row[0]['type'], row[1]), row[2], row[0]['type'])) for row in active_rows]
            bounds = list(zip(x0-TRUST_COORD, x0+TRUST_COORD))
            result = minimize(fun, x0, jac=True, method='SLSQP' if constraints else 'L-BFGS-B',
                              bounds=bounds, constraints=constraints,
                              options=dict(maxiter=20, ftol=1e-12, **({'disp': False} if constraints else {'gtol': GRAD_TOL, 'maxls': 30})))
            trial = full(result.x)
            residuals = self._residuals(trial)
            if residuals is None:
                engine.reject('constraint-residual', 'Mechanical clean did not preserve an exact frozen B/A/D coordinate.')
            if constraints and not result.success and result.status != 9:
                engine.reject('constraint-solver', 'Mechanical clean could not solve the exact internal-coordinate constraints.')
            prior = self.objective.evaluate(self.positions)[0]
            current = self.objective.evaluate(trial)[0]
            if current > prior+1e-10:
                engine.reject('geometry-descent', 'The geometry solver failed to find a descending bounded step.')
            movement = float(np.max(np.linalg.norm(trial-self.positions, axis=1)))
            if movement > .100000001:
                engine.reject('geometry-trust', 'The geometry solver exceeded its accepted Cartesian trust step.')
            self.positions = trial
            self.constraint_residuals = residuals
            self.step += 1
            self.last_validated = self.snapshot()
            callback()
            value, grad = fun(result.x)
            if not constraints and np.max(np.abs(grad)) < GRAD_TOL:
                return True
            at_bound = np.any(np.abs(result.x-x0) >= TRUST_COORD-1e-7)
            if result.success and not at_bound and movement < 1e-6 and abs(prior-current) < 1e-10:
                return True
            if movement < 1e-10:
                return False  # honest stagnation, never a false convergence
        return False
