"""Scratch state for exact finite empirical trajectory perception.

The worker owns this state. Keys cover ordered atom chemistry and the complete
typed graph. Cached objects contain proposals and neighbor candidates, never
the selected bond graph for a different geometry.
"""
from collections import Counter, OrderedDict
from itertools import combinations
import math

try:
    import _finite_empirical_accel as accelerator
except ImportError:
    accelerator = None

_CACHE_MISS = object()
_SANITATION_REJECTED = object()
_SEARCH_MARGIN = 1e-7
_SEARCH_SKIN = .24


class FixedGraphRejection(ValueError):
    """A fixed graph cannot be sanitized with the current native rules."""


class _Memo:
    def __init__(self, max_entries, max_units=300_000):
        self.values = OrderedDict()
        self.max_entries = max_entries
        self.max_units = max_units
        self.units = 0

    def get(self, key):
        row = self.values.get(key, _CACHE_MISS)
        if row is _CACHE_MISS:
            return row
        self.values.move_to_end(key)
        return row[0]

    def put(self, key, value, weight):
        if weight > self.max_units:
            return
        previous = self.values.pop(key, None)
        if previous:
            self.units -= previous[1]
        self.values[key] = (value, weight)
        self.units += weight
        while len(self.values) > self.max_entries or self.units > self.max_units:
            _, (_, weight) = self.values.popitem(last=False)
            self.units -= weight

    def clear(self):
        self.values.clear()
        self.units = 0


