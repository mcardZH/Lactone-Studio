"""Owned Multiwfn main-12 adapter. Scientific values come only from native output.

The host supplies immutable local sources and stamps. This module never changes
the user's settings or invokes an upstream quantum program. A session retains
native surface vertices and prepares area distributions in the explicit analysis
task. Legacy explicit region/distribution requests remain available; field
generation is a separate operation and publishes only complete validated pairs.
"""
from __future__ import annotations

import base64
import ctypes
import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

import numpy as np
from multiwfn_resources import resolve_resources, _override, _values
from orbitals import OrbitalError, MultiwfnSession, _windows_owned_job, inspect_wavefunction

NUMBER = r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[dDeE][+-]?\d+)?'
VALUE = r'(?:' + NUMBER + r'|NaN|[+-]?Infinity)'
MAIN_MENU = '************ Main function menu'
SETUP_END = '6 Start analysis without considering mapped function'
POST_END = '19 Merge some surface extrema and take their average position'
GRID_END = '9 Multiply all grid data by Hirshfeld weights of a fragment'
BOHR_TO_ANGSTROM = 0.529177210903
NATIVE_REGION_DEFINITION = 'Multiwfn main-12 native atomic surface partition (effective imolsurparmode); fragment is the union of the selected native atomic regions.'


class SurfaceError(OrbitalError):
    pass


def number(raw, nullable=False):
    try:
        value = float(raw.replace('D', 'E').replace('d', 'e'))
    except (ValueError, AttributeError):
        raise SurfaceError('surface-number', 'Native output contains an invalid number.')
    if not math.isfinite(value):
        if nullable:
            return None
        raise SurfaceError('surface-number', 'A required native value is not finite.')
    if value == 0 and any(char in '123456789' for char in re.split('[eEdD]', raw)[0]):
        raise SurfaceError('surface-number', 'A source scalar underflowed its finite representation.')
    return value


def half_last_digit(raw):
    mantissa, *exponent = re.split('[eEdD]', raw)
    decimals = len(mantissa.partition('.')[2])
    try:
        precision = .5 * 10. ** ((int(exponent[0]) if exponent else 0) - decimals)
    except OverflowError:
        raise SurfaceError('surface-number', 'Source printing precision exceeds finite representation.')
    if not math.isfinite(precision):
        raise SurfaceError('surface-number', 'Source printing precision is not finite.')
    return precision


def domain_node_mask(domain, count):
    """Validate membership before uint8 conversion (256 must not wrap to zero)."""
    try:
        if 'maskBase64' in domain:
            mask = np.frombuffer(base64.b64decode(domain['maskBase64'], validate=True), dtype=np.uint8)
        else:
            values = domain.get('mask', [])
            if not isinstance(values, list) or any(type(value) is not int or value not in (0, 1) for value in values):
                raise ValueError('Invalid node membership')
            mask = np.asarray(values, dtype=np.uint8)
    except (ValueError, TypeError):
        raise SurfaceError('surface-domain', 'The restricted field mask has invalid node membership.')
    if mask.size != count or not np.isin(mask, [0, 1]).all():
        raise SurfaceError('surface-domain', 'The restricted field mask has an invalid shape or node membership.')
    return mask


def retained_size(value, seen=None):
    """Conservative owned Python data estimate, including NumPy scalar arrays."""
    seen = set() if seen is None else seen
    if id(value) in seen:
        return 0
    seen.add(id(value))
    if isinstance(value, np.ndarray):
        return int(value.nbytes) + 128
    size = sys.getsizeof(value)
    if isinstance(value, dict):
        size += sum(retained_size(key, seen) + retained_size(entry, seen) for key, entry in value.items())
    elif isinstance(value, (list, tuple, set)):
        size += sum(retained_size(entry, seen) for entry in value)
    return size


def metric(key, label, raw, unit, dimension, line=None):
    result = dict(key=key, label=label, value=number(raw, True), rawValue=raw, unit=unit, dimension=dimension)
    if line is not None:
        result['sourceLine'] = line
    return result


def parse_metrics(output):
    """Retain native units/undefined values; never derive missing descriptors."""
    found = {}
    aliases = {
        'Overall average value': ('average', 'mapping-value'), 'Average value': ('average', 'mapping-value'),
        'Positive average value': ('positive-average', 'mapping-value'), 'Negative average value': ('negative-average', 'mapping-value'),
        'Overall variance (sigma^2_tot)': ('variance', 'mapping-variance'), 'Variance': ('variance', 'mapping-variance'),
        'Positive variance': ('positive-variance', 'mapping-variance'), 'Negative variance': ('negative-variance', 'mapping-variance'),
        'Balance of charges (nu)': ('balance', 'dimensionless'), 'Product of sigma^2_tot and nu': ('variance-balance', 'mapping-variance'),
        'Internal charge separation (Pi)': ('internal-charge-separation', 'mapping-value'), 'Molecular polarity index (MPI)': ('mpi', 'mapping-value'),
        'Sphericity': ('sphericity', 'dimensionless'), 'Overall skewness': ('skewness', 'dimensionless'),
        'Positive skewness': ('positive-skewness', 'dimensionless'), 'Negative skewness': ('negative-skewness', 'dimensionless'),
    }
    for line, text in enumerate(output.splitlines(), 1):
        area = re.match(r'\s*(Overall surface area|Positive surface area|Negative surface area|Surface area):\s*(' + VALUE + r')\s+Bohr\^2\s*\(\s*(' + VALUE + r')\s+Angstrom\^2\)', text, re.I)
        if area:
            label = area[1]
            key = 'area' if label.lower() in ('overall surface area', 'surface area') else 'positive-area' if label.startswith('Positive') else 'negative-area'
            found[key] = metric(key, label, area[3], 'angstrom^2', 'area', line)
            continue
        volume = re.match(r'\s*(?:Volume|Volume enclosed by the isosurface):\s*(' + VALUE + r')\s+Bohr\^3\s*\(\s*(' + VALUE + r')\s+Angstrom\^3\)', text, re.I)
        if volume:
            found['volume'] = metric('volume', 'Volume', volume[2], 'angstrom^3', 'volume', line)
            continue
        extrema = re.match(r'\s*Minimal value:\s*(' + VALUE + r')\s+(\S+)[, ]+\s*Maximal value:\s*(' + VALUE + r')\s+(\S+)', text, re.I)
        if extrema:
            for key, raw, unit in [('minimum', extrema[1], extrema[2]), ('maximum', extrema[3], extrema[4])]:
                found[key] = metric(key, key.title(), raw, unit.rstrip(','), 'mapping-value', line)
            continue
        for label, (key, dimension) in aliases.items():
            match = re.match(r'\s*' + re.escape(label) + r':\s*(' + VALUE + r')(?:\s+(a\.u\.\^2|a\.u\.|eV))?', text, re.I)
            if match:
                unit = match[2] or ('dimensionless' if dimension == 'dimensionless' else None)
                found[key] = metric(key, label, match[1], unit, dimension, line)
                break
        polar = re.match(r'\s*(Nonpolar|Polar) surface area\s*\([^)]*\):\s*(' + VALUE + r')\s+Angstrom\^2\s*\(\s*(' + VALUE + r')\s+%\)', text)
        if polar:
            prefix = polar[1].lower()
            found[prefix + '-area'] = metric(prefix + '-area', polar[1] + ' surface area', polar[2], 'angstrom^2', 'area', line)
            found[prefix + '-fraction-percent'] = metric(prefix + '-fraction-percent', polar[1] + ' surface fraction', polar[3], '%', 'dimensionless', line)
    return list(found.values())


def parse_extrema(text, function, region_id='molecule'):
    result, kind, expected, counts = [], None, {}, {}
    for line, raw in enumerate(text.splitlines(), 1):
        heading = re.search(r'Number of surface (minima|maxima):\s*(\d+)', raw)
        if heading:
            kind = 'minimum' if heading[1] == 'minima' else 'maximum'
            expected[kind] = int(heading[2]); counts[kind] = 0
            continue
        match = re.match(r'\s*(\*)?\s*(\d+)\s+(' + NUMBER + r')\s+(' + NUMBER + r')\s+(' + NUMBER + r')\s+(' + NUMBER + r')\s+(' + NUMBER + r')\s+(' + NUMBER + r')\s*$', raw)
        if match and kind:
            index = int(match[2]); counts[kind] += 1
            result.append(dict(id=f'{region_id}:{kind}:{index}', sourceIndex=index, type=kind, scope='global' if match[1] else 'local',
                               regionId=region_id, function=function, position=[number(match[i]) for i in (6, 7, 8)],
                               coordinateUnit='angstrom', value=number(match[3]), valueUnit='a.u.', sourceLine=line))
    if set(expected) != {'minimum', 'maximum'} or counts != expected:
        raise SurfaceError('surface-extrema', 'Native extrema export is absent, truncated or inconsistent.')
    return result


def selected_atoms(selection, atom_count):
    if not isinstance(selection, dict) or selection.get('kind') not in ('molecule', 'atoms', 'fragment'):
        raise SurfaceError('surface-region', 'Select an explicit native surface region.')
    indices = selection.get('atomIndices', [])
    if not isinstance(indices, list) or any(isinstance(i, bool) or not isinstance(i, int) or not 1 <= i <= atom_count for i in indices) or len(set(indices)) != len(indices):
        raise SurfaceError('surface-region', 'Surface region atom indices must be unique one-based source ordinals.')
    if selection['kind'] != 'molecule' and not indices:
        raise SurfaceError('surface-region', 'The selected atom/fragment region is empty.')
    if selection['kind'] == 'atoms' and len(indices) != 1:
        raise SurfaceError('surface-region', 'One atomic region must identify exactly one source atom; use separate selections or an explicit fragment.')
    return 'all' if selection['kind'] == 'molecule' else ','.join(map(str, sorted(indices)))


def region_result(selection, output, extrema=None):
    metrics = parse_metrics(output)
    area = next((entry['value'] for entry in metrics if entry['key'] == 'area'), None)
    return dict(selection=selection, nativeDefinition=NATIVE_REGION_DEFINITION, area=area, areaUnit='angstrom^2', metrics=metrics, extrema=extrema or [])


