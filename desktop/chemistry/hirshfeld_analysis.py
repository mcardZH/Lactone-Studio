"""Pure admission of native Hirshfeld data; no native execution or density model.

The existing ESP density-isosurface adapter is deliberately not repurposed here.
Vertices are fingerprint samples, never surface-area quadrature weights or a
triangle mesh. Rendering requires a separately validated native weight field or
native connectivity from the same analysis.
"""
from __future__ import annotations

import copy
import math
import re

import numpy as np

from surface_analysis import SurfaceError, NUMBER, number, half_last_digit


class HirshfeldError(SurfaceError):
    pass


def require(condition, code, message):
    if not condition:
        raise HirshfeldError('hirshfeld-' + code, message)


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def validate_cluster_geometry(source):
    """Immutable complete source geometry, before an analysis target is chosen."""
    require(isinstance(source, dict) and source.get('kind') == 'finite-cluster'
            and source.get('coordinateUnit') == 'angstrom'
            and source.get('completeFiniteCluster') is True, 'source',
            'An explicitly prepared complete finite cluster in Angstrom is required; no CIF neighbourhood was generated.')
    for key in ('sourceId', 'sourceRevision'):
        require(isinstance(source.get(key), str) and 0 < len(source[key]) <= 512, 'source', 'The immutable cluster identity is missing.')
    atoms = source.get('atoms')
    require(isinstance(atoms, list) and 2 <= len(atoms), 'source', 'A finite cluster requires at least two explicit source atoms.')
    ids = set()
    for index, atom in enumerate(atoms, 1):
        require(isinstance(atom, dict) and atom.get('sourceIndex') == index and type(atom.get('sourceIndex')) is int,
                'source', 'Cluster atom ordinals must be contiguous, one-based source indices.')
        identity = atom.get('stableId')
        require(isinstance(identity, str) and 0 < len(identity) <= 512 and identity not in ids,
                'source', 'Cluster atom stable identities must be nonempty and unique.')
        ids.add(identity)
        require(isinstance(atom.get('element'), str) and re.fullmatch(r'[A-Z][a-z]?', atom['element']),
                'source', 'Each cluster atom needs its source element identity.')
        position = atom.get('position')
        require(isinstance(position, list) and len(position) == 3 and all(finite(x) for x in position),
                'source', 'Every cluster atom requires three finite scientific coordinates.')
        precision = atom.get('coordinatePrecisionAngstrom', 0)
        require(finite(precision) and precision >= 0, 'source', 'Source coordinate precision must be an explicit nonnegative bound.')
        if atom.get('imageRef') is not None:
            image = atom['imageRef']
            require(isinstance(image, dict) and isinstance(image.get('sourceAtomId'), str)
                    and 0 < len(image['sourceAtomId']) <= 512, 'image', 'An image requires its underlying source atom identity.')
            shift = image.get('translation')
            require(isinstance(shift, list) and len(shift) == 3 and all(type(n) is int for n in shift),
                    'image', 'Periodic image translations must preserve three integer lattice offsets.')
    return copy.deepcopy(source)


def validate_cluster(source):
    """Explicit complete finite input only; visibility is not scientific input."""
    source = validate_cluster_geometry(source)
    atoms = source['atoms']
    selections = []
    for key in ('targetAtomIndices', 'environmentAtomIndices'):
        values = source.get(key)
        require(isinstance(values, list) and bool(values) and all(type(n) is int and 1 <= n <= len(atoms) for n in values)
                and len(values) == len(set(values)), 'selection', 'Target and environment must be nonempty explicit source-atom sets.')
        selections.append(set(values))
    require(not selections[0] & selections[1] and selections[0] | selections[1] == set(range(1, len(atoms) + 1)),
            'selection', 'Target and environment must partition the entire provided cluster; atoms were not silently discarded.')
    return copy.deepcopy(source)


def parsing_budget(texts, point_count, atom_count, memory_budget_bytes):
    require(type(memory_budget_bytes) is int and memory_budget_bytes > 0, 'budget', 'A current positive memory grant is required.')
    require(type(point_count) is int and 1 <= point_count, 'budget', 'Native vertex count exceeds the bounded admission profile.')
    # Conservative Python-object/wire overhead, in addition to retained source text.
    estimate = sum(len(text) * 6 for text in texts) + point_count * 2048 + atom_count * 2048
    return estimate


