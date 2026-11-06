"""Deterministic crystal previews; no model state, calculation, files or network.

spglib owns symmetry/standardization; ASE owns Miller surface construction.
Mappings describe source lineage, never frozen/group state or accepted history.
"""
from __future__ import annotations

import copy
import json
import math
import sys
import warnings

import numpy as np

OPERATIONS = ('symmetry', 'primitive', 'conventional', 'p1', 'idealize', 'supercell', 'slab-terminations', 'slab')


class CrystalError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise CrystalError(message)


def number(value, low, high, name):
    require(type(value) in (int, float) and math.isfinite(value) and (low is None or low <= value) and (high is None or value <= high), 'Invalid ' + name)
    return float(value)


def vector(value, name):
    require(isinstance(value, list) and len(value) == 3 and all(type(v) in (int, float) and math.isfinite(v) for v in value), 'Invalid ' + name)
    return np.asarray(value, dtype=float)


def validate(request):
    require(isinstance(request, dict) and request.get('operation') in OPERATIONS, 'Unknown crystal operation')
    require(isinstance(request.get('documentId'), str) and 0 < len(request['documentId']) <= 1024, 'Missing source document identity')
    require(type(request.get('expectedRevision')) is int and request['expectedRevision'] >= 0, 'Invalid source revision')
    structure = request.get('structure')
    require(isinstance(structure, dict) and isinstance(structure.get('id'), str), 'Invalid source structure')
    atoms = structure.get('atoms')
    require(isinstance(atoms, list) and 0 < len(atoms), 'Crystal atom count exceeds limit')
    ids = [a.get('id') for a in atoms if isinstance(a, dict)]
    require(len(ids) == len(atoms) and all(isinstance(i, str) and i for i in ids) and len(set(ids)) == len(ids), 'Unique stable atom identities required')
    from ase.data import atomic_numbers
    for atom in atoms:
        require(atom.get('element') in atomic_numbers and atomic_numbers[atom['element']] > 0, 'Unsupported crystal element')
        vector([atom.get(k) for k in ('x', 'y', 'z')], 'atom coordinates')
    cell = structure.get('cell')
    require(isinstance(cell, dict), 'A complete periodic cell is required')
    require(isinstance(cell.get('vectors'), list) and len(cell['vectors']) == 3, 'Invalid lattice')
    lattice = np.asarray([vector(v, 'lattice vector') for v in cell['vectors']])
    require(abs(np.linalg.det(lattice)) > 1e-10 and np.max(np.abs(lattice)) <= 1e6, 'A finite nonsingular lattice is required')
    pbc = cell.get('pbc')
    require(isinstance(pbc, list) and len(pbc) == 3 and all(type(v) is bool for v in pbc), 'Explicit periodic axes required')
    require(structure.get('periodicSource', {}).get('completeness') != 'partial', 'Partial source lattice cannot be transformed')
    if request['operation'] != 'p1' and request['operation'] != 'supercell':
        require(all(pbc), 'Symmetry and Miller cuts require a three-dimensional periodic source')
    origin = vector(cell.get('origin', [0, 0, 0]), 'cell origin')
    parameters = request.get('parameters', {})
    require(isinstance(parameters, dict), 'Invalid crystal parameters')
    symprec = number(parameters.get('symprec', .01), 1e-7, 1, 'symmetry tolerance')
    angle = number(parameters.get('angleTolerance', -1), -1, 30, 'angle tolerance')
    positions = np.asarray([[a[k] for k in ('x', 'y', 'z')] for a in atoms]) - origin
    frac = np.linalg.solve(lattice.T, positions.T).T
    numbers = [atomic_numbers[a['element']] for a in atoms]
    return structure, lattice, origin, frac, numbers, parameters, symprec, angle


def symmetry_data(cell, symprec, angle):
    import spglib
    data = spglib.get_symmetry_dataset(cell, symprec=symprec, angle_tolerance=angle)
    require(data is not None, 'No reliable symmetry dataset at this tolerance')
    return data


def symmetry_result(data, atoms, symprec, angle):
    return dict(number=int(data.number), symbol=data.international, hallSymbol=data.hall,
                pointGroup=data.pointgroup, symprec=symprec, angleTolerance=angle,
                equivalentAtoms=[dict(atomId=a['id'], representativeId=atoms[int(group)]['id']) for a, group in zip(atoms, data.equivalent_atoms)])