def parse_distribution(output, request, whole_area):
    if not math.isfinite(whole_area) or whole_area <= 0:
        raise SurfaceError('surface-distribution', 'A positive whole-molecule area is required for the native denominator.')
    rows, in_table, total = [], False, None
    for line, raw in enumerate(output.splitlines(), 1):
        if re.search(r'Begin\s+End\s+Center\s+Area\s+%', raw):
            in_table = True; continue
        if not in_table:
            continue
        summary = re.match(r'\s*Sum:\s*(' + NUMBER + r')\s+(' + NUMBER + r')', raw)
        if summary:
            total = number(summary[1]); break
        values = raw.split()
        if len(values) == 5 and all(re.fullmatch(NUMBER, token) for token in values):
            lower, upper, _center, area, percent = map(number, values)
            rows.append(dict(lower=lower, upper=upper, lowerInclusive=True, upperInclusive=False, area=area,
                             fraction=percent / 100, nativePercent=percent))
    if total is None or len(rows) != request['binCount']:
        raise SurfaceError('surface-distribution', 'Native distribution table is incomplete or has a different bin count.')
    # Native printed values have four decimals. Preserve its reported sum and %;
    # never renormalize a selected fragment or a deliberately truncated range.
    if any(row['area'] < 0 or row['upper'] < row['lower'] for row in rows):
        raise SurfaceError('surface-distribution', 'Native distribution contains an invalid interval or area.')
    return dict(stamp=request['stamp'], regionId=request['regionId'], valueUnit=request['valueUnit'], areaUnit='angstrom^2',
                bins=rows, denominator=dict(area=whole_area, definition='Native main-12 percentages use the whole molecular surface area.', scope='molecule'),
                coveredArea=total, method='native-area')


def read_scalar_cube(path, memory_budget=None, coordinate_unit=None):
    """Stream exact scalar records; retain only the real Float64 field array."""
    path = Path(path); initial = path.stat(); digest = hashlib.sha256()
    with path.open('rb') as stream:
        line_number = 0
        def line():
            nonlocal line_number
            raw = stream.readline()
            if not raw:
                raise SurfaceError('surface-cube', 'Cube header or atom records are truncated.')
            digest.update(raw); line_number += 1
            try:
                return raw.decode('utf-8-sig' if line_number == 1 else 'utf-8').rstrip('\r\n')
            except UnicodeDecodeError as exc:
                raise SurfaceError('surface-cube', 'Cube must be readable UTF-8 text.') from exc
        comments = [line(), line()]; head = line().split()
        if len(head) not in (4, 5) or not re.fullmatch(r'[+-]?\d+', head[0]):
            raise SurfaceError('surface-cube', 'Cube atom header is invalid.')
        declared_count = int(head[0]); count = abs(declared_count)
        if count < 1 or len(head) == 5 and head[4] != '1':
            raise SurfaceError('surface-cube', 'Only a single scalar Cube dataset is supported.')
        origin = [number(value) for value in head[1:4]]
        precision = dict(origin=[half_last_digit(value) for value in head[1:4]], axes=[], atomCoordinates=[], nuclearCharges=[])
        dimensions, axes, signs = [], [], []
        for _ in range(3):
            row = line().split()
            if len(row) != 4 or not re.fullmatch(r'[+-]?\d+', row[0]) or int(row[0]) == 0:
                raise SurfaceError('surface-cube', 'Cube grid header is invalid.')
            dimensions.append(abs(int(row[0]))); signs.append(int(row[0]) > 0); axes.append([number(value) for value in row[1:]])
            precision['axes'].append([half_last_digit(value) for value in row[1:]])
        if len(set(signs)) != 1 or abs(float(np.linalg.det(np.asarray(axes)))) < 1e-15:
            raise SurfaceError('surface-cube', 'Cube grid units are mixed or its affine basis is singular.')
        if coordinate_unit not in (None, 'bohr', 'angstrom') or not signs[0] and coordinate_unit is None:
            raise SurfaceError('surface-cube-unit', 'A negative-axis Cube requires explicit source spatial-unit metadata; units were not guessed.')
        atoms = []
        for i in range(1, count + 1):
            row = line().split()
            if len(row) != 5 or not re.fullmatch(r'\d+', row[0]) or not 1 <= int(row[0]) <= 118:
                raise SurfaceError('surface-cube', 'Cube atom record is invalid.')
            atoms.append(dict(sourceIndex=i, atomicNumber=int(row[0]), nuclearCharge=number(row[1]), position=[number(value) for value in row[2:]]))
            precision['atomCoordinates'].append([half_last_digit(value) for value in row[2:]])
            precision['nuclearCharges'].append(half_last_digit(row[1]))
        def tokens():
            for raw in stream:
                digest.update(raw)
                try: record = raw.decode('utf-8')
                except UnicodeDecodeError as exc: raise SurfaceError('surface-cube', 'Cube must be readable UTF-8 text.') from exc
                yield from record.split()
        data = tokens(); dataset_id = None
        if declared_count < 0:
            first, second = next(data, None), next(data, None)
            if first != '1' or second is None or re.fullmatch(r'[+-]?\d+', second) is None:
                raise SurfaceError('surface-cube-dataset', 'Cube dataset header is missing or has multiple datasets.')
            dataset_id = int(second)
        points = math.prod(dimensions)
        try: values = np.empty(points, dtype=np.float64)
        except (MemoryError, ValueError, OverflowError) as exc: raise SurfaceError('surface-memory', 'The exact Cube array could not be allocated; its source remains intact.') from exc
        filled = 0
        for token in data:
            if filled >= points or re.fullmatch(NUMBER, token) is None:
                raise SurfaceError('surface-cube', 'Cube value records are invalid or inconsistent with the declared scalar count.')
            values[filled] = number(token); filled += 1
        if filled != points:
            raise SurfaceError('surface-cube', 'Cube values are truncated; no missing node was filled.')
    final = path.stat()
    if (initial.st_size, initial.st_mtime_ns) != (final.st_size, final.st_mtime_ns):
        raise SurfaceError('surface-cube-changed', 'Cube changed during its complete streamed read.')
    return dict(comments=comments, grid=dict(coordinateUnit=coordinate_unit or 'bohr', origin=origin, axes=axes, dimensions=dimensions, ordering='z-fastest'),
                atoms=atoms, values=values, precision=precision, revision=digest.hexdigest(), bytes=final.st_size, datasetId=dataset_id)


def require_cube_pair(shape, mapping):
    if shape['grid']['coordinateUnit'] != mapping['grid']['coordinateUnit'] or shape['grid']['dimensions'] != mapping['grid']['dimensions'] or len(shape['atoms']) != len(mapping['atoms']):
        raise SurfaceError('surface-cube-pair', 'Cube units, dimensions or atom inventory do not match.')
    pairs = [(shape['grid']['origin'], mapping['grid']['origin'], shape['precision']['origin'], mapping['precision']['origin'])]
    pairs.extend(zip(shape['grid']['axes'], mapping['grid']['axes'], shape['precision']['axes'], mapping['precision']['axes']))
    for i, (a, b) in enumerate(zip(shape['atoms'], mapping['atoms'])):
        if a['atomicNumber'] != b['atomicNumber'] or a['sourceIndex'] != b['sourceIndex']:
            raise SurfaceError('surface-cube-pair', 'Cube source atom identities do not match.')
        pairs.append((a['position'], b['position'], shape['precision']['atomCoordinates'][i], mapping['precision']['atomCoordinates'][i]))
        pairs.append(([a['nuclearCharge']], [b['nuclearCharge']], [shape['precision']['nuclearCharges'][i]], [mapping['precision']['nuclearCharges'][i]]))
    for a, b, pa, pb in pairs:
        if any(abs(x - y) > px + py + 64 * np.finfo(float).eps * max(abs(x), abs(y), 1) for x, y, px, py in zip(a, b, pa, pb)):
            raise SurfaceError('surface-cube-pair', 'Cube coordinates or complete grid vectors conflict beyond their original printing precision.')


def require_native_cube_grid(cube):
    grid = cube['grid']; axes = np.asarray(grid['axes'])
    if any(axes[i, j] != 0 for i in range(3) for j in range(3) if i != j) or any(axes[i, i] <= 0 for i in range(3)):
        raise SurfaceError('surface-grid-native', 'This verified Multiwfn main-12 profile requires a positive axis-aligned grid; the original Cube is retained without transformation or resampling.')


def write_native_cube(cube, target, comments=None):
    """Only normalize spatial units in an owned copy, never values or rho iso."""
    factor = 1 if cube['grid']['coordinateUnit'] == 'bohr' else 1 / BOHR_TO_ANGSTROM
    grid = cube['grid']; comments = comments or cube['comments']
    rows = [str(comments[0]), str(comments[1]), f"{len(cube['atoms']):5d} " + ' '.join(f'{value * factor:.16e}' for value in grid['origin'])]
    rows.extend(f'{count:5d} ' + ' '.join(f'{value * factor:.16e}' for value in axis) for count, axis in zip(grid['dimensions'], grid['axes']))
    rows.extend(f"{atom['atomicNumber']:5d} {atom['nuclearCharge']:.16e} " + ' '.join(f'{value * factor:.16e}' for value in atom['position']) for atom in cube['atoms'])
    values = cube['values']
    # Native Fortran readers consume one z-column in records of at most six.
    # A record must not straddle two y-columns when nz is not divisible by six.
    nz = grid['dimensions'][2]
    rows.extend(' '.join(f'{float(value):.16e}' for value in values[start + i:start + min(i + 6, nz)])
                for start in range(0, values.size, nz) for i in range(0, nz, 6))
    Path(target).write_text('\n'.join(rows) + '\n', encoding='utf-8')