def parse_native_summary(output, target_count):
    definitions = re.findall(r'current:\s*Hirshfeld surface,\s*for\s+(\d+)\s+atoms', output)
    mappings = re.findall(r'2 Select mapped function, current:\s*([^\r\n]+)', output)
    require(definitions and int(definitions[-1]) == target_count and mappings and mappings[-1].strip() == 'd_norm',
            'definition', 'Native evidence must explicitly define the selected Hirshfeld surface and d_norm mapping.')
    require('Surface analysis finished!' in output, 'incomplete', 'Native surface analysis did not complete.')
    mesh = re.findall(r'After elimination, V=\s*(\d+),\s*E=\s*(\d+),\s*F=\s*(\d+)', output)
    require(bool(mesh), 'vertices', 'The post-elimination native vertex count is missing.')
    vertices, edges, faces = map(int, mesh[-1])
    require(vertices > 0 and edges > 0 and faces > 0, 'vertices', 'The native surface inventory is invalid.')
    areas = re.findall(r'Overall surface area:\s*(' + NUMBER + r')\s+Bohr\^2\s*\(\s*(' + NUMBER + r')\s+Angstrom\^2\)', output)
    require(bool(areas), 'area', 'The native total Hirshfeld surface area is missing.')
    raw = areas[-1][1]
    require(number(raw) > 0, 'area', 'Native total surface area must be positive.')
    return dict(vertexCount=vertices, edgeCount=edges, triangleCount=faces, totalArea=number(raw),
                totalAreaRaw=raw, totalAreaPrecision=half_last_digit(raw))


def _printed(raw):
    return dict(value=number(raw), rawValue=raw, precision=half_last_digit(raw))


def _consistent(actual, expected, precision):
    return abs(actual - expected) <= precision + 64 * math.ulp(max(1., abs(actual), abs(expected)))


def parse_native_contacts(output, summary):
    heading = 'Inside element, outside element, their contact area (Angstrom^2) and percentage (%)'
    require(output.count(heading) == 1, 'contacts', 'Exactly one native element-contact table is required for this analysis.')
    section = output.split(heading)[1]
    end = re.search(r'Area of total contact surface is\s+(' + NUMBER + r')\s+Angstrom\^2', section)
    require(end is not None, 'contacts', 'The native contact-area table is truncated.')
    body = section[:end.start()]
    marker = 'The same as above, but do not distinguish inside and outside elements'
    require(body.count(marker) == 1, 'contacts', 'Both directed and merged native contact tables are required.')
    directed_text, merged_text = body.split(marker)
    def rows(text, merged):
        result = []
        seen = set()
        for line in text.splitlines():
            if not line.strip():
                continue
            match = re.fullmatch(r'\s*([A-Z][a-z]?)-([A-Z][a-z]?)(?:/([A-Z][a-z]?)-([A-Z][a-z]?))?\s+(' + NUMBER + r')\s+(' + NUMBER + r')\s*', line)
            require(match is not None, 'contacts', 'Native contact table contains an unrecognised or incomplete row.')
            a, b, reverse_a, reverse_b, area_raw, percent_raw = match.groups()
            require((not reverse_a or merged and a != b and (reverse_a, reverse_b) == (b, a))
                    and (not merged or a == b or reverse_a is not None), 'contacts', 'Native directed/merged contact orientation is inconsistent.')
            key = tuple(sorted((a, b))) if merged else (a, b)
            require(key not in seen, 'contacts', 'Native element contacts contain a duplicate row.')
            seen.add(key)
            area, percent = _printed(area_raw), _printed(percent_raw)
            require(area['value'] >= 0 and 0 <= percent['value'] <= 100, 'contacts', 'Native contact area or percentage is outside its physical range.')
            total, precision = summary['totalArea'], summary['totalAreaPrecision']
            # Propagate only printed last-digit bounds; no renormalisation.
            ratio_precision = 100 * (area['precision'] / total + area['value'] * precision / (total * (total - precision)))
            require(_consistent(percent['value'], 100 * area['value'] / total, percent['precision'] + ratio_precision),
                    'denominator', 'Native percentages disagree with the immutable whole-Hirshfeld-surface denominator.')
            result.append(dict(insideElement=a, outsideElement=b, area=area['value'], nativePercent=percent['value'],
                               areaRaw=area_raw, percentRaw=percent_raw, areaPrecision=area['precision'], percentPrecision=percent['precision']))
        require(bool(result), 'contacts', 'The native contact-area table is empty.')
        require(_consistent(sum(row['area'] for row in result), summary['totalArea'],
                            sum(row['areaPrecision'] for row in result) + summary['totalAreaPrecision']),
                'closure', 'Native element contact areas do not cover the complete Hirshfeld surface.')
        return result
    directed, merged = rows(directed_text, False), rows(merged_text, True)
    groups = {}
    for row in directed:
        groups.setdefault(tuple(sorted((row['insideElement'], row['outsideElement']))), []).append(row)
    require(set(groups) == {tuple(sorted((row['insideElement'], row['outsideElement']))) for row in merged},
            'contacts', 'Directed and merged contact tables describe different element pairs.')
    for row in merged:
        contributors = groups[tuple(sorted((row['insideElement'], row['outsideElement'])))]
        for value, precision in (('area', 'areaPrecision'), ('nativePercent', 'percentPrecision')):
            require(_consistent(row[value], sum(entry[value] for entry in contributors), row[precision] + sum(entry[precision] for entry in contributors)),
                    'contacts', 'A merged contact is not the sum of its directed native contributors.')
    total = _printed(end[1])
    require(_consistent(total['value'], summary['totalArea'], total['precision'] + summary['totalAreaPrecision']),
            'denominator', 'Native total contact area differs from the completed Hirshfeld surface area.')
    return dict(method='native-area', areaUnit='angstrom^2', directedRows=directed, mergedRows=merged,
                denominator=dict(area=summary['totalArea'], rawValue=summary['totalAreaRaw'], scope='whole-hirshfeld-surface'),
                mergedRule='Sum reverse directed element pairs once; same-element pairs appear once.')