class FiniteEmpiricalSession:
    def __init__(self):
        self.inventory = None
        self.neighbors = None
        self.indexed = _Memo(2048)
        self.shapes = _Memo(1024)
        self.forests = _Memo(4)
        self.forest_plans = _Memo(32)

    def bind(self, atoms):
        inventory = tuple((atom['id'], atom['element'], atom.get('formalCharge', 0)) for atom in atoms)
        if inventory != self.inventory:
            self.inventory = inventory
            self.neighbors = None
            for memo in (self.indexed, self.forests, self.forest_plans):
                memo.clear()

    def neighbor_rows(self, positions, radii, metals, hydrogens, donors, radius):
        # The original exact iterator handles extreme coordinate diagnostics.
        # The skin bypass must keep every pair reachable under either the
        # ordinary distance rules or the broader donor/acceptor rules.
        if len(positions) < 48:
            return None
        try:
            import numpy as np
            from scipy.spatial import cKDTree
        except ImportError:
            return None

        xyz = np.asarray(positions, dtype=np.float64)
        if not np.isfinite(xyz).all() or np.max(np.abs(xyz)) >= 1e6:
            return None
        if self.neighbors is not None:
            saved_radius, origin, rows = self.neighbors
            # Twice the maximum Cartesian displacement is at most this bound.
            if radius == saved_radius and np.max(np.abs(xyz - origin)) <= (_SEARCH_SKIN - _SEARCH_MARGIN) / (2 * math.sqrt(3)):
                return rows

        tree = cKDTree(xyz)
        padded = radius + _SEARCH_SKIN + _SEARCH_MARGIN
        # Dense pair inventories can be produced by highly coincident input.
        # Leave their traversal to the existing bounded-space iterator.
        if len(positions) >= 4096:
            counts = tree.query_ball_point(xyz, padded, return_length=True)
            if int(counts.sum()) > 256 * len(positions):
                return None
        pairs = tree.query_pairs(padded, output_type='ndarray')
        if len(pairs):
            a, b = pairs.T
            metal, hydrogen, donor = (np.asarray(mask, dtype=bool) for mask in (metals, hydrogens, donors))
            radii = np.asarray(radii)
            hydrogen_contact = (hydrogen[a] & donor[b]) | (donor[a] & hydrogen[b])
            scale = np.where(hydrogen_contact, 1.6, np.where(metal[a] | metal[b], 1.55, 1.28))
            limit = scale * (radii[a] + radii[b]) + _SEARCH_SKIN + _SEARCH_MARGIN
            delta = xyz[a] - xyz[b]
            pairs = pairs[np.einsum('ij,ij->i', delta, delta) <= limit * limit]
        rows = [[] for _ in positions]
        for a, b in pairs.tolist():
            rows[a].append(b)
            rows[b].append(a)
        result = [tuple(sorted(row)) for row in rows]
        self.neighbors = (radius, xyz, result)
        return result

    def graph(self, kind, component, orders, compute, *, ring=None, negative=()):
        # All atoms in these components occur in at least one edge. Atom
        # order is the reference order used to construct the native graph.
        edges = tuple((a, b, 1 if kind == 'native' else value) for (a, b), value in sorted(orders.items()))
        key = (kind, edges, ring)
        value = self.indexed.get(key)
        if value is _CACHE_MISS:
            indices = tuple(sorted(component))
            relative = {index: i for i, index in enumerate(indices)}
            labels = tuple(self.inventory[i][1:] for i in indices)
            normalized = (kind, labels, tuple((relative[a], relative[b], order) for a, b, order in edges),
                          tuple(relative[i] for i in ring) if ring is not None else None)
            saved = self.shapes.get(normalized)
            if saved is _CACHE_MISS:
                try:
                    value = compute()
                except negative:
                    value = _SANITATION_REJECTED
                saved = self._remap(kind, value, relative)
                self.shapes.put(normalized, saved, len(indices) + 2 * len(edges))
            else:
                value = self._remap(kind, saved, indices)
            self.indexed.put(key, value, len(indices) + 2 * len(edges))
        if value is _SANITATION_REJECTED:
            raise FixedGraphRejection('Fixed chemistry graph could not be sanitized')
        return value

    @staticmethod
    def _remap(kind, value, indices):
        if value is _SANITATION_REJECTED:
            return value
        if kind == 'rings':
            return tuple(tuple(indices[i] for i in ring) for ring in value)
        if kind == 'problem':
            return tuple(indices[i] for i in value)
        if kind == 'trial':
            return tuple({(indices[a], indices[b]): order for (a, b), order in proposal.items()}
                         for proposal in value)
        return {(indices[a], indices[b]): order for (a, b), order in value.items()}

    def close_neutral_forest(self, orders, weak, capacity):
        """Exact shortcut for a neutral explicit C/H single-bond forest.

        For an acyclic neutral C/H graph RDKit's radicals are exactly the
        explicit degree deficits from C=4 and H=1. Each admitted edge consumes
        one unit at both ends and cannot create aromaticity or change an
        existing order. Geometry still ranks competing feasible additions.
        """
        key = frozenset(orders.items())
        proof = self.forests.get(key)
        if proof is _CACHE_MISS:
            inventory = self.inventory
            if len(capacity) != len(inventory) or any(
                charge != 0 or element not in ('C', 'H') or capacity.get(i) != (4 if element == 'C' else 1)
                for i, (_, element, charge) in enumerate(inventory)
            ) or any(order != 1 for order in orders.values()):
                return None
            parent = {}
            degree = Counter()
            for a, b in orders:
                if not _merge(parent, a, b):
                    return None
                degree[a] += 1
                degree[b] += 1
            residual = {i: value - degree[i] for i, value in capacity.items() if degree[i] != value}
            if any(deficit < 0 for deficit in residual.values()):
                return None
            roots = {i: _root(parent, i) for i in residual}
            proof = (dict.fromkeys(sorted(orders), 1.0), residual, roots)
            self.forests.put(key, proof, 2 * len(orders) + len(residual))
        base, residual, roots = proof
        if not residual:
            return base, set(), {}

        choices = tuple(sorted(weak, key=lambda pair: (-sum(i in residual for i in pair), -weak[pair]['score'], pair))[:8])
        plan_key = (key, choices)
        plan = self.forest_plans.get(plan_key)
        if plan is _CACHE_MISS:
            extra = {}
            for a, b in choices:
                if a in residual and b in residual and not _merge(extra, roots[a], roots[b]):
                    # An admissible added edge can form a ring. Use the
                    # original chemistry checks for all subsets in that case.
                    return None
            plan = []
            for size in range(len(choices), 0, -1):
                for subset in combinations(choices, size):
                    delta = Counter(i for pair in subset for i in pair)
                    if all(value <= residual.get(i, 0) for i, value in delta.items()):
                        plan.append((subset, {i: value - delta[i] for i, value in residual.items() if value > delta[i]}))
                if plan:
                    break
            self.forest_plans.put(plan_key, plan, len(orders) + sum(len(subset) + len(radicals) for subset, radicals in plan))
        if not plan:
            return base, set(), residual
        subset, radicals = min(plan, key=lambda row: (sum(weak[pair]['distance'] for pair in row[0]), row[0]))
        return dict.fromkeys(sorted(set(base).union(subset)), 1.0), set(subset), radicals


def _root(parent, item):
    while item in parent:
        prior = parent[item]
        if prior in parent:
            parent[item] = parent[prior]
        item = prior
    return item


def _merge(parent, a, b):
    a, b = _root(parent, a), _root(parent, b)
    if a == b:
        return False
    parent[b] = a
    return True


def unchanged_hydrocarbon_tree(atoms, component, orders):
    """RDKit cannot upgrade a neutral explicit C/H tree without a deficient C–C pair."""
    if len(orders) != len(component) - 1 or any(order != 1 for order in orders.values()):
        return None
    degree = Counter(i for pair in orders for i in pair)
    for index in component:
        atom = atoms[index]
        if atom.get('formalCharge', 0) != 0 or not (
            atom['element'] == 'C' and 0 < degree[index] <= 4 or
            atom['element'] == 'H' and degree[index] == 1
        ):
            return None
    if any(atoms[a]['element'] == atoms[b]['element'] == 'C' and degree[a] < 4 and degree[b] < 4 for a, b in orders):
        return None
    return dict.fromkeys(sorted(orders), 1.0)