def read_surface_vertex_file(path, memory_budget, with_values=False, current=lambda: None):
    """Native main-12 point order and printed Bohr coordinates are immutable."""
    current(); path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise SurfaceError('surface-point-file', 'Native surface point file is missing or exceeds the available parsing budget.')
    raw = path.read_bytes()
    try:
        lines = raw.decode('utf-8').splitlines()
    except UnicodeDecodeError:
        raise SurfaceError('surface-point-file', 'Native surface points are not valid UTF-8.')
    if not lines or not re.fullmatch(r'\s*\d+\s*', lines[0]):
        raise SurfaceError('surface-point-file', 'Native surface point count is missing.')
    count = int(lines[0])
    if count < 1 or len(lines) != count + 1:
        raise SurfaceError('surface-point-file', 'Native point count and complete ordered coordinate rows disagree.')
    tokens = []; positions = []; values = []
    for i, line in enumerate(lines[1:]):
        if i % 64 == 0:
            current()
        fields = line.split()
        if len(fields) not in ((4, 6) if with_values else (3,)) or any(re.fullmatch(r'[+-]?\d+\.\d{7}', token) is None for token in fields[:3]):
            raise SurfaceError('surface-point-file', 'Expected native seven-decimal Bohr XYZ rows in their original order.')
        positions.append(tuple(number(token) for token in fields[:3])); tokens.append(tuple(fields[:3]))
        if with_values:
            if any(re.fullmatch(NUMBER, token) is None for token in fields[3:]):
                raise SurfaceError('surface-point-file', 'Cached surface values contain an invalid scalar token.')
            scalars = [number(token) for token in fields[3:]]; values.append(scalars[0])
    current()
    return dict(header=lines[0], rows=lines[1:], tokens=tokens, positions=positions, values=values,
                count=count, revision=hashlib.sha256(raw).hexdigest())


def create_surface_mapping_sampler(cube, mask=None):
    """Same floor/fraction/eight-weight definition as createSurfaceFieldSampler.

    No epsilon, coordinate clamp, missing-neighbour fill or zero-value filter.
    Native main-12 retains ownership of the mesh and all surface statistics.
    """
    grid = cube['grid']; dimensions = grid['dimensions']; values = cube['values']
    if grid['coordinateUnit'] != 'bohr' or len(dimensions) != 3 or any(type(n) is not int or n < 2 for n in dimensions) or values.size != math.prod(dimensions) or not np.isfinite(values).all():
        raise SurfaceError('surface-interpolation', 'The canonical native mapping grid or scalar inventory is invalid.')
    a, b, c = grid['axes']
    cross = lambda x, y: [x[1]*y[2]-x[2]*y[1], x[2]*y[0]-x[0]*y[2], x[0]*y[1]-x[1]*y[0]]
    def dot(x, y):
        # Match JavaScript reduce's left-to-right Float64 operations, including
        # Python versions whose built-in sum uses compensated accumulation.
        result = 0.
        for left, right in zip(x, y):
            result += left * right
        return result
    numerator = [cross(b, c), cross(c, a), cross(a, b)]; denominator = dot(a, numerator[0])
    if not math.isfinite(denominator) or denominator == 0:
        raise SurfaceError('surface-interpolation', 'Mapping grid inverse is singular or nonfinite.')
    inverse = [[value / denominator for value in row] for row in numerator]
    if not all(math.isfinite(value) for row in inverse for value in row) or not all(math.isfinite(value) for value in grid['origin']):
        raise SurfaceError('surface-interpolation', 'Mapping grid inverse/origin exceeds finite representation.')
    if mask is not None and (mask.size != values.size or not np.isin(mask, [0, 1]).all()):
        raise SurfaceError('surface-domain', 'Mapping node mask has an invalid inventory.')
    def sample(position):
        if len(position) != 3 or not all(math.isfinite(value) for value in position):
            raise SurfaceError('surface-interpolation', 'Requested surface point is not finite.')
        local = [value - origin for value, origin in zip(position, grid['origin'])]
        coordinates = [dot(row, local) for row in inverse]
        if any(not math.isfinite(value) or value < 0 or value > dimensions[i] - 1 for i, value in enumerate(coordinates)):
            raise SurfaceError('surface-domain', 'A requested surface point lies outside the complete mapping grid.')
        # At the exact final grid node, use the cell ending at that node. The
        # requested coordinate is unchanged and all eight neighbours are required.
        base = [math.floor(value) for value in coordinates]
        base = [value - 1 if value == dimensions[i] - 1 else value for i, value in enumerate(base)]
        fraction = [value - lower for value, lower in zip(coordinates, base)]; result = 0.
        for x, y, z in itertools.product((0, 1), repeat=3):
            index = ((base[0]+x)*dimensions[1]+base[1]+y)*dimensions[2]+base[2]+z
            if mask is not None and mask[index] != 1:
                raise SurfaceError('surface-domain', 'A requested surface vertex lacks all eight valid mapping neighbours; no value was filled or omitted.')
            result += float(values[index]) * (fraction[0] if x else 1-fraction[0]) * (fraction[1] if y else 1-fraction[1]) * (fraction[2] if z else 1-fraction[2])
        if not math.isfinite(result):
            raise SurfaceError('surface-interpolation', 'Interpolated mapping value is not finite.')
        return result
    return sample


def esp_direct_node_mask(density, dimensions, isovalue, layers=1):
    """Native ESPrhoiso direct-evaluation domain; copied neighbours are excluded.

    A non-edge node is evaluated when its surrounding (2*n+1)^3-1 nodes,
    excluding itself, contain both rho>=iso and rho<iso. This predicate is
    independently checked against the actual native printed evaluation count.
    It never infers coverage from an ESP value (a physical zero remains valid).
    """
    if isinstance(layers, bool) or not isinstance(layers, int) or not 1 <= layers <= 8:
        raise SurfaceError('surface-domain', 'Unsupported native ESPrhonlay; no validity mask was guessed.')
    values = np.asarray(density, dtype=np.float64).reshape(dimensions)
    mask = np.zeros(dimensions, dtype=np.uint8)
    inner = tuple(length - 2 * layers for length in dimensions)
    if min(inner) <= 0:
        return mask.ravel()
    outside = values < isovalue
    counts = np.zeros(inner, dtype=np.uint16)
    for offsets in itertools.product(range(-layers, layers + 1), repeat=3):
        if offsets == (0, 0, 0):
            continue
        slices = tuple(slice(layers + offset, length - layers + offset) for length, offset in zip(dimensions, offsets))
        counts += outside[slices]
    count = (2 * layers + 1) ** 3 - 1
    mask[tuple(slice(layers, length - layers) for length in dimensions)] = (counts > 0) & (counts < count)
    return mask.ravel()


def crossing_domain_coverage(density, dimensions, isovalue, mask):
    values = np.asarray(density).reshape(dimensions); domain = np.asarray(mask).reshape(dimensions)
    inner = tuple(length - 1 for length in dimensions)
    if min(inner) <= 0:
        raise SurfaceError('surface-domain', 'A surface grid requires at least two points along each direction.')
    minimum = np.full(inner, np.inf); maximum = np.full(inner, -np.inf); supported = np.ones(inner, dtype=bool)
    for offset in itertools.product((0, 1), repeat=3):
        slices = tuple(slice(start, length - 1 + start) for length, start in zip(dimensions, offset))
        np.minimum(minimum, values[slices], out=minimum); np.maximum(maximum, values[slices], out=maximum); supported &= domain[slices].astype(bool)
    crossing = (minimum < isovalue) & (maximum >= isovalue)
    return dict(crossingCells=int(crossing.sum()), allEightValidCells=int((crossing & supported).sum()), invalidCrossingCells=int((crossing & ~supported).sum()))


def target_grid_dimensions(positions, extension, target):
    """Use the actual native box, preserving it while making steps nearly isotropic."""
    coordinates = np.asarray(positions, dtype=float)
    lengths = coordinates.max(axis=0) - coordinates.min(axis=0) + 2 * extension
    if target not in (32768, 4096000) or not np.isfinite(lengths).all() or np.any(lengths <= 0):
        raise SurfaceError('surface-grid', 'Target grid requires a finite complete native box.')
    # Solve product(L/h + 1) = target, then round each axis, retaining >=2 nodes.
    low, high = 0., float(max(lengths)) * target
    for _ in range(80):
        spacing = (low + high) / 2
        if math.prod(lengths / spacing + 1) > target: low = spacing
        else: high = spacing
    return [max(2, int(math.floor(float(length / high) + 1.5))) for length in lengths]