def atom_id(source_id, operation, index, existing):
    candidate = f'{source_id}:{operation}:{index + 1}'
    while candidate in existing:
        candidate += ':copy'
    return candidate


def map_connections(request, output, mappings, image_basis):
    """Preserve explicit connection identities under the declared cell map.

    Miller cutting deliberately removes only edges cut by the two surfaces.
    Standardization/supercells must preserve every source relation or reject.
    """
    source = request['structure']
    lattice = np.asarray(source['cell']['vectors'])
    origin = np.asarray(source['cell'].get('origin', [0, 0, 0]))
    frac = np.linalg.solve(lattice.T, (np.asarray([[a[k] for k in ('x', 'y', 'z')] for a in source['atoms']]) - origin).T).T
    source_index = {a['id']: i for i, a in enumerate(source['atoms'])}
    by_source = {}
    for index, item in enumerate(mappings):
        for source_id in item.get('sourceAtomIds', [item['sourceAtomId']]):
            by_source.setdefault(source_id, []).append((index, item))
    basis = np.asarray(image_basis)

    def mapped_pairs(a_id, b_id, image):
        require(a_id in source_index and b_id in source_index, 'Invalid source relation endpoints')
        require(isinstance(image, list) and len(image) == 3 and all(type(v) is int for v in image), 'Invalid source relation image')
        a, b = source_index[a_id], source_index[b_id]
        for root_index, root in by_source.get(a_id, []):
            found = False
            for endpoint_index, endpoint in by_source.get(b_id, []):
                offset = (np.asarray(root['image']) + frac[source_index[root['sourceAtomId']]] - frac[a]
                          + image - np.asarray(endpoint['image']) - frac[source_index[endpoint['sourceAtomId']]] + frac[b])
                mapped_image = offset @ basis
                if not np.allclose(mapped_image, np.rint(mapped_image), atol=1e-6):
                    continue
                mapped_image = np.rint(mapped_image).astype(int).tolist()
                if any(value and not output['cell']['pbc'][axis] for axis, value in enumerate(mapped_image)):
                    continue
                # XYZ PBC describes the slab supercell, not connectivity through
                # its vacuum. Only in-plane images may survive a Miller cut.
                if request['operation'] == 'slab' and mapped_image[2] != 0:
                    continue
                if root_index == endpoint_index and not any(mapped_image):
                    continue
                found = True
                yield root_index, endpoint_index, mapped_image
            require(found or request['operation'] == 'slab', 'A source connection cannot be mapped without loss')

    def relation_key(a, b, image):
        return min((a, b, tuple(image)), (b, a, tuple(-v for v in image)))

    bonds, seen = [], {}
    for bond in source.get('bonds', []):
        a, b = bond.get('a'), bond.get('b')
        require(type(a) is int and type(b) is int and 0 <= a < len(frac) and 0 <= b < len(frac), 'Invalid source bond endpoints')
        for start, end, image in mapped_pairs(source['atoms'][a]['id'], source['atoms'][b]['id'], bond.get('image', [0, 0, 0])):
            key = relation_key(start, end, image)
            mapped = copy.deepcopy(bond)
            mapped.update(a=start, b=end)
            if any(image) or 'image' in bond:
                mapped['image'] = image
            else:
                mapped.pop('image', None)
            signature = {k: v for k, v in mapped.items() if k not in ('a', 'b', 'image')}
            if key in seen:
                require(seen[key] == signature, 'Merged source connections have conflicting metadata')
            else:
                seen[key] = signature; bonds.append(mapped)
    output['bonds'] = bonds

    # Weak/unresolved contacts have the same atom/image ownership as bonds.
    # Copying them verbatim leaves removed atom IDs in a valid slab geometry.
    contacts, seen_contacts = [], {}
    for issue in source.get('bondPerceptionIssues', []):
        ids = issue.get('atomIds')
        require(isinstance(ids, list) and len(ids) == 2, 'Invalid source contact endpoints')
        for start, end, image in mapped_pairs(ids[0], ids[1], issue.get('image', [0, 0, 0])):
            key = relation_key(start, end, image)
            mapped = copy.deepcopy(issue)
            mapped['atomIds'] = [output['atoms'][start]['id'], output['atoms'][end]['id']]
            if any(image) or 'image' in issue:
                mapped['image'] = image
            else:
                mapped.pop('image', None)
            signature = {k: v for k, v in mapped.items() if k not in ('atomIds', 'image')}
            if key in seen_contacts:
                require(seen_contacts[key] == signature, 'Merged source contacts have conflicting metadata')
            else:
                seen_contacts[key] = signature; contacts.append(mapped)
    if contacts:
        output['bondPerceptionIssues'] = contacts
    else:
        output.pop('bondPerceptionIssues', None)


