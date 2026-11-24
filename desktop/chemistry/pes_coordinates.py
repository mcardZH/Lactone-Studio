"""Stable-identity internal coordinates and exact Cartesian constraint spaces."""

import math
import re

import numpy as np


class CoordinateError(ValueError):
    code = 'PES_COORDINATE_INVALID'


def require(condition, message):
    if not condition:
        raise CoordinateError(message)


def wrap_degrees(delta):
    return (delta + 180.0) % 360.0 - 180.0


def unit_vector(vector, jacobian):
    norm = np.linalg.norm(vector)
    require(norm > 1e-10, 'Coincident coordinate endpoints')
    unit = vector / norm
    return unit, (jacobian - np.outer(unit, unit @ jacobian)) / norm


def dot(a, da, b, db):
    return a @ b, b @ da + a @ db


def primitive(positions, kind, indices, offsets=None):
    """Return a value and Cartesian derivative in Å or degrees.

    The signed dihedral follows the existing modeling and xTB convention.
    """
    points = np.asarray(positions, dtype=float)
    local = points[list(indices)]
    if offsets is not None:
        local += offsets
    derivatives = np.eye(3 * len(indices)).reshape(len(indices), 3, -1)
    a, da = local[0] - local[1], derivatives[0] - derivatives[1]
    if kind == 'B':
        normal, _ = unit_vector(a, da)
        value, row = np.linalg.norm(a), normal @ da
    else:
        b, db = local[2] - local[1], derivatives[2] - derivatives[1]
        axis, d_axis = unit_vector(b, db)
        if kind == 'A':
            normal, d_normal = unit_vector(a, da)
            cosine, d_cosine = dot(normal, d_normal, axis, d_axis)
            require(abs(cosine) < 1 - 1e-12, 'Linear bond angle has singular derivatives')
            value = math.degrees(math.acos(cosine))
            row = -np.rad2deg(d_cosine) / np.sqrt(1 - cosine**2)
        else:
            c, dc = local[3] - local[2], derivatives[3] - derivatives[2]
            av, d_av = dot(a, da, axis, d_axis)
            cw, d_cw = dot(c, dc, axis, d_axis)
            v, dv = a - av * axis, da - av * d_axis - np.outer(axis, d_av)
            w, dw = c - cw * axis, dc - cw * d_axis - np.outer(axis, d_cw)
            normal = np.cross(axis, v)
            d_normal = (np.cross(d_axis.T, v) + np.cross(axis, dv.T)).T
            x, dx = dot(v, dv, w, dw)
            y, dy = dot(normal, d_normal, w, dw)
            denominator = x*x + y*y
            require(denominator > 1e-24, 'Linear or coincident dihedral plane')
            value = math.degrees(math.atan2(y, x))
            row = np.rad2deg((x * dy - y * dx) / denominator)
    gradient = np.zeros_like(points)
    # Images share their base atom's Cartesian displacement in a fixed cell.
    np.add.at(gradient, list(indices), row.reshape(-1, 3))
    return float(value), gradient


_NORMALIZE = str.maketrans({'×': '*', '÷': '/', '−': '-', '＋': '+', '（': '(', '）': ')'})
_TOKEN = re.compile(r'\s*(\{[^{}\r\n]+\}|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+\-]?\d+)?|[^\W\d]\w*|[()+*/-])')
_ARITY = {'B': 2, 'A': 3, 'D': 4}
_DIMENSION = {'B': (1, 0), 'A': (0, 1), 'D': (0, 1)}


def unit_name(dimension):
    units = []
    for symbol, exponent in zip(('angstrom', 'degree'), dimension):
        if exponent:
            units.append(symbol if exponent == 1 else f'{symbol}^{exponent}')
    return '*'.join(units) or 'dimensionless'


