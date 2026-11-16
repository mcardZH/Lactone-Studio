"""Equivalent Cartesian s/p/d/f representation for the locked g-xTB producer."""
from dataclasses import dataclass
import hashlib
import math
import re

import numpy as np

VERSION = 'gxtb-cartesian-spdf-v1'
TITLE = 'tblite output; Ester Studio Cartesian normalization v1'
BOHR_ANGSTROM = 0.529177210903
ORDERS = {
    's': [(0, 0, 0)],
    'p': [(1, 0, 0), (0, 1, 0), (0, 0, 1)],
    'd': [(2, 0, 0), (0, 2, 0), (0, 0, 2), (1, 1, 0), (1, 0, 1), (0, 1, 1)],
    'f': [(3, 0, 0), (0, 3, 0), (0, 0, 3), (1, 2, 0), (2, 1, 0), (2, 0, 1), (1, 0, 2), (0, 1, 2), (0, 2, 1), (1, 1, 1)],
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(token):
    value = float(token.replace('D', 'E').replace('d', 'e'))
    require(math.isfinite(value), 'Nonfinite Molden number')
    return value


@dataclass
class Shell:
    kind: str
    center: int
    primitives: np.ndarray
    line: int
    basis: int


@dataclass
class Orbital:
    symmetry: str
    energy: float
    spin: str
    occupation: float
    coefficients: list
    lines: list


def parse(raw, expected_title):
    lines = raw.decode('utf-8-sig').splitlines()
    headers = []
    for index, line in enumerate(lines):
        match = re.fullmatch(r'\s*\[([^]]+)\](.*)', line)
        if match:
            headers.append((match[1].strip().lower(), match[2].strip().lower(), index))
    allowed = {'molden format', 'title', 'atoms', 'gto', 'mo', '6d', '10f', '6d10f'}
    require(all(tag in allowed for tag, _, _ in headers), 'Unverified g-xTB Molden section or angular convention')
    require(all(sum(tag == expected for tag, _, _ in headers) == 1 for expected in ('molden format', 'title', 'atoms', 'gto', 'mo')), 'Missing or duplicate g-xTB Molden section')
    sections = {tag: (suffix, index + 1, headers[i + 1][2] if i + 1 < len(headers) else len(lines)) for i, (tag, suffix, index) in enumerate(headers)}
    _, title_start, title_end = sections['title']
    title_lines = [i for i in range(title_start, title_end) if lines[i].strip()]
    require(len(title_lines) == 1 and lines[title_lines[0]].strip() == expected_title, 'Unexpected g-xTB Molden producer title')
    units, start, end = sections['atoms']
    require(units in ('au', 'angs'), 'g-xTB Molden coordinate units are missing')
    scale = 1 if units == 'au' else 1 / BOHR_ANGSTROM
    atom_ids, atoms = [], []
    for line in lines[start:end]:
        row = line.split()
        if not row:
            continue
        require(len(row) == 6 and int(row[1]) == len(atoms) + 1 and re.fullmatch(r'[A-Z][a-z]?', row[0]), 'g-xTB Molden atom order or element is invalid')
        effective_charge = number(row[2])
        require(effective_charge.is_integer() and effective_charge > 0, 'g-xTB effective nuclear charge is invalid')
        atom_ids.append((row[0], int(effective_charge)))
        atoms.append([number(v) * scale for v in row[3:]])
    require(atoms, 'g-xTB Molden has no atoms')
    _, index, end = sections['gto']
    shells, basis, center = [], [], -1
    while index < end:
        row = lines[index].split()
        index += 1
        if not row:
            continue
        if len(row) == 2 and row[0].isdigit() and row[1] == '0':
            require(int(row[0]) == center + 2 and center + 1 < len(atoms), 'g-xTB GTO atom order is invalid')
            center += 1
            continue
        require(center >= 0 and len(row) == 3 and row[0] in ORDERS and number(row[2]) == 1, 'Unsupported g-xTB GTO shell')
        count = int(row[1])
        require(0 < count <= end - index, 'Incomplete g-xTB primitive list')
        prim = np.array([[number(token) for token in lines[index + j].split()] for j in range(count)])
        require(prim.shape == (count, 2) and np.all(prim[:, 0] > 0), 'Invalid g-xTB Gaussian primitive')
        shells.append(Shell(row[0], center, prim, index, len(basis)))
        basis.extend((center, powers, prim) for powers in ORDERS[row[0]])
        index += count
    require({shell.center for shell in shells} == set(range(len(atoms))), 'g-xTB Molden has an atom without a basis')
    _, start, end = sections['mo']
    groups = []
    for index in range(start, end):
        line = lines[index].strip()
        if not line:
            continue
        if re.match(r'Sym\s*=', line, re.I):
            groups.append([])
        require(groups, 'MO coefficient before the first g-xTB orbital')
        groups[-1].append((line, index))
    orbitals = []
    for group in groups:
        require(len(group) == len(basis) + 4, 'g-xTB MO coefficient dimensions are incomplete')
        fields = {}
        for key, (line, _) in zip(('sym', 'ene', 'spin', 'occup'), group[:4]):
            actual, sep, value = line.partition('=')
            require(sep and actual.strip().lower() == key and value.strip(), 'Incomplete g-xTB MO metadata')
            fields[key] = value.strip()
        occupation = number(fields['occup'])
        spin = fields['spin'].lower()
        require(spin in ('alpha', 'beta') and 0 <= occupation <= 2, 'Invalid g-xTB spin or occupation')
        coefficients, positions = [], []
        for position, (line, line_index) in enumerate(group[4:], 1):
            row = line.split()
            require(len(row) == 2 and int(row[0]) == position, 'Invalid g-xTB MO coefficient index')
            coefficients.append(number(row[1]))
            positions.append(line_index)
        orbitals.append(Orbital(fields['sym'], number(fields['ene']), spin, occupation, coefficients, positions))
    require(orbitals and orbitals[0].spin == 'alpha', 'g-xTB orbitals are missing')
    return lines, title_lines[0], atom_ids, np.array(atoms), shells, basis, orbitals


def factorial2(value):
    return math.prod(range(value, 0, -2))


def primitive_norm(alpha, powers):
    return (2 * alpha / math.pi) ** .75 * np.sqrt((4 * alpha) ** sum(powers) / math.prod(factorial2(2 * power - 1) for power in powers))


def axis_moment(left, right, delta_a, delta_b, exponents):
    value = np.zeros_like(exponents)
    for i in range(left + 1):
        for j in range(right + 1):
            if (i + j) % 2 == 0:
                value += (math.comb(left, i) * math.comb(right, j) * delta_a ** (left - i) * delta_b ** (right - j)
                          * factorial2(i + j - 1) / (2 * exponents) ** ((i + j) // 2))
    return value


def overlap(atoms, basis, normalized=False):
    matrix = np.empty((len(basis), len(basis)))
    for i, (center_a, powers_a, primitive_a) in enumerate(basis):
        atom_a = atoms[center_a]
        a, ca = primitive_a.T[:, :, None]
        for j in range(i + 1):
            center_b, powers_b, primitive_b = basis[j]
            atom_b = atoms[center_b]
            b, cb = primitive_b.T[:, None, :]
            p = a + b
            distance = atom_b - atom_a
            term = ca * cb * (math.pi / p) ** 1.5 * np.exp(-a * b / p * np.dot(distance, distance))
            if normalized:
                term *= primitive_norm(a, powers_a) * primitive_norm(b, powers_b)
            for axis, (left, right) in enumerate(zip(powers_a, powers_b)):
                term *= axis_moment(left, right, b * distance[axis] / p, -a * distance[axis] / p, p)
            matrix[i, j] = matrix[j, i] = term.sum()
    require(np.isfinite(matrix).all(), 'Nonfinite g-xTB overlap')
    return matrix


def orbital_values(atoms, basis, coefficients, points, normalized=False):
    values = np.empty((len(points), len(basis)))
    for i, (center, powers, primitives) in enumerate(basis):
        delta = points - atoms[center]
        radius_squared = np.sum(delta ** 2, axis=1)
        exponents, weights = primitives.T
        if normalized:
            weights = weights * primitive_norm(exponents, powers)
        values[:, i] = np.prod(delta ** powers, axis=1) * (np.exp(-radius_squared[:, None] * exponents) @ weights)
    return values @ coefficients


def gram_metrics(matrix, orbitals, coefficients):
    max_error = integrated_electrons = 0.
    for spin in ('alpha', 'beta'):
        indices = [i for i, orbital in enumerate(orbitals) if orbital.spin == spin]
        if not indices:
            continue
        channel = coefficients[:, indices]
        gram = channel.T @ matrix @ channel
        require(np.isfinite(gram).all(), 'Nonfinite g-xTB orbital Gram matrix')
        max_error = max(max_error, float(np.max(np.abs(gram - np.eye(len(indices))))))
        integrated_electrons += float(np.diag(gram) @ [orbitals[i].occupation for i in indices])
    return max_error, integrated_electrons


def convert(raw, expected_atoms, charge, uhf):
    from orbitals import SYMBOLS
    lines, title, atom_ids, atoms, shells, basis, orbitals = parse(raw, 'tblite output')
    require([name for name, _ in atom_ids] == [atom['element'] for atom in expected_atoms], 'g-xTB Molden elements differ from the input')
    expected = np.array([[atom[axis] for axis in ('x', 'y', 'z')] for atom in expected_atoms])
    require(np.max(np.abs(atoms * BOHR_ANGSTROM - expected)) <= 1e-7, 'g-xTB Molden geometry differs from the input')
    charges = [value for _, value in atom_ids]
    require(all(element in SYMBOLS[1:] and z <= SYMBOLS.index(element) for element,z in atom_ids), 'g-xTB effective nuclear charge exceeds the chemical nuclear charge')
    represented = sum(orbital.occupation for orbital in orbitals)
    require(represented > 0 and abs(sum(charges) - represented - charge) <= 1e-7, 'g-xTB effective nuclear charges and occupations disagree with the input charge')
    alpha = sum(orbital.occupation for orbital in orbitals if orbital.spin == 'alpha')
    beta = sum(orbital.occupation for orbital in orbitals if orbital.spin == 'beta')
    independent = any(orbital.spin == 'beta' for orbital in orbitals)
    if independent:
        spin_order = [orbital.spin for orbital in orbitals]
        require(spin_order == sorted(spin_order) and all(orbital.occupation <= 1 for orbital in orbitals), 'Unrestricted g-xTB Molden channels are invalid')
    else:
        alpha = beta = represented / 2
    require(abs(alpha - beta - uhf) <= 1e-7, 'g-xTB MO occupations disagree with the requested spin')
    require(all(sum(orbital.spin == spin for orbital in orbitals) <= len(basis) for spin in ('alpha', 'beta')), 'g-xTB has more channel orbitals than basis functions')

    raw_overlap = overlap(atoms, basis)
    raw_coefficients = np.array([orbital.coefficients for orbital in orbitals]).T
    original_error, original_integral = gram_metrics(raw_overlap, orbitals, raw_coefficients)
    require(original_error <= 1e-7 and abs(original_integral - represented) <= represented * 1e-7, 'g-xTB original MO overlap or electronic integral is invalid')
    scales = np.sqrt(np.diag(raw_overlap))
    require(np.isfinite(scales).all() and np.all(scales > 0), 'g-xTB basis norms are invalid')
    lines[title] = ' ' + TITLE
    for shell in shells:
        powers = ORDERS[shell.kind][0]
        for offset, (exponent, weight) in enumerate(shell.primitives):
            value = weight / primitive_norm(exponent, powers) / scales[shell.basis]
            lines[shell.line + offset] = f' {exponent:.16E} {value:.16E}'
    for orbital in orbitals:
        for i, (coefficient, line) in enumerate(zip(orbital.coefficients, orbital.lines)):
            lines[line] = f' {i + 1:6d} {coefficient * scales[i]: .16E}'
    derived = ('\n'.join(lines) + '\n').encode('ascii')
    _, _, new_ids, new_atoms, _, new_basis, new_orbitals = parse(derived, TITLE)
    orbital_identity = lambda rows: [(o.symmetry, o.energy, o.spin, o.occupation) for o in rows]
    require(atom_ids == new_ids and np.array_equal(atoms, new_atoms) and orbital_identity(orbitals) == orbital_identity(new_orbitals), 'g-xTB conversion changed the atoms or MO metadata')
    derived_overlap = overlap(atoms, new_basis, normalized=True)
    derived_coefficients = np.array([orbital.coefficients for orbital in new_orbitals]).T
    derived_error, derived_integral = gram_metrics(derived_overlap, new_orbitals, derived_coefficients)
    covariance_error = float(np.max(np.abs(derived_overlap - raw_overlap / np.outer(scales, scales))))
    points = np.concatenate((atoms + np.array([.23, .57, .91]), atoms + np.array([-.78, .45, -.32])))
    before = orbital_values(atoms, basis, raw_coefficients, points)
    after = orbital_values(atoms, new_basis, derived_coefficients, points, normalized=True)
    orbital_difference = float(np.max(np.abs(after - before)) / (1 + np.max(np.abs(before))))
    require(derived_error <= 1e-7 and abs(derived_integral - represented) <= represented * 1e-7 and covariance_error <= 1e-9 and orbital_difference <= 1e-10,
            'g-xTB Cartesian conversion failed overlap, occupation or orbital invariance')
    return derived, dict(version=VERSION, originalSha256=hashlib.sha256(raw).hexdigest(), derivedSha256=hashlib.sha256(derived).hexdigest(),
                         effectiveNuclearCharges=charges, representedElectrons=represented, spinResolution='alpha-beta' if independent else 'restricted',
                         alphaElectrons=alpha, betaElectrons=beta, basisCount=len(basis), orbitalCount=len(orbitals), originalGramMaxError=original_error,
                         derivedGramMaxError=derived_error, overlapCovarianceMaxError=covariance_error, relativeOrbitalValueDifference=orbital_difference)