def candidate(request, lattice, positions, groups, images=None, copy_keys=None, pbc=None, details=None):
    source = request['structure']
    require(0 < len(positions) and len(groups) == len(positions), 'Transformed atom count exceeds limit')
    used, atoms, mappings = set(), [], []
    source_ids = {a['id'] for a in source['atoms']}
    for i, (point, group) in enumerate(zip(positions, groups)):
        require(group and all(type(j) is int and 0 <= j < len(source['atoms']) for j in group), 'Incomplete source atom mapping')
        require(np.isfinite(point).all(), 'Nonfinite transformed coordinates')
        atom = copy.deepcopy(source['atoms'][group[0]])
        old_id = atom['id']
        new_id = old_id if old_id not in used else atom_id(old_id, request['operation'], i, used | source_ids)
        used.add(new_id)
        atom.update(id=new_id, **dict(zip(('x', 'y', 'z'), [float(v) for v in point])))
        atoms.append(atom)
        mapping = dict(atomId=new_id, sourceAtomId=old_id, image=images[i] if images is not None else [0, 0, 0])
        if len(group) > 1:
            mapping['sourceAtomIds'] = [source['atoms'][j]['id'] for j in group]
        if copy_keys is not None:
            mapping['copyKey'] = copy_keys[i]
        mappings.append(mapping)
    # Store owns all frozen/group/constraint state; explicit image connections
    # are mapped below after the operation supplies its exact lattice basis.
    output = copy.deepcopy(source)
    output.update(atoms=atoms, bonds=[], cell=copy.deepcopy(source['cell']))
    if 'layout2D' in source:
        output['layout2D'] = {item['atomId']: copy.deepcopy(source['layout2D'].get(item['sourceAtomId'],
                              dict(x=atom['x'], y=atom['y']))) for atom, item in zip(atoms, mappings)}
    output['cell'].update(vectors=np.asarray(lattice).tolist(), origin=[0, 0, 0], pbc=pbc if pbc is not None else source['cell']['pbc'])
    if pbc is not None:
        output['cell']['pbcProvenance'] = dict(kind='user-confirmed', evidence='Explicit crystal modeling preview; complete cell retained')
    return dict(candidate=dict(documentId=request['documentId'], expectedRevision=request['expectedRevision'], operation=request['operation'], structure=output, atomMapping=mappings), details=details or {})