def parse_vertex_samples(pqr, di_de, expected_count):
    """Post-elimination file order joins native PQR and di/de, not PQR serials."""
    vertices = []
    serials = set()
    for line in pqr.splitlines():
        if line.startswith(('REMARK', 'END')) or not line.strip():
            continue
        require(line.startswith(('HETATM', 'ATOM  ')) and len(line) >= 54, 'pqr', 'Unexpected native PQR vertex record.')
        # Native PQR uses fixed coordinate columns, including concatenated
        # record-name/serial fields at large serials. Whitespace tokenising the
        # entire line would move the coordinate and mapped-value columns.
        serial = line[6:11].strip()
        coordinates = [line[a:b].strip() for a, b in ((30, 38), (38, 46), (46, 54))]
        tail = line[54:].split()
        require(serial.isdigit() and int(serial) > 0 and (int(serial) not in serials or int(serial) == 99999) and len(tail) == 3
                and all(re.fullmatch(NUMBER, x) for x in coordinates + tail[:2]), 'pqr', 'Native PQR vertex columns are invalid.')
        serials.add(int(serial))
        vertices.append(dict(nativeSerial=int(serial), position=list(map(number, coordinates)),
                             coordinatePrecisionAngstrom=list(map(half_last_digit, coordinates)), dnorm=number(tail[0]),
                             dnormRaw=tail[0], dnormUnit='dimensionless'))
    distances = []
    for line in di_de.splitlines():
        row = line.split()
        require(len(row) == 2 and all(re.fullmatch(NUMBER, value) for value in row), 'fingerprint', 'Native di/de records require exactly two finite distance columns.')
        values = list(map(number, row))
        require(all(value >= 0 for value in values), 'fingerprint', 'Native di/de distances must be nonnegative.')
        distances.append((values, list(map(half_last_digit, row))))
    require(len(vertices) == len(distances) == expected_count, 'correspondence',
            'PQR and complete di/de must contain the same post-elimination native vertex inventory.')
    for index, (vertex, (distances_, precision)) in enumerate(zip(vertices, distances)):
        vertex.update(index=index, di=distances_[0], de=distances_[1], distanceUnit='angstrom', distancePrecisionAngstrom=precision)
    return vertices