class CoordinateSet:
    def __init__(self, atom_ids, definitions=(), *, geometry=None):
        self.indices = {atom_id: index for index, atom_id in enumerate(atom_ids)}
        self.definitions = {}
        self.names = {}
        self.offsets = {}
        self.geometry = geometry
        for row in definitions:
            identity, kind = row.get('id'), row.get('type')
            name = row.get('name', identity)
            require(isinstance(identity, str) and identity, 'Coordinate IDs must be nonempty')
            require(isinstance(name, str) and name, 'Coordinate names must be nonempty')
            indices, offsets = self.resolve_endpoints(row)
            definition = (kind, indices)
            require(identity not in self.definitions or (self.definitions[identity] == definition
                    and np.array_equal(self.offsets.get(identity), offsets)),
                    f'Coordinate ID {identity!r} has conflicting definitions')
            self.definitions[identity] = definition
            if offsets is not None:
                self.offsets[identity] = offsets
            self.names.setdefault(name, set()).add(identity)

    def resolve_endpoints(self, row):
        kind, atoms = row.get('type'), row.get('atomIds')
        require(kind in _ARITY and isinstance(atoms, (list, tuple)) and len(atoms) == _ARITY[kind],
                'The coordinate has the wrong number of ordered atoms')
        require(all(isinstance(atom_id, str) and atom_id in self.indices for atom_id in atoms),
                f'Invalid or missing atom in coordinate {row.get("id", "")}')
        indices = tuple(self.indices[atom_id] for atom_id in atoms)
        images = row.get('images')
        if images is None:
            require(len(set(indices)) == len(indices), 'Repeated atoms require distinct lattice images')
            return indices, None
        try:
            shifts = np.asarray(images)
        except ValueError as error:
            raise CoordinateError('Lattice images must be integer triples') from error
        require(shifts.shape == (len(indices), 3) and shifts.dtype.kind in 'iu',
                'Lattice images must be integer triples')
        endpoints = {(index, *image) for index, image in zip(indices, shifts)}
        require(len(endpoints) == len(indices), 'Duplicate coordinate image endpoint')
        if self.geometry is None:
            require(not np.any(shifts), 'Lattice images require a periodic cell')
            return indices, None
        try:
            return indices, self.geometry.cartesian_offsets(shifts, len(indices))
        except ValueError as error:
            raise CoordinateError(str(error)) from error

    def compile(self, expression, reference=None):
        require(isinstance(expression, str) and bool(expression.strip()), 'Coordinate expression is empty')
        expression = expression.strip()
        # Direct IDs can contain punctuation, and labels can contain spaces.
        if expression in self.definitions or expression in self.names:
            identity = self.resolve_reference(expression)
            compiled = CoordinateExpression(('ref', identity), _DIMENSION[self.definitions[identity][0]],
                                            self.definitions, offsets=self.offsets)
        else:
            compiled = self._parse(expression.translate(_NORMALIZE))
        return compiled.rebase(reference) if reference is not None else compiled

    def resolve_reference(self, token):
        if token.startswith('{') and token.endswith('}'):
            return token[1:-1]
        if token in self.definitions or token not in self.names:
            return token
        identities = self.names[token]
        require(len(identities) == 1, f'Ambiguous coordinate name {token!r}; use its stable ID')
        return next(iter(identities))

    def _parse(self, expression):
        tokens = []
        offset = 0
        while offset < len(expression):
            match = _TOKEN.match(expression, offset)
            require(match is not None, f'Invalid coordinate expression near {expression[offset:offset + 20]!r}')
            tokens.append(match[1])
            offset = match.end()
        tokens = iter(tokens)
        current = next(tokens, None)

        def consume():
            nonlocal current
            token, current = current, next(tokens, None)
            return token

        def operand():
            token = consume()
            require(token is not None, 'Incomplete coordinate expression')
            if token == '(':
                node, dim = binary(0)
                require(consume() == ')', 'Unbalanced coordinate expression parentheses')
                return node, dim
            if token in ('+', '-'):
                node, dim = operand()
                return (('neg', node) if token == '-' else node), dim
            if token[0].isdigit() or token[0] == '.':
                value = float(token)
                require(math.isfinite(value), 'Nonfinite coordinate expression constant')
                return ('number', value), (0, 0)
            identity = self.resolve_reference(token)
            require(identity in self.definitions, f'Missing coordinate reference {token!r}')
            return ('ref', identity), _DIMENSION[self.definitions[identity][0]]

        def binary(minimum_precedence):
            node, dimension = operand()
            precedence = {'+': 0, '-': 0, '*': 1, '/': 1}
            while current in precedence and precedence[current] >= minimum_precedence:
                operator = consume()
                right, other_dimension = binary(precedence[operator] + 1)
                if operator in ('+', '-'):
                    require(dimension == other_dimension, 'Coordinate addition/subtraction requires compatible units')
                else:
                    sign = 1 if operator == '*' else -1
                    dimension = tuple(a + sign * b for a, b in zip(dimension, other_dimension))
                node = (operator, node, right)
            return node, dimension

        try:
            root, dimension = binary(0)
        except RecursionError as error:
            raise CoordinateError('Coordinate expression nesting exceeds available recursion') from error
        require(current is None, 'Unexpected text after coordinate expression')
        return CoordinateExpression(root, dimension, self.definitions, offsets=self.offsets)