def standardized(request, lattice, frac, numbers, symprec, angle, data):
    import spglib
    operation = request['operation']
    primitive = operation == 'primitive'
    cell = (lattice, frac, numbers)
    # Primitive/conventional change the cell description, not the measured
    # geometry. Idealization is a separate explicit preview operation.
    out = spglib.standardize_cell(cell, to_primitive=primitive, no_idealize=operation != 'idealize', symprec=symprec, angle_tolerance=angle)
    ideal = spglib.standardize_cell(cell, to_primitive=primitive, no_idealize=False, symprec=symprec, angle_tolerance=angle)
    require(out is not None and ideal is not None and len(out[1]) == len(ideal[1]) and np.array_equal(out[2], ideal[2]), 'Standardization mapping is ambiguous')
    source_groups = {}
    for index, group in enumerate(data.mapping_to_primitive):
        source_groups.setdefault(int(group), []).append(index)
    if not primitive:
        target_groups = [source_groups[int(g)] for g in data.std_mapping_to_primitive]
    else:
        # Match standardized conventional sites modulo the standardized primitive
        # lattice. No nearest-neighbor guess in an unrelated Cartesian frame.
        prim_lattice = np.asarray(ideal[0])
        std_cart = np.asarray(data.std_positions) @ np.asarray(data.std_lattice)
        target_groups = []
        for point, z in zip(np.asarray(ideal[1]) @ prim_lattice, ideal[2]):
            delta = np.linalg.solve(prim_lattice.T, (std_cart - point).T).T
            distance = np.linalg.norm((delta - np.rint(delta)) @ prim_lattice, axis=1)
            matches = {int(data.std_mapping_to_primitive[i]) for i in range(len(distance)) if data.std_types[i] == z and distance[i] < max(1e-6, symprec * 2)}
            require(len(matches) == 1, 'Primitive source lineage is ambiguous')
            target_groups.append(source_groups[matches.pop()])
    require(len(target_groups) == len(out[1]), 'Standardized source inventory is incomplete')
    # spglib's transformation/origin describe one common standardized frame.
    # Use that exact frame for integer source-image lineage, including rotated
    # or slightly distorted input cells. No Cartesian nearest-image guessing.
    transform = np.asarray(data.transformation_matrix)
    canonical_source_lattice = transform.T @ np.asarray(data.std_lattice)
    canonical_source_cart = (frac @ transform.T + np.asarray(data.origin_shift)) @ np.asarray(data.std_lattice)
    images, mapped_groups = [], []
    for point, group in zip(np.asarray(ideal[1]) @ np.asarray(ideal[0]), target_groups):
        choices = []
        for index in group:
            image = np.linalg.solve(canonical_source_lattice.T, point - canonical_source_cart[index])
            residual = (image - np.rint(image)) @ canonical_source_lattice
            if np.linalg.norm(residual) <= max(1e-6, symprec * 3):
                integral = np.rint(image).astype(int).tolist()
                choices.append((sum(abs(v) for v in integral), index, integral))
        require(choices, 'Standardized source image cannot be represented reliably')
        _, primary, image = min(choices)
        mapped_groups.append([primary] + [index for index in group if index != primary])
        images.append(image)
    result = candidate(request, out[0], np.asarray(out[1]) @ np.asarray(out[0]), mapped_groups, images,
                       details=dict(symmetry=symmetry_result(data, request['structure']['atoms'], symprec, angle), idealized=operation == 'idealize', sourceVolume=abs(float(np.linalg.det(lattice))), volume=abs(float(np.linalg.det(out[0])))))
    result['candidate']['latticeImageBasis'] = (canonical_source_lattice @ np.linalg.inv(np.asarray(ideal[0]))).tolist()
    if operation == 'idealize':
        direction = (np.linalg.inv(lattice) @ canonical_source_lattice).T.tolist()
        result['candidate']['directionTransforms'] = {atom['id']: direction for atom in result['candidate']['structure']['atoms']}
    return result


def supercell(request, lattice, origin, frac, numbers, parameters):
    from ase import Atoms
    from ase.build import make_supercell
    matrix = parameters.get('matrix')
    require(isinstance(matrix, list) and len(matrix) == 3 and all(isinstance(r, list) and len(r) == 3 and all(type(v) is int and abs(v) <= 9007199254740991 for v in r) for r in matrix), 'Supercell needs an integer 3 by 3 matrix')
    transform = np.asarray(matrix, dtype=int)
    pbc = request['structure']['cell']['pbc']
    for axis, periodic in enumerate(pbc):
        if not periodic:
            require(all(transform[axis, j] == int(axis == j) and transform[j, axis] == int(axis == j) for j in range(3)), 'Supercell cannot mix or replicate a nonperiodic source axis')
    determinant = float(np.linalg.det(transform))
    require(abs(determinant) >= .5, 'Singular or oversized supercell')
    source = Atoms(numbers=numbers, scaled_positions=frac, cell=lattice, pbc=pbc)
    source.new_array('source_index', np.arange(len(numbers), dtype=int))
    output = make_supercell(source, transform, wrap=True, order='cell-major')
    groups, images = [], []
    for index, position in zip(output.arrays['source_index'], output.positions):
        index = int(index)
        image_float = np.linalg.solve(lattice.T, position) - frac[index]
        require(np.allclose(image_float, np.rint(image_float), atol=1e-6), 'Supercell source image is not integral')
        groups.append([index]); images.append(np.rint(image_float).astype(int).tolist())
    result = candidate(request, output.cell, output.positions + origin, groups, images,
                       details=dict(matrix=matrix, multiplicity=round(abs(determinant)), sourceVolume=abs(float(np.linalg.det(lattice))), volume=abs(float(np.linalg.det(output.cell)))))
    result['candidate']['structure']['cell']['origin'] = origin.tolist()
    result['candidate']['latticeImageBasis'] = (lattice @ np.linalg.inv(np.asarray(output.cell))).tolist()
    return result