class NativeSurfaceProcess:
    """One cancellable owned native process, exact prompt-driven transitions."""
    def __init__(self, executable, source, work, resources, settings, progress_callback=None):
        self.progress_callback=progress_callback
        self.executable, self.source, self.work = Path(executable), Path(source), Path(work)
        self.resources = resources; self.process = None; self.job = None
        self.stopped = threading.Event(); self.queue = queue.Queue(); self.log = self.work / 'native-output.txt'
        self.lifecycle = threading.RLock(); self.progress = None; self.last_answers = []; self.command_cpu = None
        self.phase = 'created'; self.last_wait_marker = None; self.wait_started_at = None; self.native_exit_code = None
        (self.work / 'settings.ini').write_bytes(settings)
        self.menu_log = self.work / 'menu-input.txt'; self.backend = None

    def record_status(self, phase):
        """Small local diagnostics, separate from scientific outputs and progress."""
        self.phase = phase
        try:
            (self.work / 'native-status.json').write_text(json.dumps(dict(
                phase=phase, recordedAt=time.time(), lastWaitMarker=self.last_wait_marker,
                waitStartedAt=self.wait_started_at, lastAnswers=self.last_answers,
                exitCode=self.native_exit_code, processId=self.process.pid if self.process else None,
                resources=self.resources, executable=str(self.executable), source=str(self.source)),
                ensure_ascii=False, allow_nan=False), encoding='utf-8')
        except (OSError, TypeError, ValueError):
            pass  # Diagnostics must not change native execution or result validity.

    def start(self):
        from multiwfn_progress import NativeProgressScanner, native_output_lines, report_progress
        report_progress(self.progress_callback,'reading',stageId='surface-source')
        if self.stopped.is_set():
            raise SurfaceError('surface-cancelled', 'Native surface start was cancelled.')
        threads = str(self.resources['threads'])
        env = dict(os.environ, Multiwfnpath=str(self.executable.parent), OMP_NUM_THREADS=threads,
                   OPENBLAS_NUM_THREADS=threads, MKL_NUM_THREADS=threads, OMP_STACKSIZE='200M')
        with self.lifecycle:
            if self.stopped.is_set():
                raise SurfaceError('surface-cancelled', 'Native surface start was cancelled.')
            process = subprocess.Popen([str(self.executable), str(self.source)], cwd=self.work, env=env,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self.process = process
            self.job = _windows_owned_job(process, self.resources['memoryBudgetBytes'])
        queue_ = self.queue
        scanner=NativeProgressScanner(self.progress_callback)
        def read():
            with self.log.open('ab') as log:
                for raw in native_output_lines(process.stdout,lambda chunk:scanner.feed(chunk.decode('utf-8', errors='replace'))):
                    log.write(raw); log.flush()
                    line = raw.decode('utf-8', errors='replace').replace('\r', '')
                    progress = re.search(r'Progress:\s*\[[#-]+\]\s*([\d.]+)\s*%', line)
                    if progress:
                        self.progress = float(progress[1])
                    if 'Calculation of grid data took' in line:
                        self.progress = None
                    queue_.put(line)
                queue_.put(None)
        threading.Thread(target=read, daemon=True).start()
        output = self.wait(MAIN_MENU)
        version = re.search(r'Version\s+([^\n]+)', output)
        threads_ = re.search(r'Number of parallel threads:\s*(\d+)', output)
        if not version or not threads_ or int(threads_[1]) != self.resources['threads']:
            self.stop(); raise SurfaceError('surface-backend', 'Native version/effective threads could not be verified.')
        self.backend = dict(name='Multiwfn', version=version[1].strip(), threads=int(threads_[1]))
        # Native recognizes xTB by its content. Keep its valence/EDF convention
        # explicit for generated and external xTB alike; unknown Molden stays unknown.
        from wavefunction_prerequisites import xtb_native_prerequisites
        self.source_prerequisites = xtb_native_prerequisites(inspect_wavefunction(self.source), output) if re.search(r'This file is found to be generated by xtb!',output,re.I) else None
        return output

    def send(self, answers):
        from multiwfn_progress import report_progress
        report_progress(self.progress_callback,'running',stageId='surface-native-command')
        if self.stopped.is_set() or self.process is None or self.process.poll() is not None:
            raise SurfaceError('surface-cancelled', 'The owned native surface process has stopped.')
        payload = '\n'.join(map(str, answers)) + '\n'
        with self.menu_log.open('a', encoding='utf-8') as log:
            log.write(payload)
        self.last_answers = list(map(str, answers)); self.command_cpu = self.cpu_seconds()
        self.record_status('command-sent')
        self.process.stdin.write(payload.encode('utf-8')); self.process.stdin.flush()

    def cpu_seconds(self):
        process = self.process
        if process is None or process.poll() is not None:
            return None
        if os.name == 'nt':
            from ctypes import wintypes
            get_times = ctypes.windll.kernel32.GetProcessTimes
            get_times.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
            get_times.restype = wintypes.BOOL
            creation, exit_, kernel, user = (wintypes.FILETIME() for _ in range(4))
            if get_times(wintypes.HANDLE(int(process._handle)), ctypes.byref(creation), ctypes.byref(exit_), ctypes.byref(kernel), ctypes.byref(user)):
                return (((kernel.dwHighDateTime << 32) + kernel.dwLowDateTime + (user.dwHighDateTime << 32) + user.dwLowDateTime) / 1e7)
        elif Path(f'/proc/{process.pid}/stat').is_file():
            fields = Path(f'/proc/{process.pid}/stat').read_text().rpartition(')')[2].split()
            return (int(fields[11]) + int(fields[12])) / os.sysconf('SC_CLK_TCK')
        return None

    def wait(self, marker):
        # Scientific work has no implicit wall deadline. Prompt/EOF and owner
        # cancellation determine completion; process-stop grace remains bounded.
        output = []; self.last_wait_marker = marker; self.wait_started_at = time.time()
        self.record_status('waiting-for-prompt')
        while True:
            if self.stopped.is_set():
                self.record_status('cancelled')
                raise SurfaceError('surface-cancelled', 'Native surface operation was cancelled; no partial field was published.')
            try:
                line = self.queue.get(timeout=.1)
            except queue.Empty:
                continue
            if line is None:
                self.native_exit_code = self.process.poll() if self.process else self.native_exit_code
                self.record_status('native-exit-before-prompt')
                raise SurfaceError('surface-native-exit', 'Native process ended before the expected prompt. ' + ''.join(output)[-1200:])
            output.append(line)
            if marker in line:
                self.record_status('prompt-received')
                return ''.join(output)

    def stop(self):
        with self.lifecycle:
            self.stopped.set()
            process, job = self.process, self.job
            self.process = None; self.job = None
        MultiwfnSession._terminate(process, job)
        if process is not None and process.poll() is None:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                raise SurfaceError('surface-cleanup', 'The owned native process has not settled; source files remain protected.')
        self.native_exit_code = process.poll() if process else self.native_exit_code
        self.record_status('stopped')


def _stamp_context(stamp):
    return {key: value for key, value in stamp.items() if key not in ('requestId', 'analysisId')}


def _cube_field(cube, field_id, context, function, unit, name, domain):
    # Numeric precision is retained by the original Cube and its revision. The
    # owned canonical writer emits 16 decimal places rather than claiming a
    # second measurement accuracy; pair admission has already checked the grid.
    result = dict(id=field_id, context=context, source=dict(id=field_id, name=name, revision=cube['revision'], kind='generated-cube', producer='multiwfn', comments=cube['comments']),
                  function=function, functionLabel={'electron-density': 'Electron density', 'esp': 'ESP', 'alie': 'ALIE'}[function], valueUnit=unit,
                  definitionEvidence=dict(kind='native-output', description='Multiwfn main-5 native function and exact Cube export.'),
                  grid=cube['grid'], atoms=cube['atoms'], precision=cube['precision'], validDomain=domain,
                  valuesBase64=base64.b64encode(cube['values'].astype('<f8', copy=False).tobytes()).decode('ascii'))
    return result


class SurfaceAnalysisSession:
    def __init__(self, request):
        self.session_id = request['sessionId']; self.source = request['source']; self.context = dict(self.source['context'])
        self.executable = Path(request['executable']).resolve()
        resource_request = request.get('resources') or {}
        self.resources, self.settings = resolve_resources(self.executable, resource_request.get('threads'), resource_request.get('memoryBudgetBytes'))
        if resource_request.get('settingsRevision') is not None and self.resources['settingsRevision'] != resource_request['settingsRevision']:
            raise SurfaceError('surface-resource-changed', 'Multiwfn settings changed after planning.')
        self.open_settings_revision = self.resources['settingsRevision']
        self.root = Path(request['workspacePath']).resolve(); self.root.mkdir(parents=True, exist_ok=True)
        self.native = None; self.closed = False; self.analysis = None; self.fields = {}; self.generations = {}; self.backend = None; self.source_stats = []; self.work_count = 0; self.progress_callback=None
        self.lock = threading.Lock(); self.cancelled = threading.Event(); self.epoch = 0
        if self.source['kind'] == 'wavefunction':
            path = Path(self.source['sourcePath']).resolve()
            self.metadata = inspect_wavefunction(path)
            if self.source.get('sourceRevision') and self.metadata['sourceSha256'] != self.source['sourceRevision']:
                raise SurfaceError('surface-source-changed', 'Wavefunction source revision differs from the registered source.')
            self.source_path = path; self.atom_count = len(self.metadata['atoms'])
            self.source_stats.append((path, path.stat().st_size, path.stat().st_mtime_ns))
        elif self.source['kind'] == 'cube-pair':
            metadata = self.source['shape']['fieldMetadata']
            self.shape = read_scalar_cube(self.source['shape']['path'], self.resources['memoryBudgetBytes'], metadata.get('grid', {}).get('coordinateUnit'))
            if metadata.get('function') != 'electron-density' or metadata.get('valueUnit') not in ('e/bohr^3', 'e/bohr³', 'bohr^-3', 'a.u.'):
                raise SurfaceError('surface-density-unit', 'The shape slot requires a declared atomic-unit electron density; scalar values and isovalue were not converted.')
            self.mapping = None
            if self.source.get('mapping'):
                remaining = self.resources['memoryBudgetBytes'] - self.shape['values'].nbytes - retained_size(self.source)
                self.mapping = read_scalar_cube(self.source['mapping']['path'], remaining, self.source['mapping']['fieldMetadata'].get('grid', {}).get('coordinateUnit'))
                require_cube_pair(self.shape, self.mapping)
            self.atom_count = len(self.shape['atoms']); self.metadata = dict(basisCount=0, sourceBytes=self.shape['bytes'], atoms=self.shape['atoms'])
            for slot in ('shape', 'mapping'):
                if self.source.get(slot):
                    path = Path(self.source[slot]['path']).resolve(); self.source_stats.append((path, path.stat().st_size, path.stat().st_mtime_ns))
                    cube = self.shape if slot == 'shape' else self.mapping
                    revision = self.source[slot]['fieldMetadata'].get('source', {}).get('revision')
                    if revision is not None and revision != cube['revision']:
                        raise SurfaceError('surface-cube-changed', 'The Cube bytes differ from their registered source revision.')
        else:
            raise SurfaceError('surface-source', 'Unsupported surface source kind.')
        if self.atom_count < 1:
            raise SurfaceError('surface-size', 'Numerical surface analysis requires explicit source atoms.')

    def _current(self):
        if self.closed:
            raise SurfaceError('surface-closed', 'Surface source is closed.')
        if self.cancelled.is_set():
            raise SurfaceError('surface-cancelled', 'The surface operation was cancelled; no partial result was published.')
        for path, size, mtime in self.source_stats:
            stat = path.stat()
            if stat.st_size != size or stat.st_mtime_ns != mtime:
                raise SurfaceError('surface-source-changed', 'The registered immutable source changed; open a new surface session.')

    def apply_resources(self, grant):
        """A scientific operation uses this grant, not its earlier open budget."""
        if not isinstance(grant, dict):
            raise SurfaceError('surface-resources', 'A current shared Multiwfn resource grant is required.')
        for key in ('threads', 'memoryBudgetBytes'):
            if type(grant.get(key)) is not int or grant[key] <= 0:
                raise SurfaceError('surface-resources', 'The current resource grant must contain positive integer threads and memory budget.')
        resources, settings = resolve_resources(self.executable, grant['threads'], grant['memoryBudgetBytes'])
        if resources['settingsRevision'] != self.open_settings_revision or (grant.get('settingsRevision') is not None and resources['settingsRevision'] != grant['settingsRevision']):
            raise SurfaceError('surface-resource-changed', 'Multiwfn settings changed after opening or planning this operation; no native process was started.')
        for key in ('sharedReservedBytes', 'configuredMemoryBudgetBytes'):
            if key in grant:
                if type(grant[key]) is not int or grant[key] < 0:
                    raise SurfaceError('surface-resources', 'Invalid shared resource reservation metadata.')
                resources[key] = grant[key]
        self.resources, self.settings = resources, settings

    def _check_stamp(self, stamp, analysis=False):
        self._current()
        if not isinstance(stamp, dict) or not isinstance(stamp.get('requestId'), str) or not isinstance(stamp.get('analysisId'), str) or _stamp_context(stamp) != self.context:
            raise SurfaceError('surface-stamp', 'Surface request source/frame/document identity differs from this session.')
        if analysis and (not self.analysis or stamp['analysisId'] != self.analysis['request']['stamp']['analysisId']):
            raise SurfaceError('surface-analysis-required', 'This request does not belong to a completed surface analysis.')

    def _spawn(self, purpose, settings=None):
        self._current(); self.stop_native()
        self.work_count += 1
        work = Path(tempfile.mkdtemp(prefix=purpose + '-', dir=self.root))
        if self.source['kind'] == 'wavefunction':
            source = work / ('source.molden' if self.metadata['format'] == 'molden' else 'source.fchk')
            shutil.copyfile(self.source_path, source)
        else:
            source = work / 'shape.cub'; write_native_cube(self.shape, source)
            if self.mapping is not None:
                canonical_mapping = dict(self.mapping, grid=self.shape['grid'], atoms=self.shape['atoms'])
                write_native_cube(canonical_mapping, work / 'mapping.cub')
        native = NativeSurfaceProcess(self.executable, source, work, self.resources, self.settings if settings is None else settings)
        native.progress_callback=self.progress_callback
        self.native = native
        try:
            native.start(); self.backend = native.backend; return native
        except Exception:
            native.stop(); self.native = None; raise

    def capabilities(self):
        direct = self.source['kind'] == 'wavefunction'
        mapped = direct or (self.mapping is not None and self.source['shape']['fieldMetadata'].get('validDomain', {}).get('kind') == 'full-grid'
                            and self.source['mapping']['fieldMetadata'].get('validDomain', {}).get('kind') in ('full-grid', 'node-mask'))
        try:
            if not direct:
                require_native_cube_grid(self.shape)
                if self.mapping is not None:
                    require_native_cube_grid(self.mapping)
        except SurfaceError:
            mapped = False
        reason = None if mapped else 'This source lacks a paired mapping Cube with defined coverage and a verified axis-aligned native analysis grid; original Cube data remains available.'
        capabilities = []
        for function in ('esp', 'alie'):
            ready = mapped and (direct or self.source['mapping']['fieldMetadata'].get('function') == function
                                and self.source['mapping']['fieldMetadata'].get('valueUnit') in ('a.u.', 'hartree', 'Eh'))
            capabilities.append(dict(function=function, wavefunctionDirect=direct, cubeInterpolation=not direct and ready,
                atomRegions=ready, fragmentRegions=ready, extrema=ready, distribution=ready, generation=direct, valueUnit='a.u.',
                **({'reason': reason or 'A matching defined mapping field is required for this function.'} if not ready else {})))
        return dict(sessionId=self.session_id, context=self.context, capabilities=capabilities,
                    resources=self.resources, retainedMemoryBytes=self.retained_memory_bytes())

    def retained_memory_bytes(self):
        analysis = {key: value for key, value in (self.analysis or {}).items() if key != 'native'}
        return retained_size([self.source, self.metadata, self.fields, self.generations, analysis,
                              getattr(self, 'shape', None), getattr(self, 'mapping', None), self.resources, self.context])

    def _setup(self, native, request, vertex_cache=None):
        function = request['function']; isovalue = request['isovalue']; grid = request['quantitativeGrid']
        if function not in ('esp', 'alie') or not isinstance(isovalue, (float, int)) or isinstance(isovalue, bool) or not math.isfinite(isovalue) or isovalue <= 0:
            raise SurfaceError('surface-parameters', 'Select ESP/ALIE and a positive finite atomic-density isovalue.')
        native.send(['12']); output = native.wait(SETUP_END)
        if self.source['kind'] == 'cube-pair':
            require_native_cube_grid(self.shape)
            if self.source['shape']['fieldMetadata'].get('validDomain', {}).get('kind') != 'full-grid':
                raise SurfaceError('surface-domain', 'The shape density requires an explicit complete grid domain.')
            if self.mapping is None:
                raise SurfaceError('surface-mapping-required', 'A mapping Cube is required; no wavefunction or mapping values were invented.')
            meta = self.source['mapping']['fieldMetadata']
            if meta.get('function') != function or meta.get('valueUnit') not in ('a.u.', 'hartree', 'Eh'):
                raise SurfaceError('surface-mapping-unit', 'This native interpolation profile requires a matching ESP/ALIE Cube in atomic units.')
            domain = meta.get('validDomain', {})
            if domain.get('kind') not in ('full-grid', 'node-mask'):
                raise SurfaceError('surface-domain', 'Mapping field coverage is unknown; no complete ESP/ALIE field was assumed.')
            if any('restricted-domain' in comment.lower() for comment in self.mapping['comments']) and domain['kind'] == 'full-grid':
                raise SurfaceError('surface-domain', 'A known restricted Cube cannot be relabelled as a complete field.')
            if domain['kind'] == 'node-mask':
                bound = domain.get('restrictedTo') or {}
                if bound.get('isovalue') != isovalue or (bound.get('shapeSourceRevision') != self.shape['revision'] if bound.get('shapeSourceRevision') is not None else bound.get('shapeFieldId') != self.source['shape']['fieldMetadata'].get('id')):
                    raise SurfaceError('surface-domain', 'The restricted mapping field is bound to another density source or isovalue.')
                mask = domain_node_mask(domain, self.mapping['values'].size)
                coverage = crossing_domain_coverage(self.shape['values'], self.shape['grid']['dimensions'], isovalue, mask)
                if coverage['invalidCrossingCells']:
                    raise SurfaceError('surface-domain', 'The requested surface has interpolation cells without all eight valid mapping neighbours; no zero-filled values were used.')
            native.send(['1', '11', isovalue]); output += native.wait(SETUP_END)
        elif isovalue != .001:
            native.send(['1', '1', isovalue]); output += native.wait(SETUP_END)
        native.send(['2', '1' if function == 'esp' else '2']); output += native.wait(SETUP_END)
        if self.source['kind'] == 'wavefunction' and grid['mode'] == 'spacing':
            spacing = grid.get('spacingBohr')
            if isinstance(spacing, bool) or not isinstance(spacing, (int, float)) or not math.isfinite(spacing) or spacing <= 0:
                raise SurfaceError('surface-spacing', 'A positive finite quantitative spacing is required.')
            native.send(['3', spacing]); output += native.wait(SETUP_END)
        elif grid['mode'] != 'native-default':
            raise SurfaceError('surface-spacing', 'External Cube analysis uses its existing grid; it is never resampled.')
        if vertex_cache or self.source['kind'] == 'cube-pair':
            native.send(['5', '1']); output += native.wait(SETUP_END)
        spacing = re.findall(r'Spacing of grid points for generating molecular surface:\s*(' + NUMBER + ')', output)
        actual = number(spacing[-1]) if spacing and self.source['kind'] == 'wavefunction' else None
        return output, actual

    def _point_handoff(self, native, request, vertex_cache=None):
        """Use the same native mesh; replace only its external mapped-value input."""
        self._check_stamp(request['stamp'])
        point_path = native.work / 'surfptpos.txt'
        points = read_surface_vertex_file(point_path, self.resources['memoryBudgetBytes'], current=self._current)
        cached = None
        if vertex_cache:
            if not self.analysis or Path(vertex_cache).resolve() != self.analysis['vtx'].resolve():
                raise SurfaceError('surface-cache', 'Point values belong to another completed analysis.')
            cached = read_surface_vertex_file(vertex_cache, self.resources['memoryBudgetBytes'], True, self._current)
            if cached['revision'] != self.analysis['vtxRevision'] or cached['count'] != points['count'] or cached['tokens'] != points['tokens']:
                raise SurfaceError('surface-cache', 'Cached values no longer match the current native point count, exact coordinate tokens and order.')
        domain = None; mask = None; sample = None
        if self.source['kind'] == 'cube-pair':
            domain = self.source['mapping']['fieldMetadata']['validDomain']
            if domain.get('kind') not in ('full-grid', 'node-mask'):
                raise SurfaceError('surface-domain', 'Mapping validity is unknown; no external vertex value was assumed.')
            if domain['kind'] == 'node-mask':
                mask = domain_node_mask(domain, self.mapping['values'].size)
            # Match the exact canonical grid already supplied to this native
            # instance. This is only the existing spatial-unit serialization;
            # scalar values, source Cubes and requested positions are unchanged.
            factor = 1 if self.shape['grid']['coordinateUnit'] == 'bohr' else 1 / BOHR_TO_ANGSTROM
            grid = dict(self.shape['grid'], coordinateUnit='bohr', origin=[v*factor for v in self.shape['grid']['origin']],
                        axes=[[v*factor for v in row] for row in self.shape['grid']['axes']])
            sample = create_surface_mapping_sampler(dict(self.mapping, grid=grid), mask)
        if cached is None and sample is None:
            raise SurfaceError('surface-cache', 'Wavefunction point replay requires its original completed native values.')
        values = []
        for i, position in enumerate(points['positions']):
            if i % 64 == 0:
                self._current()
            value = sample(position) if sample else cached['values'][i]
            if cached is not None:
                if sample and value != cached['values'][i]:
                    raise SurfaceError('surface-cache', 'Cached mapped values differ from the same source grid and ordered points.')
                value = cached['values'][i]
            values.append(value)
        self._current()
        target = native.work / 'mapped-values.txt'
        with target.open('w', encoding='utf-8', newline='\n') as output:
            output.write(points['header'] + '\n')
            for i, (line, value) in enumerate(zip(points['rows'], values)):
                if i % 64 == 0:
                    self._current()
                output.write(line + f' {value:.17e}\n')
        self._current()
        if hashlib.sha256(point_path.read_bytes()).hexdigest() != points['revision']:
            raise SurfaceError('surface-point-file', 'Native point file changed while mapped values were prepared.')
        if cached and hashlib.sha256(Path(vertex_cache).read_bytes()).hexdigest() != cached['revision']:
            raise SurfaceError('surface-cache', 'Cached point values changed during native handoff preparation.')
        # Read-back checks exact point order/XYZ and all finite scalar rows before
        # giving a path to the waiting process. Genuine zero values remain rows.
        prepared = read_surface_vertex_file(target, self.resources['memoryBudgetBytes'], True, self._current)
        if prepared['tokens'] != points['tokens'] or prepared['count'] != points['count'] or prepared['values'] != values:
            raise SurfaceError('surface-point-file', 'Prepared external values do not preserve every native point.')
        parameters = dict(mappedValueRoute='external-vertex-values-trilinear' if sample else 'external-vertex-values-cache',
            interpolationDefinition='floor-fraction-eight-weights' if sample else 'original-native-cached-values',
            pointCoordinateUnit='bohr', pointCoordinateDecimals=7, pointCount=points['count'], validPointCount=len(values),
            nativePointOrderPreserved=True, nativeGeometryUnchanged=True, pointFileRevision=points['revision'], mappedValuesRevision=prepared['revision'])
        artifacts = [('surface-vertex-positions', point_path.name), ('external-mapped-values', target.name)]
        context_record = dict(stamp=request['stamp'], parameters=parameters)
        if domain is not None:
            domain_path = native.work / 'mapping-domain.json'
            domain_path.write_text(json.dumps(domain, allow_nan=False, sort_keys=True), encoding='utf-8')
            parameters.update(shapeCubeRevision=self.shape['revision'], mappingCubeRevision=self.mapping['revision'],
                              mappingDomainRevision=hashlib.sha256(domain_path.read_bytes()).hexdigest())
            artifacts.extend([('mapping-valid-domain', domain_path.name), ('native-shape-cube', 'shape.cub'), ('native-mapping-cube', 'mapping.cub')])
        if cached:
            context_record['cacheRevision'] = cached['revision']
        context_path = native.work / 'point-handoff.json'
        context_path.write_text(json.dumps(context_record, allow_nan=False, sort_keys=True), encoding='utf-8')
        artifacts.append(('point-handoff-context', context_path.name))
        native.point_parameters = parameters; native.point_artifacts = artifacts
        self._current()
        return target

    def _provenance(self, native, parameters, roles=()):
        native.artifact_sequence = getattr(native, 'artifact_sequence', 0) + 1
        frozen_log = f'native-output-{native.artifact_sequence}.txt'
        frozen_menu = f'menu-input-{native.artifact_sequence}.txt'
        shutil.copyfile(native.log, native.work / frozen_log)
        shutil.copyfile(native.menu_log, native.work / frozen_menu)
        artifacts = []
        for role, name in [('native-output', frozen_log), ('native-menu', frozen_menu), ('effective-settings', 'settings.ini'), *roles, *getattr(native, 'point_artifacts', [])]:
            path = native.work / name
            if path.is_file():
                artifacts.append(dict(role=role, name=name, revision=hashlib.sha256(path.read_bytes()).hexdigest()))
        return dict(backend=dict(name='Multiwfn', version=native.backend['version']), sourceIds=[self.context['sourceId']],
                    parameters=dict(threads=self.resources['threads'], memoryBudgetBytes=self.resources['memoryBudgetBytes'], settingsRevision=self.resources['settingsRevision'], **(getattr(native, 'source_prerequisites', None) or {}), **getattr(native, 'point_parameters', {}), **parameters), rawArtifacts=artifacts,
                    notices=['Quantitative values and native display Cube sampling are independent.'])

    def _run_analysis(self, request, vertex_cache=None):
        native = self._spawn('analysis')
        setup, spacing = self._setup(native, request, vertex_cache)
        native.send(['0'])
        if vertex_cache or self.source['kind'] == 'cube-pair':
            partial = native.wait('Now input the path of the file containing calculated mapped function values')
            prepared = self._point_handoff(native, request, vertex_cache)
            native.send([prepared.name])
            output = partial + native.wait(POST_END)
        else:
            output = native.wait(POST_END)
        if 'Surface analysis finished!' not in output:
            raise SurfaceError('surface-native', 'Native analysis did not report successful completion.')
        (native.work / 'analysis-output.txt').write_text(output, encoding='utf-8')
        native.send(['1']); native.wait(POST_END)
        extrema = parse_extrema((native.work / 'surfanalysis.txt').read_text(encoding='utf-8', errors='replace'), request['function'])
        native.send(['7']); native.wait(POST_END)
        if not (native.work / 'vtx.txt').is_file():
            raise SurfaceError('surface-vertices', 'Native analysis did not export complete surface vertices.')
        if vertex_cache or self.source['kind'] == 'cube-pair':
            points = read_surface_vertex_file(native.work / 'surfptpos.txt', self.resources['memoryBudgetBytes'], current=self._current)
            exported = read_surface_vertex_file(native.work / 'vtx.txt', self.resources['memoryBudgetBytes'], True, self._current)
            if exported['count'] != points['count'] or exported['tokens'] != points['tokens']:
                raise SurfaceError('surface-point-file', 'Native output no longer preserves the handoff point count and ordered coordinates.')
        native.send(['-2']); native.wait(POST_END)
        molecule = dict(id='molecule', kind='molecule', label='Whole molecule', atomIndices=[])
        region = region_result(molecule, output, extrema)
        if region['area'] is None or region['area'] <= 0:
            raise SurfaceError('surface-area', 'Native analysis has no positive complete surface area.')
        return native, setup, output, spacing, region, extrema

    def analyze(self, request):
        self._check_stamp(request['stamp'])
        native, setup, output, spacing, molecule, extrema = self._run_analysis(request)
        regions = [molecule]
        for selection in request.get('regions', []):
            if selection['kind'] == 'molecule':
                molecule['selection'] = selection
                for extremum in extrema:
                    extremum['regionId'] = selection['id']
                continue
            regions.append(self._region(selection))
        # Option 9 uses the surface already held by main-12. Prepare its native
        # area statistics before publishing this one explicit analysis task;
        # merely viewing the returned chart never needs a native operation.
        bounds = self._distribution_bounds(native)
        for region in regions:
            region['distribution'] = self._native_distribution(
                dict(stamp=request['stamp'], regionId=region['selection']['id'], **bounds), region['selection'], molecule['area'])
        grid = dict(request['quantitativeGrid'])
        if self.source['kind'] == 'wavefunction' and spacing is not None:
            grid['actualSpacingBohr'] = spacing
        result = dict(stamp=request['stamp'], route='wavefunction-direct' if self.source['kind'] == 'wavefunction' else 'cube-interpolation',
                      function=request['function'], isovalue=request['isovalue'], quantitativeGrid=grid, regions=regions, extrema=extrema,
                      provenance=self._provenance(native, dict(function=request['function'], isovalue=request['isovalue'],
                                                  **({'actualSpacingBohr': spacing} if spacing is not None else {}), route='wavefunction-direct' if self.source['kind'] == 'wavefunction' else 'cube-interpolation',
                                                  areaDistributionBins=bounds['binCount'], areaDistributionLower=bounds['lower'], areaDistributionUpper=bounds['upper'],
                                                  areaDistributionUnit=bounds['valueUnit'], areaDistributionRange='mapped-vertex-extrema-padded-for-native-four-decimal-intervals'),
                                                  [('analysis-metrics', 'analysis-output.txt'), ('surface-extrema', 'surfanalysis.txt'), ('surface-vertices', 'vtx.txt'), ('quantitative-density', 'surf.cub'), *getattr(native, 'region_artifacts', []), *getattr(native, 'distribution_artifacts', [])]))
        self._current()
        cache = native.work / ('mapped-values.txt' if self.source['kind'] == 'cube-pair' else 'vtx.txt')
        self.analysis = dict(request=json.loads(json.dumps(request)), result=result, native=native, vtx=cache,
                             vtxRevision=hashlib.sha256(cache.read_bytes()).hexdigest(), wholeArea=molecule['area'])
        return result

    def _ensure_analysis(self):
        if self.analysis is None:
            raise SurfaceError('surface-analysis-required', 'Run an explicit surface analysis first.')
        if self.native is not None and self.native is self.analysis['native'] and self.native.process and self.native.process.poll() is None:
            return
        # Exact native surface setup is replayed with its cached vertex values.
        # This restores native region/area operations without evaluating ESP/ALIE.
        native, _, output, _, molecule, _ = self._run_analysis(self.analysis['request'], self.analysis['vtx'])
        if abs(molecule['area'] - self.analysis['wholeArea']) > 1e-5:
            native.stop(); raise SurfaceError('surface-cache', 'Restored native vertex-cache surface no longer matches the analyzed surface.')
        if re.search(r'Calculating (?:electrostatic potential|average local ionization)', output, re.I):
            native.stop(); raise SurfaceError('surface-cache', 'Native cache restoration unexpectedly recomputed the mapping function.')
        self.analysis['native'] = native

    def _region(self, selection):
        indices = selected_atoms(selection, self.atom_count)
        native = self.native
        native.send(['12']); native.wait('Input atomic indices to define the fragment')
        native.send([indices]); output = native.wait('If outputting the surface facets')
        native.send(['n']); native.wait(POST_END)
        native.region_artifacts = getattr(native, 'region_artifacts', [])
        name = f'region-{len(native.region_artifacts) + 1}.txt'
        (native.work / name).write_text(output, encoding='utf-8')
        native.region_artifacts.append(('region-metrics:' + selection['id'], name))
        return region_result(selection, output)

    def region(self, request):
        self._check_stamp(request['stamp'], True); self._ensure_analysis()
        selection = request['selection']
        if selection['kind'] == 'molecule':
            region = json.loads(json.dumps(self.analysis['result']['regions'][0])); region['selection'] = selection
        else:
            region = self._region(selection)
        region['distribution'] = self._native_distribution(
            dict(stamp=request['stamp'], regionId=selection['id'], **self._distribution_bounds(self.native)), selection, self.analysis['wholeArea'])
        self._current()
        regions = self.analysis['result']['regions']; regions[:] = [value for value in regions if value['selection']['id'] != selection['id']] + [region]
        return dict(stamp=request['stamp'], region=region)

    def distribution(self, request):
        self._check_stamp(request['stamp'], True); self._ensure_analysis()
        region = next((value for value in self.analysis['result']['regions'] if value['selection']['id'] == request['regionId']), None)
        if region is None:
            raise SurfaceError('surface-region', 'Analyze the selected region before requesting its distribution.')
        return self._native_distribution(request, region['selection'], self.analysis['wholeArea'])

    def _distribution_bounds(self, native):
        vertices = read_surface_vertex_file(native.work / 'vtx.txt', self.resources['memoryBudgetBytes'], True, self._current)
        lower, upper = min(vertices['values']), max(vertices['values'])
        # Native area-table boundaries have four printed decimals. Include
        # every mapped vertex (also a constant/zero field), while keeping all
        # 50 native intervals distinguishable at that source precision.
        padding = max((upper - lower) * .01, .0025)
        return dict(lower=lower-padding, upper=upper+padding, binCount=50, valueUnit='a.u.')

    def _native_distribution(self, request, selection, whole_area):
        self._current()
        lower, upper, count = request['lower'], request['upper'], request['binCount']
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in (lower, upper)) or lower >= upper or isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= 10000:
            raise SurfaceError('surface-distribution', 'Distribution requires a finite increasing range and 1–10000 integer bins.')
        unit = {'a.u.': 1, 'hartree': 1, 'Eh': 1, 'eV': 2, 'kcal/mol': 3}.get(request['valueUnit'])
        if unit is None:
            raise SurfaceError('surface-distribution-unit', 'Select a verified native distribution unit.')
        indices = selected_atoms(selection, self.atom_count)
        self.native.send(['9', indices, f'{lower},{upper}', count, unit]); output = self.native.wait(POST_END)
        self.native.distribution_sequence = getattr(self.native, 'distribution_sequence', 0) + 1
        name = f'distribution-{self.native.distribution_sequence}.txt'
        (self.native.work / name).write_text(output, encoding='utf-8')
        self.native.distribution_artifacts = getattr(self.native, 'distribution_artifacts', [])
        self.native.distribution_artifacts.append(('area-distribution:' + request['regionId'], name))
        result = parse_distribution(output, request, whole_area); self._current()
        return result

    def _export_main5(self, native, function, grid_answers):
        if grid_answers[0] == 'target-points':
            native.send(['5', function])
            prompt = native.wait('100 Load a set of points from external file')
            extension = re.search(r'current:\s*(' + NUMBER + r')\s*Bohr', prompt)
            if extension is None:
                raise SurfaceError('surface-grid', 'Actual native grid boundary is unavailable; no estimated boundary was substituted.')
            dimensions = target_grid_dimensions([a['positionBohr'] for a in self.metadata['atoms']], number(extension[1]), int(grid_answers[1]))
            native.target_grid_plan = dict(targetPoints=int(grid_answers[1]), actualExtensionBohr=number(extension[1]), dimensions=dimensions)
            native.send(['4']); native.wait('or input grid spacing (Bohr)')
            native.send([','.join(map(str, dimensions))])
        else:
            native.send(['5', function, *grid_answers])
        output = native.wait(GRID_END)
        native.send(['2']); exported = native.wait(GRID_END)
        native.send(['0']); native.wait(MAIN_MENU)
        name = {1: 'density.cub', 12: 'totesp.cub', 18: 'ALIE.cub'}[function]
        match = re.search(r'Grid data has been exported to (\S+\.cub)', exported, re.I)
        if match:
            name = match[1]
        path = native.work / name
        if path.parent != native.work or not path.is_file():
            raise SurfaceError('surface-field-output', 'The requested native Cube was not exported inside its owned workspace.')
        return path, output

    def generate(self, request):
        self._check_stamp(request['stamp'], True)
        if self.source['kind'] != 'wavefunction':
            raise SurfaceError('surface-source-grid', 'External Cubes already define their grid; use the existing fields without resampling or relabelling their quality.')
        if request['function'] != self.analysis['request']['function'] or request['isovalue'] != self.analysis['request']['isovalue']:
            raise SurfaceError('surface-analysis-required', 'Analyze this function/isovalue before generating its display fields.')
        quality = request['quality']; mode = quality.get('mode')
        if mode == 'target-points' and set(quality) == {'mode', 'targetPoints'} and quality.get('targetPoints') in (32768, 4096000):
            grid_answers = ['target-points', str(quality['targetPoints'])]
        elif mode in ('low', 'medium', 'high'):
            grid_answers = [{'low': '1', 'medium': '2', 'high': '3'}[mode]]
        elif mode == 'spacing':
            value = quality.get('spacingBohr')
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise SurfaceError('surface-grid', 'Custom Cube spacing must be positive and finite.')
            grid_answers = ['4', np.format_float_positional(float(value), unique=True, trim='k')]
        elif mode == 'dimensions':
            dimensions = quality.get('dimensions')
            if not isinstance(dimensions, list) or len(dimensions) != 3 or any(isinstance(value, bool) or not isinstance(value, int) or value < 2 for value in dimensions):
                raise SurfaceError('surface-grid', 'Custom Cube dimensions require three integer counts of at least two.')
            grid_answers = ['4', ','.join(map(str, dimensions))]
        else:
            raise SurfaceError('surface-grid', 'Unknown Cube quality; no lower quality was substituted.')
        settings = self.settings; layers = 0
        if request['function'] == 'esp':
            values = _values(settings, 'ESPrhonlay')
            if len(values) > 1 or values and not re.fullmatch(rb'\d+', values[0]):
                raise SurfaceError('surface-domain', 'ESPrhonlay has an ambiguous effective value.')
            layers = int(values[0]) if values else 1
            if not 1 <= layers <= 8:
                raise SurfaceError('surface-domain', 'The configured ESPrhonlay is outside this bounded verified mask profile; it was not changed.')
            settings = _override(settings, 'ESPrhoiso', request['isovalue'])
        native = self._spawn('fields', settings)
        try:
            first_path, _ = self._export_main5(native, 1, grid_answers)
            first = read_scalar_cube(first_path, self.resources['memoryBudgetBytes'])
            if mode == 'target-points' and first['grid']['dimensions'] != native.target_grid_plan['dimensions']:
                raise SurfaceError('surface-grid', 'Actual native grid differs from the planned target allocation; no substitute grid was published.')
            # Lock the serialized complete native grid for both actual density
            # evaluation and mapping. Never choose two independent medium grids.
            template = native.work / 'grid-template.cub'; shutil.copyfile(first_path, template)
            shape_path, _ = self._export_main5(native, 1, ['8', template.name])
            shape = read_scalar_cube(shape_path, self.resources['memoryBudgetBytes'])
            mapping_path, mapping_output = self._export_main5(native, 12 if request['function'] == 'esp' else 18, ['8', shape_path.name])
            mapping = read_scalar_cube(mapping_path, self.resources['memoryBudgetBytes']); require_cube_pair(shape, mapping)
            context = _stamp_context(request['stamp'])
            prefix = request['stamp']['analysisId'] + ':' + request['stamp']['requestId']
            shape_id, mapping_id = prefix + ':density', prefix + ':' + request['function']
            shape_final = native.work / 'density-surface.cub'
            write_native_cube(shape, shape_final, ['Ester Studio electron density [e/bohr^3]; Multiwfn native grid', 'Complete density grid; no scalar values were resampled.'])
            shape = read_scalar_cube(shape_final, self.resources['memoryBudgetBytes'])
            domain = dict(kind='full-grid', evidence='Every node was evaluated by native main-5 ALIE on the locked density grid.')
            domain_parameters = {}
            if request['function'] == 'esp':
                match = re.search(r'Number of grids to calculate ESP:\s*(\d+)', mapping_output)
                if not match or f"{request['isovalue']:.6f}" not in mapping_output or 'ESP will be calculated only' not in mapping_output:
                    raise SurfaceError('surface-domain', 'Native ESPrhoiso execution/count evidence is missing.')
                mask = esp_direct_node_mask(shape['values'], shape['grid']['dimensions'], request['isovalue'], layers)
                native_count = int(match[1])
                if int(mask.sum()) != native_count:
                    raise SurfaceError('surface-domain', 'Density-derived direct node mask disagrees with the actual native ESP evaluation count; no restricted field was published.')
                coverage = crossing_domain_coverage(shape['values'], shape['grid']['dimensions'], request['isovalue'], mask)
                if coverage['invalidCrossingCells']:
                    raise SurfaceError('surface-domain', 'The generated surface lacks valid direct ESP data at every interpolation neighbour; no partial colored field was published.')
                domain = dict(kind='node-mask', maskBase64=base64.b64encode(mask.tobytes()).decode('ascii'),
                              evidence='Actual native ESPrhoiso evaluation count matches the density-derived surrounding-node predicate; copied neighbours and zero fill are excluded.',
                              restrictedTo=dict(shapeFieldId=shape_id, shapeSourceRevision=shape['revision'], isovalue=request['isovalue']))
                domain_parameters = dict(ESPrhoiso=request['isovalue'], ESPrhonlay=layers, directlyEvaluatedNodes=native_count, validatedMaskNodes=int(mask.sum()), copiedNeighboursAreNotDirect=True, **coverage)
            mapping_final = native.work / (request['function'] + '-surface.cub')
            title = f"Ester Studio {request['function'].upper()} [a.u.]; " + ('restricted-domain; requires bound domain metadata' if request['function'] == 'esp' else 'full-grid')
            write_native_cube(mapping, mapping_final, [title, 'Multiwfn native scalar field; grid locked to density; no fitted charges or FPA.'])
            mapping = read_scalar_cube(mapping_final, self.resources['memoryBudgetBytes'])
            shape_field = _cube_field(shape, shape_id, context, 'electron-density', 'e/bohr^3', shape_final.name, dict(kind='full-grid', evidence='Every density node was evaluated by native main-5.'))
            mapping_field = _cube_field(mapping, mapping_id, context, request['function'], 'a.u.', mapping_final.name, domain)
            provenance = self._provenance(native, dict(function=request['function'], isovalue=request['isovalue'], cubeQuality=mode,
                                         actualDimensions=shape['grid']['dimensions'], **(dict(targetGridPointCount=native.target_grid_plan['targetPoints'], nativeGridExtensionBohr=native.target_grid_plan['actualExtensionBohr']) if hasattr(native, 'target_grid_plan') else {}), lockedCompleteGrid=True, **domain_parameters),
                                         [('density-cube', shape_final.name), ('mapping-cube', mapping_final.name)])
            result = dict(stamp=request['stamp'], quality=quality, pair=dict(shape=shape_field, mapping=mapping_field, isovalue=request['isovalue']), provenance=provenance)
            self._current()
            # The renderer receives complete arrays, but the export index keeps
            # only disk identity. Do not retain another base64 grid/mask copy.
            for field in (shape_field, mapping_field):
                if field['validDomain']['kind'] != 'full-grid':
                    sidecar = dict(schema='sciyue-surface-domain/v1', sourceRevision=field['source']['revision'], validDomain=field['validDomain'], context=context,
                                   parameters=provenance['parameters'], cubeName=field['source']['name'])
                    (native.work / (field['source']['name'] + '.domain.json')).write_text(json.dumps(sidecar, allow_nan=False, indent=2), encoding='utf-8')
            for field, path in ((shape_field, shape_final), (mapping_field, mapping_final)):
                descriptor = {key: value for key, value in field.items() if key != 'valuesBase64'}
                descriptor['validDomain'] = {key: value for key, value in field['validDomain'].items() if key not in ('mask', 'maskBase64')}
                self.fields[field['id']] = dict(path=str(path), revision=field['source']['revision'], restricted=field['validDomain']['kind'] != 'full-grid', stamp=request['stamp'], descriptor=descriptor)
                if self.fields[field['id']]['restricted']:
                    self.fields[field['id']]['domainRevision'] = hashlib.sha256(Path(str(path) + '.domain.json').read_bytes()).hexdigest()
            self.generations[request['stamp']['requestId']] = dict(analysisId=request['stamp']['analysisId'], quality=quality,
                shapeId=shape_id, mappingId=mapping_id, isovalue=request['isovalue'], provenance=provenance)
            return result
        finally:
            native.stop()
            if self.native is native:
                self.native = None

    def restore_fields(self, request):
        """Read only completed session-owned artifacts; never spawn a backend."""
        self._check_stamp(request['stamp'])
        saved = self.generations.get(request.get('generationId'))
        if saved is None or saved['analysisId'] != request['stamp']['analysisId']:
            raise SurfaceError('surface-field-missing', 'This generation is not a completed field pair owned by this analysis.')
        work = Path(self.fields[saved['shapeId']]['path']).parent
        for artifact in saved['provenance']['rawArtifacts']:
            raw = work / artifact['name']
            if raw.parent != work or hashlib.sha256(raw.read_bytes()).hexdigest() != artifact['revision']:
                raise SurfaceError('surface-artifact-changed', 'The generation native artifact identity changed; cached fields were not restored.')
        pair = dict(isovalue=saved['isovalue']); cubes = {}
        for slot, key in (('shape', 'shapeId'), ('mapping', 'mappingId')):
            item = self.fields[saved[key]]; cube = read_scalar_cube(item['path'], self.resources['memoryBudgetBytes'])
            if cube['revision'] != item['revision']:
                raise SurfaceError('surface-field-changed', 'The completed Cube bytes changed; cached values were not restored.')
            cubes[slot] = cube
            field = dict(item['descriptor'])
            if item['restricted']:
                sidecar_bytes = Path(item['path'] + '.domain.json').read_bytes()
                if hashlib.sha256(sidecar_bytes).hexdigest() != item['domainRevision']:
                    raise SurfaceError('surface-domain', 'Cached bound domain metadata changed; fields were not restored.')
                sidecar = json.loads(sidecar_bytes.decode('utf-8'))
                if sidecar.get('sourceRevision') != cube['revision']:
                    raise SurfaceError('surface-domain', 'Cached Cube domain identity no longer matches its scalar field.')
                field['validDomain'] = sidecar['validDomain']
                domain_node_mask(field['validDomain'], cube['values'].size)
            field['valuesBase64'] = base64.b64encode(cube['values'].astype('<f8', copy=False).tobytes()).decode('ascii')
            pair[slot] = field
        require_cube_pair(cubes['shape'], cubes['mapping'])
        domain = pair['mapping']['validDomain']
        if domain['kind'] == 'node-mask' and domain.get('restrictedTo', {}).get('shapeSourceRevision') != pair['shape']['source']['revision']:
            raise SurfaceError('surface-domain', 'Cached restricted field is bound to another shape Cube.')
        self._current()
        return dict(stamp=request['stamp'], quality=saved['quality'], pair=pair, provenance=saved['provenance'])

    def export_cube(self, request):
        self._check_stamp(request['stamp'])
        field_id = request['fieldId']
        if field_id in self.fields:
            item = self.fields[field_id]
            if request['stamp']['analysisId'] != item['stamp']['analysisId']:
                raise SurfaceError('surface-field-stamp', 'The requested field belongs to another analysis.')
            path = Path(item['path'])
            result = dict(name=path.name, text=path.read_bytes().decode('utf-8'))
            if hashlib.sha256(result['text'].encode('utf-8')).hexdigest() != item['revision']:
                raise SurfaceError('surface-field-changed', 'The generated Cube identity changed before export.')
            if item['restricted']:
                sidecar = path.with_name(path.name + '.domain.json')
                raw_domain = sidecar.read_bytes()
                if hashlib.sha256(raw_domain).hexdigest() != item['domainRevision']:
                    raise SurfaceError('surface-domain', 'The generated Cube domain identity changed before export.')
                result['domain'] = dict(name=path.name + '.sciyue-domain.json', text=raw_domain.decode('utf-8'))
            return result
        if self.source['kind'] == 'cube-pair':
            for slot in ('shape', 'mapping'):
                if self.source.get(slot) and self.source[slot]['fieldMetadata'].get('id') == field_id:
                    entry = self.source[slot]; path = Path(entry['path']); metadata = entry['fieldMetadata']
                    text = path.read_bytes().decode('utf-8'); domain = metadata.get('validDomain', dict(kind='unknown', reason='No coverage evidence.'))
                    if domain['kind'] == 'node-mask' and 'restricted-domain' not in text.splitlines()[0].lower():
                        rows = text.splitlines(keepends=True)
                        rows[0] = 'Ester Studio restricted-domain scalar field; requires bound domain metadata\n'
                        text = ''.join(rows)
                    result = dict(name=metadata.get('source', {}).get('name', path.name), text=text)
                    if domain['kind'] != 'full-grid':
                        result['domain'] = dict(name=result['name'] + '.sciyue-domain.json', text=json.dumps(dict(schema='sciyue-surface-domain/v1',
                            sourceRevision=hashlib.sha256(text.encode('utf-8')).hexdigest(), validDomain=domain, context=self.context), allow_nan=False))
                    return result
        raise SurfaceError('surface-field-missing', 'Only an existing completed or imported Cube may be exported; no calculation was started.')

    def evidence(self):
        files = []
        for work in self.root.iterdir():
            if not work.is_dir() or work.is_symlink():
                continue
            for path in work.iterdir():
                if path.is_file() and not path.is_symlink():
                    files.append(dict(path=str(path), name=path.name, bytes=path.stat().st_size))
        native = self.native
        process = native.process if native else None
        cpu = native.cpu_seconds() if native else None
        return dict(sessionId=self.session_id, context=self.context, resources=self.resources, backend=self.backend, artifacts=files,
                    nativeProcessId=process.pid if process and process.poll() is None else None,
                    nativeOutputPath=str(native.log) if native and process and process.poll() is None else None,
                    nativeProgress=native.progress if native and process and process.poll() is None else None,
                    nativeLastAnswers=native.last_answers if native and process and process.poll() is None else None,
                    nativePhase=native.phase if native else None,
                    nativeLastWaitMarker=native.last_wait_marker if native else None,
                    nativeWaitStartedAt=native.wait_started_at if native else None,
                    nativeExitCode=native.native_exit_code if native else None,
                    nativeCpuSeconds=cpu, nativeCommandCpuSeconds=native.command_cpu if native else None,
                    activeNativeCount=1 if process and process.poll() is None else 0)

    def stop_native(self):
        native = self.native; self.native = None
        if native is not None:
            native.stop()

    def cancel(self):
        self.epoch += 1; self.cancelled.set(); self.stop_native()

    def close(self):
        self.closed = True; self.cancel()