class CoordinateExpression:
    def __init__(self, root, dimension, definitions, anchors=None, *, offsets=None):
        self.root, self.dimension, self.definitions = root, dimension, definitions
        self.anchors = anchors or {}
        self.offsets = offsets or {}
        self._sella_adapter = None

    @property
    def unit(self):
        return unit_name(self.dimension)

    @property
    def periodic(self):
        return self.root[0] == 'ref' and self.definitions[self.root[1]][0] == 'D'

    def _evaluate(self, positions):
        observations = {}

        def evaluate(node):
            operation = node[0]
            if operation == 'ref':
                identity = node[1]
                if identity not in observations:
                    kind, indices = self.definitions[identity]
                    value, gradient = primitive(positions, kind, indices, self.offsets.get(identity))
                    if kind == 'D' and identity in self.anchors:
                        anchor = self.anchors[identity]
                        value = anchor + wrap_degrees(value - anchor)
                    observations[identity] = value, gradient
                return observations[identity]
            if operation == 'number':
                return node[1], np.zeros_like(positions, dtype=float)
            left, dl = evaluate(node[1])
            if operation == 'neg':
                return -left, -dl
            right, dr = evaluate(node[2])
            if operation == '+':
                return left + right, dl + dr
            if operation == '-':
                return left - right, dl - dr
            if operation == '*':
                return left * right, right * dl + left * dr
            require(right != 0.0, 'Coordinate expression division by zero')
            return left / right, (dl - (left / right) * dr) / right

        value, gradient = evaluate(self.root)
        require(np.isfinite(value) and np.isfinite(gradient).all(), 'Nonfinite coordinate expression value/derivative')
        return float(value), gradient, observations

    def value_gradient(self, positions):
        return self._evaluate(positions)[:2]

    def value(self, positions):
        return self.value_gradient(positions)[0]

    def gradient(self, positions):
        return self.value_gradient(positions)[1]

    def rebase(self, positions):
        _, _, observations = self._evaluate(positions)
        anchors = {key: value for key, (value, _) in observations.items() if self.definitions[key][0] == 'D'}
        rebased = CoordinateExpression(self.root, self.dimension, self.definitions, anchors, offsets=self.offsets)
        rebased._sella_adapter = self._sella_adapter
        return rebased

    def sella_coordinate(self):
        """A native custom coordinate with exact AD gradient and curvature.

        The function returns the same Å/degree/combined value as this expression.
        Each number is normalized by one of its own source units (not a mixed
        Å/radian sum). Anchors are runtime values, so adjacent points reuse the
        same compiled expression without freezing a previous torsion branch.
        """
        import jax.numpy as jnp
        from sella.internal import make_internal

        if self._sella_adapter is None:
            references = set()

            def collect(node):
                if node[0] == 'ref':
                    references.add(node[1])
                elif node[0] != 'number':
                    collect(node[1])
                    if node[0] != 'neg':
                        collect(node[2])
            collect(self.root)
            indices = sorted({index for identity in references for index in self.definitions[identity][1]})
            local = {index: position for position, index in enumerate(indices)}
            definitions = {identity: (self.definitions[identity][0],
                                      tuple(local[index] for index in self.definitions[identity][1]))
                           for identity in references}
            dihedrals = sorted(identity for identity in references if definitions[identity][0] == 'D')
            anchor_index = {identity: index for index, identity in enumerate(dihedrals)}
            root = self.root

            def value(points, anchors):
                observed = {}

                def evaluate(node):
                    operation = node[0]
                    if operation == 'ref':
                        identity = node[1]
                        if identity not in observed:
                            kind, atoms = definitions[identity]
                            p = points[jnp.array(atoms)]
                            if identity in self.offsets:
                                p += self.offsets[identity]
                            a = p[0] - p[1]
                            if kind == 'B':
                                current = jnp.linalg.norm(a)
                            else:
                                b = p[2] - p[1]
                                axis = b / jnp.linalg.norm(b)
                                if kind == 'A':
                                    current = jnp.arccos(jnp.clip(jnp.dot(a / jnp.linalg.norm(a), axis), -1., 1.)) * 180. / jnp.pi
                                else:
                                    c = p[3] - p[2]
                                    v = a - jnp.dot(a, axis) * axis
                                    w = c - jnp.dot(c, axis) * axis
                                    current = jnp.arctan2(jnp.dot(jnp.cross(axis, v), w), jnp.dot(v, w)) * 180. / jnp.pi
                                    anchor = anchors[anchor_index[identity]]
                                    current = anchor + jnp.mod(current - anchor + 180., 360.) - 180.
                            observed[identity] = current
                        return observed[identity]
                    if operation == 'number':
                        return jnp.asarray(node[1], dtype=jnp.float64)
                    left = evaluate(node[1])
                    if operation == 'neg':
                        return -left
                    right = evaluate(node[2])
                    if operation == '+':
                        return left + right
                    if operation == '-':
                        return left - right
                    if operation == '*':
                        return left * right
                    return left / right
                return evaluate(root)

            native = make_internal('EsCoordinateExpression', value, len(indices))
            self._sella_adapter = native, tuple(indices), tuple(dihedrals)
        native, indices, dihedrals = self._sella_adapter
        result = native(indices)
        result.kwargs['anchors'] = np.array([self.anchors.get(identity, 0.) for identity in dihedrals])
        return result