def miller_parameters(parameters):
    miller = parameters.get('miller')
    require(isinstance(miller, list) and len(miller) == 3 and all(type(v) is int and abs(v) <= 9007199254740991 for v in miller) and any(miller), 'Miller indices need three bounded nonzero-together integers')
    divisor = math.gcd(*miller)
    return np.asarray([v // divisor for v in miller], dtype=int)


def terminations(lattice, frac, numbers, miller):
    reciprocal = np.linalg.solve(lattice, miller)
    spacing = 1 / np.linalg.norm(reciprocal)
    normal = reciprocal * spacing
    phases = np.mod(frac @ miller, 1)
    phases[np.isclose(phases, 1, atol=1e-8)] = 0
    levels = sorted(set(round(float(v), 8) for v in phases))
    from ase.data import chemical_symbols
    rows = []
    for i, level in enumerate(levels):
        following = levels[(i + 1) % len(levels)] + (1 if i + 1 == len(levels) else 0)
        shift = ((level + following) / 2) % 1
        shifted = np.mod(phases - shift, 1)
        lower, upper = float(min(shifted)), float(max(shifted))
        elements = lambda plane: sorted({chemical_symbols[numbers[j]] for j in range(len(numbers)) if abs(shifted[j] - plane) < 1e-7})
        rows.append(dict(index=i, shift=shift, lowerElements=elements(lower), upperElements=elements(upper)))
    return rows, normal, spacing


def surface_basis(lattice, indices):
    """ASE general_surface.surface integer basis, retained for source images.

    This follows ASE's BSD-licensed general_surface basis selection; the actual
    lattice/atom construction still calls ASE's public surface API.
    """
    from ase.build.general_surface import ext_gcd
    h, k, l = [int(v) for v in indices]
    if sum(v == 0 for v in indices) == 2:
        return np.asarray([(0, 1, 0), (0, 0, 1), (1, 0, 0)] if h else [(0, 0, 1), (1, 0, 0), (0, 1, 0)] if k else [(1, 0, 0), (0, 1, 0), (0, 0, 1)])
    p, q = ext_gcd(k, l)
    a1, a2, a3 = lattice
    k1 = np.dot(p * (k * a1 - h * a2) + q * (l * a1 - h * a3), l * a2 - k * a3)
    k2 = np.dot(l * (k * a1 - h * a2) - k * (l * a1 - h * a3), l * a2 - k * a3)
    if abs(k2) > 1e-10:
        i = -int(round(k1 / k2)); p, q = p + i * l, q - i * k
    a, b = ext_gcd(p * k + q * l, h)
    return np.asarray([(p * k + q * l, -p * h, -q * h), np.asarray((0, l, -k)) // abs(math.gcd(l, k)), (b, a * p, a * q)])


def slab(request, lattice, frac, numbers, parameters):
    from ase import Atoms
    from ase.build import surface
    miller = miller_parameters(parameters)
    choices, normal, spacing = terminations(lattice, frac, numbers, miller)
    selected = parameters.get('termination', 0)
    require(type(selected) is int and 0 <= selected < len(choices), 'Unknown slab termination')
    mode = parameters.get('thicknessMode', 'angstrom')
    require(mode in ('angstrom', 'layers', 'fractional'), 'Unknown slab thickness mode')
    # Legacy layer-count requests have no continuous start unit. An explicit
    # zero is the same default as omission; never reinterpret layer counts as Å.
    if mode == 'layers':
        require(parameters.get('start', 0) == 0, 'Layer-count slabs do not support nonzero start; use fractional or angstrom')
    continuous = mode != 'layers' and ('start' in parameters or mode == 'fractional')
    thickness = number(parameters.get('thickness', 10), 1e-10 if continuous else .01, None, 'slab thickness')
    start = number(parameters.get('start', 0), None, None, 'slab start') if continuous else 0
    requested_thickness, requested_start = thickness, start
    divisor = math.gcd(*parameters['miller'])
    if mode == 'fractional':
        # d_(g*hkl) = d_hkl/g. Reduce only the construction basis while
        # retaining the physical range expressed in the user's original d.
        thickness /= divisor
        start /= divisor
    if mode == 'layers' and not continuous:
        require(thickness.is_integer(), 'Slab repeat layers must be an integer')
    # The physical atom-to-atom slab thickness is shorter than the repeat-cell
    # height. Add the missing end gap explicitly for a minimum Angstrom request.
    phases = np.mod(frac @ miller - choices[selected]['shift'], 1)
    occupied_span = float(max(phases) - min(phases)) * spacing
    requested_height = thickness * spacing if mode == 'fractional' else thickness
    layers = max(1, math.ceil(requested_height / spacing - 1e-10)) if continuous else int(thickness) if mode == 'layers' else max(1, math.ceil((thickness - occupied_span) / spacing - 1e-10) + 1)
    repeat = parameters.get('repeat', [1, 1])
    require(isinstance(repeat, list) and len(repeat) == 2 and all(type(v) is int and 1 <= v <= 9007199254740991 for v in repeat), 'Invalid in-plane repeat')
    vacuum = number(parameters.get('vacuum', 15), 0, None, 'total slab vacuum')
    position = number(parameters.get('position', vacuum / 2), 0, vacuum, 'slab position')
    shift = start if continuous and mode == 'fractional' else start / spacing if continuous else choices[selected]['shift']
    # Translate along reciprocal hkl normal. Its phase change is exactly shift;
    # no Cartesian stretch or componentwise fractional approximation.
    translation = normal * shift * spacing
    shifted = frac @ lattice - translation
    bulk = Atoms(numbers=numbers, positions=shifted, cell=lattice, pbc=True)
    bulk.new_array('source_index', np.arange(len(numbers), dtype=int))
    output = surface(bulk, miller, layers, periodic=True)
    output *= (repeat[0], repeat[1], 1)
    basis = surface_basis(lattice, miller) @ lattice
    e1 = basis[0] / np.linalg.norm(basis[0])
    e3 = np.cross(basis[0], basis[1]); e3 /= np.linalg.norm(e3)
    e2 = np.cross(e3, e1)
    rotation = np.asarray([e1, e2, e3])
    require(abs(abs(float(np.dot(e3, normal))) - 1) < 1e-8, 'Miller normal does not match slab plane')
    # ASE's one-axis branch chooses a positive surface basis for either sign.
    # Rotate the complete slab and reverse b/c basis signs when needed so the
    # requested signed hkl normal always points along output +z.
    if np.dot(e3, normal) < 0:
        rotation[1:] *= -1
        output.positions[:, 1:] *= -1
        cell = np.asarray(output.cell).copy()
        cell[:, 1:] *= -1; cell[1:] *= -1
        output.set_cell(cell, scale_atoms=False)
        scaled = output.get_scaled_positions(wrap=False)
        scaled[:, :2] %= 1
        output.set_scaled_positions(scaled)
        if continuous:
            # A normal-only c translation is not a source lattice image in a
            # skew cell. Restore the signed repeat interval using the actual
            # integer surface third basis, then wrap only the in-plane axes.
            negative = output.positions[:, 2] < -1e-7
            output.positions[negative] -= layers * (basis[2] @ rotation.T)
            scaled = output.get_scaled_positions(wrap=False)
            scaled[:, :2] %= 1
            output.set_scaled_positions(scaled)
    # Continuous cuts use a closed lower and open upper boundary, in Angstrom.
    # ASE supplies the integer surface basis and wrapped first repeat; only the
    # requested geometric interval is retained. A layer exactly on the lower
    # boundary is included, and one on the upper boundary belongs to the next cut.
    boundary_tolerance = 1e-7
    if continuous:
        z = output.positions[:, 2]
        output = output[(z >= -boundary_tolerance) & (z < requested_height - boundary_tolerance)]
        require(len(output) > 0, 'The requested slab interval contains no atoms')
    groups, images = [], []
    for index, point in zip(output.arrays['source_index'], output.positions):
        index = int(index)
        source_position = point @ rotation
        image = np.linalg.solve(lattice.T, source_position - shifted[index])
        require(np.allclose(image, np.rint(image), atol=1e-6), 'Slab source image mapping failed')
        groups.append([index]); images.append(np.rint(image).astype(int).tolist())
    output.center(vacuum=vacuum / 2, axis=2)
    output.positions[:, 2] += position - vacuum / 2
    z = output.positions[:, 2]
    atom_levels = sorted(set(round(float(v), 7) for v in z))
    lower = sorted({output[i].symbol for i in range(len(output)) if abs(z[i] - min(z)) < 1e-6})
    upper = sorted({output[i].symbol for i in range(len(output)) if abs(z[i] - max(z)) < 1e-6})
    result = candidate(request, output.cell, output.positions, groups, images, pbc=[True, True, True],
                       details=dict(miller=miller.tolist(), requestedMiller=parameters['miller'], normal=normal.tolist(), outputNormal=[0, 0, 1], rotation=rotation.tolist(), interplanarSpacing=float(spacing / divisor), constructionInterplanarSpacing=float(spacing), **({} if continuous else dict(termination=choices[selected])), lowerElements=lower, upperElements=upper, thicknessMode=mode, requestedThickness=requested_thickness, start=requested_start, startAngstrom=float(start * spacing if mode == 'fractional' else start), repeatLayers=layers, atomicLayers=len(atom_levels), actualThickness=float(max(z) - min(z)), vacuum=vacuum, position=position, lowerVacuum=position, upperVacuum=vacuum-position, boundaryRule='lower-inclusive-upper-exclusive', layerTolerance=boundary_tolerance, repeat=repeat, completeCellRetained=True, calculationPeriodicity='source-model-only'))
    result['candidate']['latticeImageBasis'] = (lattice @ rotation.T @ np.linalg.inv(np.asarray(output.cell))).tolist()
    result['candidate']['directionTransforms'] = {atom['id']: rotation.tolist() for atom in result['candidate']['structure']['atoms']}
    return result


def run(request):
    structure, lattice, origin, frac, numbers, parameters, symprec, angle = validate(request)
    operation = request['operation']
    common = dict(documentId=request['documentId'], expectedRevision=request['expectedRevision'], operation=operation)
    if operation in ('symmetry', 'primitive', 'conventional', 'idealize'):
        data = symmetry_data((lattice, frac, numbers), symprec, angle)
        result = dict(symmetry=symmetry_result(data, structure['atoms'], symprec, angle)) if operation == 'symmetry' else standardized(request, lattice, frac, numbers, symprec, angle, data)
    elif operation == 'p1':
        result = candidate(request, lattice, [[a[k] for k in ('x', 'y', 'z')] for a in structure['atoms']], [[i] for i in range(len(numbers))], details=dict(symmetry=dict(number=1, symbol='P1'), geometryUnchanged=True))
        result['candidate']['structure']['cell']['origin'] = origin.tolist()
        result['candidate']['latticeImageBasis'] = np.eye(3).tolist()
    elif operation == 'supercell':
        result = supercell(request, lattice, origin, frac, numbers, parameters)
    elif operation == 'slab-terminations':
        miller = miller_parameters(parameters)
        choices, normal, spacing = terminations(lattice, frac, numbers, miller)
        result = dict(terminations=choices, miller=miller.tolist(), normal=normal.tolist(), interplanarSpacing=spacing)
    else:
        result = slab(request, lattice, frac, numbers, parameters)
    if 'candidate' in result:
        value = result['candidate']
        map_connections(request, value['structure'], value['atomMapping'], value.get('latticeImageBasis', np.eye(3)))
    return {**common, **result}


def main():
    try:
        raw = sys.stdin.buffer.read()
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', DeprecationWarning)
            result = run(json.loads(raw))
        response = dict(ok=True, result=result)
    except Exception as error:
        response = dict(ok=False, error=dict(code='crystal-rejected' if isinstance(error, CrystalError) else 'crystal-native-failed', message=str(error) if isinstance(error, CrystalError) else 'Crystal preview failed; source unchanged'))
    sys.stdout.write(json.dumps(response, ensure_ascii=True, allow_nan=False, separators=(',', ':')) + '\n')
    return 0 if response['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