def associate_nearest_atoms(vertices, source, current=lambda: None):
    """Geometry supplies linked identities only; native areas/dnorm are untouched.

    All nuclei compatible with the printed-coordinate uncertainty are retained
    when a unique nearest atom cannot be proved. No arbitrary tie is hidden.
    """
    atoms = {atom['sourceIndex']: atom for atom in source['atoms']}
    for ordinal, vertex in enumerate(vertices):
        if ordinal % 128 == 0:
            current()
        point_error = math.sqrt(sum(value * value for value in vertex['coordinatePrecisionAngstrom']))
        for key, distance_key, precision_index in (('targetAtomIndices', 'di', 0), ('environmentAtomIndices', 'de', 1)):
            measured = []
            for index in source[key]:
                atom = atoms[index]
                value = math.dist(vertex['position'], atom['position'])
                error = point_error + math.sqrt(3) * atom.get('coordinatePrecisionAngstrom', 0)
                require(math.isfinite(value) and math.isfinite(error), 'geometry', 'Nearest-atom geometry exceeded finite representation.')
                measured.append((index, value, error))
            minimum_upper = min(value + error for _, value, error in measured)
            minimum_lower = min(max(0, value - error) for _, value, error in measured)
            native = vertex[distance_key]
            precision = vertex['distancePrecisionAngstrom'][precision_index]
            require(native + precision >= minimum_lower - 1e-12 and native - precision <= minimum_upper + 1e-12,
                    'correspondence', 'Native di/de does not match this vertex and the registered target/environment geometry.')
            candidates = [index for index, value, error in measured if value - error <= minimum_upper + 1e-12]
            prefix = 'inside' if distance_key == 'di' else 'outside'
            vertex[prefix + 'AtomIndices'] = candidates
            vertex[prefix + 'AtomIds'] = [atoms[index]['stableId'] for index in candidates]
    return vertices


def admit_native_result(source, output, pqr, di_de_all, memory_budget_bytes, current=lambda: None, open_preview=False):
    """Admit a completed native dataset without claiming render/native acceptance.

    Caller owns immutable artifact identities, the analysis stamp and current
    scheduler grant. This pure helper never starts a process or creates a job.
    """
    cluster = validate_cluster(source)
    require(all(isinstance(value, str) for value in (output, pqr, di_de_all)), 'source', 'Native artifacts must be decoded source text.')
    vertices = []; sample_error = None
    try:
        summary = parse_native_summary(output, len(cluster['targetAtomIndices']))
        estimate = parsing_budget((output, pqr, di_de_all), summary['vertexCount'], len(cluster['atoms']), memory_budget_bytes)
        contacts = None if open_preview else parse_native_contacts(output, summary)
        inside_elements = {cluster['atoms'][index - 1]['element'] for index in cluster['targetAtomIndices']}
        outside_elements = {cluster['atoms'][index - 1]['element'] for index in cluster['environmentAtomIndices']}
        require(all(row['insideElement'] in inside_elements and row['outsideElement'] in outside_elements
                    for row in (contacts['directedRows'] if contacts else [])), 'contacts',
                'Native directed contact elements do not belong to the registered target/environment sets.')
        vertices = associate_nearest_atoms(parse_vertex_samples(pqr, di_de_all, summary['vertexCount']), cluster, current)
    except SurfaceError as error:
        if not open_preview or any(term in str(getattr(error, 'code', '')) for term in ('budget', 'cancelled')):
            raise
        # A field-only preview is valid; unavailable native samples stay absent.
        # No point is reconstructed from the display mesh or assigned zero data.
        current(); summary = None; contacts = None
        estimate = parsing_budget((output, pqr, di_de_all), 1, len(cluster['atoms']), memory_budget_bytes)
        sample_error = str(error)
    return dict(schema='sciyue-hirshfeld-native/v1', kind='hirshfeld', source=cluster,
                definition=dict(function='hirshfeld-weight', isovalue=.5, mapping='dnorm', mappingUnit='dimensionless',
                                atomicDensity='native spherical free-atom density', vdwRadii='native effective settings; no reconstructed radius table'),
                quantitativeSummary=None if open_preview else summary, vertices=vertices, contacts=contacts,
                fingerprint=dict(samplesAvailable=bool(vertices), sampleDiagnostic=sample_error, scope='current-range' if open_preview else 'whole-surface', method='native-surface-vertex-samples', areaWeighted=False, coordinateUnit='angstrom',
                                 correspondence='Post-elimination native file order, verified against registered target/environment geometry.'),
                surface=dict(available=False, reason='A same-analysis native Hirshfeld-weight field or validated triangle connectivity is still required; vertices are not a renderable surface.'),
                estimatedRetainedBytes=estimate)