class ConstraintSpace:
    """Holonomic equalities. Fixed coordinates are eliminated exactly."""

    def __init__(self, reference, atom_ids, definitions=None, *, equations=(), geometry=None):
        self.reference = np.asarray(reference, dtype=float).copy()
        self.atom_ids = tuple(atom_ids)
        definitions = definitions or {}
        self.geometry = geometry
        coordinates = CoordinateSet(atom_ids, geometry=geometry)
        frozen = set(definitions.get('frozenAtomIds', ()))
        require(frozen.issubset(coordinates.indices), 'Frozen atom is missing from the source frame')
        self.frozen = np.array([atom_id in frozen for atom_id in atom_ids], dtype=bool)
        self.free = np.flatnonzero(np.repeat(~self.frozen, 3))
        self.equations = list(equations)
        for row in definitions.get('coordinates', ()):
            kind, identity = row['type'], row['id']
            indices, offsets = coordinates.resolve_endpoints(row)
            expression = CoordinateExpression(('ref', identity), _DIMENSION[kind], {identity: (kind, indices)},
                                              offsets={identity: offsets} if offsets is not None else None)
            target = float(row['value'])
            require(np.isfinite(target), f'Constraint {identity} has a nonfinite target')
            require(kind != 'B' or target > 0, f'Constraint {identity} requires a positive distance')
            require(kind != 'A' or 0 < target < 180, f'Constraint {identity} requires a nonlinear angle')
            self.equations.append((identity, expression, target))
        for row in definitions.get('centroids', ()):
            indices = [coordinates.indices[atom_id] for atom_id in row['atomIds']]
            require(indices and len(set(indices)) == len(indices), 'Centroid requires distinct atoms')
            target = np.asarray(row.get('value', self.reference[indices].mean(axis=0)), dtype=float)
            require(target.shape == (3,) and np.isfinite(target).all(), 'Invalid centroid target')
            for component in range(3):
                expression = CentroidComponent(indices, component)
                self.equations.append((f'{row["id"]}:{component}', expression, float(target[component])))
        self.definition_ids = tuple(row[0] for row in self.equations)

    def with_equations(self, equations):
        return ConstraintSpace(self.reference, self.atom_ids, {'frozenAtomIds': [
            atom_id for atom_id, fixed in zip(self.atom_ids, self.frozen) if fixed
        ]}, equations=[*self.equations, *equations], geometry=self.geometry)

    def expand(self, free_positions):
        result = self.reference.ravel().copy()
        result[self.free] = free_positions
        return result.reshape(self.reference.shape)

    def equations_at(self, positions):
        residual, derivatives = [], []
        for _, expression, target in self.equations:
            value, gradient = expression.value_gradient(positions)
            delta = value - target
            residual.append(wrap_degrees(delta) if expression.periodic else delta)
            derivatives.append(gradient.ravel())
        return np.array(residual, dtype=float), np.asarray(derivatives, dtype=float).reshape(len(residual), self.reference.size)

    def residuals(self, positions):
        return dict(zip(self.definition_ids, map(float, self.equations_at(positions)[0])))

    def tangent(self, positions):
        """Return Cartesian orthonormal tangent columns, including frozen zeros."""
        _, derivative = self.equations_at(positions)
        jacobian = derivative[:, self.free]
        if jacobian.size:
            _, singular_values, vt = np.linalg.svd(jacobian, full_matrices=True)
            basis = vt[self._rank(jacobian, singular_values):].T
        else:
            basis = np.eye(len(self.free))
        result = np.zeros((self.reference.size, basis.shape[1]))
        result[self.free] = basis
        return result

    @staticmethod
    def _rank(jacobian, singular_values):
        threshold = max(jacobian.shape) * np.finfo(float).eps * max(1., singular_values[0])
        return int(np.count_nonzero(singular_values > threshold))

    def project_vector(self, positions, vector, *, return_dof=False):
        """Project through the small row space without a dense Cartesian basis."""
        vector = np.asarray(vector, dtype=float)
        projected = vector.ravel()[self.free]
        rank = 0
        if self.equations and len(self.free):
            jacobian = self.equations_at(positions)[1][:, self.free]
            _, singular_values, vt = np.linalg.svd(jacobian, full_matrices=False)
            rank = self._rank(jacobian, singular_values)
            row_basis = vt[:rank]
            projected -= row_basis.T @ (row_basis @ projected)
        result = np.zeros(vector.shape, dtype=float)
        result.ravel()[self.free] = projected
        return (result, len(self.free) - rank) if return_dof else result

    def project(self, positions, *, tolerance=1e-8):
        """Retract a trial geometry onto the manifold using damped Newton steps."""
        trial = self.expand(np.asarray(positions, dtype=float).ravel()[self.free])
        if not self.equations:
            return trial
        for _ in range(100):
            residual, derivative = self.equations_at(trial)
            if np.max(np.abs(residual)) <= tolerance:
                return trial
            jacobian = derivative[:, self.free]
            norms = np.linalg.norm(jacobian, axis=1)
            require(not np.any((norms <= 1e-12) & (np.abs(residual) > tolerance)),
                    'A global equality has no movable degree of freedom')
            scale = np.where(norms > 1e-12, norms, 1.)
            correction = np.linalg.lstsq(jacobian / scale[:, None], -residual / scale, rcond=None)[0]
            error = np.linalg.norm(residual / scale)
            for factor in (1., .5, .25, .125, .0625, .03125):
                candidate = self.expand(trial.ravel()[self.free] + factor * correction)
                try:
                    updated, _ = self.equations_at(candidate)
                except CoordinateError:
                    continue
                if np.linalg.norm(updated / scale) < error:
                    trial = candidate
                    break
            else:
                break
        raise CoordinateError(f'Could not satisfy coordinate constraints: {self.residuals(trial)}')

    def require_variable(self, expression, positions):
        gradient = expression.gradient(positions)
        variation = np.linalg.norm(self.project_vector(positions, gradient))
        require(variation > 1e-10 * max(1.0, np.linalg.norm(gradient)),
                f'Coordinate is fixed by frozen atoms or constraints {self.definition_ids}')


class CentroidComponent:
    periodic = False

    def __init__(self, indices, component):
        self.indices, self.component = indices, component

    def value_gradient(self, positions):
        gradient = np.zeros_like(positions, dtype=float)
        gradient[self.indices, self.component] = 1 / len(self.indices)
        return float(positions[self.indices, self.component].mean()), gradient