def native_boundary_faces(shape):
    grid = shape['values'].reshape(shape['grid']['dimensions'])
    return [name for name, face in zip(('x-min', 'x-max', 'y-min', 'y-max', 'z-min', 'z-max'),
            (grid[0], grid[-1], grid[:, 0], grid[:, -1], grid[:, :, 0], grid[:, :, -1])) if np.any(face >= .5)]


def validate_native_cube_pair(shape, mapping, source, symbols, vertices=None, open_preview=False):
    """No density relabelling, resampling, boundary caps or inferred zero mask."""
    from surface_analysis import require_cube_pair, BOHR_TO_ANGSTROM
    require_cube_pair(shape, mapping)
    require(len(shape['atoms']) == len(source['atoms']), 'cube-source', 'Native HS Cubes must retain the complete registered cluster atom inventory.')
    factor = BOHR_TO_ANGSTROM if shape['grid']['coordinateUnit'] == 'bohr' else 1
    for index, (atom, expected) in enumerate(zip(shape['atoms'], source['atoms'])):
        require(0 < atom['atomicNumber'] < len(symbols) and symbols[atom['atomicNumber']] == expected['element'],
                'cube-source', 'Native HS Cube atom elements or source order changed.')
        precision = shape['precision']['atomCoordinates'][index]
        require(all(abs(actual * factor - reference) <= bound * factor + expected.get('coordinatePrecisionAngstrom', 0)
                    + 64 * np.finfo(float).eps * max(1, abs(reference))
                    for actual, reference, bound in zip(atom['position'], expected['position'], precision)),
                'cube-source', 'Native HS Cube coordinates differ from the registered complete source cluster.')
    values = shape['values']; dimensions = shape['grid']['dimensions']
    require(len(dimensions) == 3 and min(dimensions) >= 3, 'cube-grid', 'HS closure needs at least three nodes on each native grid axis.')
    require(np.isfinite(values).all() and np.all(values >= 0) and np.all(values <= 1),
            'cube-weight', 'A native Hirshfeld weight field must be finite and in [0,1]; undefined nodes were not filled.')
    require(np.isfinite(mapping['values']).all(), 'cube-mapping', 'Native dnorm grid must be finite on the complete paired box.')
    grid = values.reshape(dimensions)
    boundary_faces = native_boundary_faces(shape)
    require(np.any(values > .5) and np.any(values < .5), 'cube-closure', 'The native box has no weight-0.5 crossing; no surface was invented.')
    require(open_preview or not boundary_faces, 'cube-closure', 'The native 0.5 surface touches the box boundary or lacks an interior; no cap or cropped surface was accepted.')
    if vertices is not None:
        basis = np.asarray(shape['grid']['axes'], dtype=float).T
        inverse = np.linalg.inv(basis); origin = np.asarray(shape['grid']['origin'])
        axis_precision = np.asarray(shape['precision']['axes']).T
        for vertex in vertices:
            local = inverse @ (np.asarray(vertex['position']) / factor - origin)
            uncertainty = np.abs(inverse) @ (np.asarray(vertex['coordinatePrecisionAngstrom']) / factor
                                             + np.asarray(shape['precision']['origin']) + axis_precision @ np.abs(local))
            require(np.isfinite(local).all() and np.isfinite(uncertainty).all(), 'cube-vertices', 'Native point-to-grid correspondence exceeded finite representation.')
            candidates = []
            for value, error, size in zip(local, uncertainty, dimensions):
                lower = max(0, math.floor(value - error - 1e-12)); upper = min(size - 2, math.floor(value + error + 1e-12))
                require(0 <= lower <= upper < size - 1 and upper - lower <= 2, 'cube-vertices',
                        'A quantitative vertex is outside the same native grid or lacks a bounded source-precision association.')
                candidates.append(range(lower, upper + 1))
            require(any(np.min(grid[x:x + 2, y:y + 2, z:z + 2]) <= .5 <= np.max(grid[x:x + 2, y:y + 2, z:z + 2])
                        for x in candidates[0] for y in candidates[1] for z in candidates[2]), 'cube-vertices',
                    'A quantitative vertex has no compatible weight-0.5 crossing cell in the exported native grid.')
    return dict(kind='full-grid', evidence='Native main-12 Hirshfeld weight and explicit d_norm mapping exported in the same analysis and box; finite full grid. ' + ('Open preview in the current box; no boundary caps or complete-surface denominator.' if open_preview else 'No 0.5 boundary intersection.'))
