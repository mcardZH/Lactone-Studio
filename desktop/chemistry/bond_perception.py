"""Composite bond candidates; never edits atoms or electronic state.

Native Mayer (AO) evidence directly determines measured connection orders.
Sparse omitted nonmetal pairs stay unconnected; only weak/missing metal
contacts use distance assistance. Fractional MBO bins do not mean aromaticity.
Without native evidence, bounded distance/valence/RDKit heuristics are retained.
RDKit's allowChargedFragments=False candidate route uses native radicals instead
of assigning formal charges. No radical/electronic-state inference is written
back to the model. No subprocess, xTB invocation or implicit H is used here.
https://github.com/rdkit/rdkit/blob/Release_2025_03_6/Code/GraphMol/DetermineBonds/DetermineBonds.cpp
"""
from __future__ import annotations

import copy
import itertools
import math

from rdkit import Chem
from rdkit.Chem import rdDetermineBonds

METALS = set(('Li Be Na Mg Al K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn '
              'Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po '
              'Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv').split())
SEEDS = {('C', 'C'): (1.54, 1.34, 1.20), ('C', 'N'): (1.47, 1.29, 1.16),
         ('C', 'O'): (1.43, 1.23, 1.13), ('N', 'N'): (1.45, 1.25, 1.10),
         ('N', 'O'): (1.40, 1.21, 1.15), ('O', 'O'): (1.48, 1.21, 1.10)}
H_SEEDS = {'H': .74, 'C': 1.09, 'N': 1.01, 'O': .97, 'S': 1.34}


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _empirical_parameters(request, reject):
    value = request.get('empiricalBondParameters')
    if value is None:
        return None
    required = {'minDistanceFactor', 'maxDistanceFactor', 'bondOrderMode', 'pairOverrides', 'excludedElements'}
    if (not isinstance(value, dict) or set(value) != required or
            not _finite(value.get('minDistanceFactor')) or not _finite(value.get('maxDistanceFactor')) or
            not 0 <= value['minDistanceFactor'] < value['maxDistanceFactor'] <= 3 or
            value.get('bondOrderMode') not in ('auto-organic', 'connectivity-only') or
            not isinstance(value.get('pairOverrides'), list) or not isinstance(value.get('excludedElements'), list)):
        reject('perception-parameters', 'Empirical bounds or order mode are invalid.')
    table = Chem.GetPeriodicTable()
    def symbol(item):
        try:
            return isinstance(item, str) and table.GetAtomicNumber(item) > 0
        except Exception:
            return False
    if not all(symbol(item) for item in value['excludedElements']) or len(set(value['excludedElements'])) != len(value['excludedElements']):
        reject('perception-parameters', 'Excluded elements must be unique valid element symbols.')
    seen = set()
    for entry in value['pairOverrides']:
        if (not isinstance(entry, dict) or set(entry) != {'elements', 'minDistance', 'maxDistance'} or
                not isinstance(entry.get('elements'), list) or len(entry['elements']) != 2 or not all(symbol(item) for item in entry['elements']) or
                not _finite(entry.get('minDistance')) or not _finite(entry.get('maxDistance')) or
                not 0 <= entry['minDistance'] < entry['maxDistance'] <= 20):
            reject('perception-parameters', 'Element-pair overrides require valid symbols and 0 <= lower < upper <= 20 angstrom.')
        pair = tuple(sorted(entry['elements']))
        if pair in seen:
            reject('perception-parameters', 'Element-pair overrides must be unique.')
        seen.add(pair)
    return value


def _evidence(request, structure, reject):
    value = request.get('bondOrderEvidence')
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {'definition', 'sourceField', 'threshold', 'entries'} or value.get('definition') != 'mayer-ao' or value.get('sourceField') != 'wbo' or not _finite(value.get('threshold')) or value['threshold'] != .1:
        reject('bond-order-evidence', 'Composite perception requires the declared native Mayer (AO) wbo schema and its 0.1 sparse print threshold.')
    ids = {atom['id']: i for i, atom in enumerate(structure['atoms'])}
    entries = value.get('entries')
    if not isinstance(entries, list) or len(entries) > len(ids)*(len(ids)-1)//2:
        reject('bond-order-evidence', 'Native bond-order entries exceed the current pair domain.')
    result = {}
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {'atomIds', 'value'}:
            reject('bond-order-evidence', 'A native bond-order entry has an invalid schema.')
        pair = entry.get('atomIds')
        if not isinstance(pair, list) or len(pair) != 2 or any(not isinstance(i, str) or i not in ids for i in pair) or pair[0] == pair[1]:
            reject('bond-order-evidence-identity', 'Native bond-order entries must reference two distinct stable IDs in this exact model.')
        key = tuple(sorted(ids[i] for i in pair))
        if key in result or not _finite(entry.get('value')) or entry['value'] < .1:
            reject('bond-order-evidence', 'Native bond-order entries must be unique, finite and consistent with the sparse 0.1 print threshold; missing pairs are not zero.')
        result[key] = float(entry['value'])
    charge, multiplicity = structure.get('charge'), structure.get('multiplicity')
    if isinstance(charge, bool) or not isinstance(charge, int) or isinstance(multiplicity, bool) or not isinstance(multiplicity, int) or multiplicity < 1:
        reject('perception-electronic-state', 'GFN2-assisted perception requires the explicitly supplied integer charge and positive multiplicity of that calculation.')
    electrons = sum(Chem.GetPeriodicTable().GetAtomicNumber(a['element']) for a in structure['atoms'])-charge
    if electrons < 1 or multiplicity-1 > electrons or (electrons-(multiplicity-1)) % 2:
        reject('perception-electronic-state', 'The supplied charge/multiplicity is incompatible with the explicit electron count; it was not changed.')
    return result


def _capacity(atom):
    # Only ordinary covalent atoms use RDKit's charged isoelectronic valences.
    # This function is never applied to a metal coordination endpoint.
    table = Chem.GetPeriodicTable()
    number = table.GetAtomicNumber(atom['element'])-atom.get('formalCharge', 0)
    if not 1 <= number <= 118:
        return 0
    allowed = [int(v) for v in table.GetValenceList(number) if v >= 0]
    return max(allowed, default=0)


def _stretched_contact(atoms, a, b, distance):
    seed = SEEDS.get(tuple(sorted((atoms[a]['element'], atoms[b]['element']))))
    return bool(seed and distance > max(seed[0]*1.10, seed[0]+.12))


def _merge_perception_issues(*groups):
    """One issue per unordered stable-ID pair; retain the strongest status."""
    priority = {'weak-contact': 1, 'partial': 2, 'unresolved': 3}
    merged = {}
    for group in groups:
        for issue in group:
            pair = tuple(sorted(issue['atomIds']))
            previous = merged.get(pair)
            if previous is None or priority[issue['kind']] > priority[previous['kind']]:
                merged[pair] = issue
    return list(merged.values())


def strict_contact_issues(structure):
    """Annotate long strict-import edges without replacing its valid graph."""
    atoms = structure['atoms']
    issues = []
    for bond in structure.get('bonds', []):
        a, b = bond['a'], bond['b']
        distance = math.hypot(*(atoms[a][k]-atoms[b][k] for k in ('x', 'y', 'z')))
        if _stretched_contact(atoms, a, b, distance):
            issues.append(dict(atomIds=[atoms[i]['id'] for i in sorted((a, b))], kind='weak-contact',
                               reason='A stretched contact was retained by the sanitized strict import graph; its reaction-state connectivity remains uncertain despite successful native graph sanitation.'))
    return _merge_perception_issues(issues, short_hydrogen_contact_issues(structure))


def short_hydrogen_contact_issues(structure):
    """Geometry-only donor-H...acceptor annotations, never covalent edges.

    Each H needs one ordinary O/N/S donor. At most its two nearest additional
    O/N/S contacts survive the 1.6-radius-sum and >=120-degree angle bounds.
    These editor heuristics are neither measured fractional bonds nor TS proof.
    """
    atoms, bonds = structure['atoms'], structure.get('bonds', [])
    neighbours = {i: [] for i in range(len(atoms))}
    existing = set()
    for bond in bonds:
        a, b = bond['a'], bond['b']
        existing.add(tuple(sorted((a, b))))
        if bond.get('kind') != 'coordination' and not bond.get('fractional'):
            neighbours[a].append(b)
            neighbours[b].append(a)
    table = Chem.GetPeriodicTable()
    donor_elements = {'O', 'N', 'S'}
    issues = []
    for h, atom in enumerate(atoms):
        if atom['element'] != 'H' or len(neighbours[h]) != 1:
            continue
        donor = neighbours[h][0]
        if atoms[donor]['element'] not in donor_elements:
            continue
        u = [atoms[donor][k]-atom[k] for k in ('x', 'y', 'z')]
        donor_distance = math.hypot(*u)
        if not math.isfinite(donor_distance) or donor_distance <= 1e-8:
            continue
        contacts = []
        for acceptor, other in enumerate(atoms):
            pair = tuple(sorted((h, acceptor)))
            if other['element'] not in donor_elements or acceptor == donor or pair in existing:
                continue
            v = [other[k]-atom[k] for k in ('x', 'y', 'z')]
            distance = math.hypot(*v)
            radius_sum = table.GetRcovalent(1)+table.GetRcovalent(table.GetAtomicNumber(other['element']))
            if not math.isfinite(distance) or distance <= 1e-8 or radius_sum <= 0 or distance > 1.6*radius_sum:
                continue
            cosine = sum(x*y for x, y in zip(u, v))/(donor_distance*distance)
            if cosine > -.5+1e-12:
                continue
            contacts.append((distance, other['id'], pair))
        for _, _, pair in sorted(contacts)[:2]:
            issues.append(dict(atomIds=[atoms[i]['id'] for i in pair], kind='weak-contact',
                reason='Geometry-only donor-H...acceptor candidate: H...acceptor is within 1.6 times the covalent-radius sum and donor-H...acceptor angle is at least 120 degrees (at most two nearest contacts per H). This is not a measured 0.5 bond or proof of a transition state.'))
    return issues


def _molecule(atoms, indices, orders):
    indices = sorted(indices)
    mapping = {old: new for new, old in enumerate(indices)}
    rw = Chem.RWMol()
    conf = Chem.Conformer(len(indices))
    conf.Set3D(True)
    for old in indices:
        item = atoms[old]
        atom = Chem.Atom(item['element'])
        atom.SetFormalCharge(item.get('formalCharge', 0))
        atom.SetNoImplicit(True)
        atom.SetProp('_StableId', item['id'])
        new = rw.AddAtom(atom)
        conf.SetAtomPosition(new, (item['x'], item['y'], item['z']))
    types = {1: Chem.BondType.SINGLE, 2: Chem.BondType.DOUBLE, 3: Chem.BondType.TRIPLE, 1.5: Chem.BondType.AROMATIC}
    for (a, b), order in sorted(orders.items()):
        if a not in mapping or b not in mapping:
            continue
        rw.AddBond(mapping[a], mapping[b], types[order])
        if order == 1.5:
            rw.GetBondBetweenAtoms(mapping[a], mapping[b]).SetIsAromatic(True)
            rw.GetAtomWithIdx(mapping[a]).SetIsAromatic(True)
            rw.GetAtomWithIdx(mapping[b]).SetIsAromatic(True)
    mol = rw.GetMol()
    mol.AddConformer(conf)
    mol.UpdatePropertyCache(strict=False)
    return mol, indices


def _checked(mol, atoms, indices, edge_keys):
    probe = Chem.Mol(mol)
    Chem.SanitizeMol(probe)
    if probe.GetNumAtoms() != len(indices):
        raise ValueError('atom count')
    for i, old in enumerate(indices):
        atom, source = probe.GetAtomWithIdx(i), atoms[old]
        p = probe.GetConformer().GetAtomPosition(i)
        if atom.GetProp('_StableId') != source['id'] or atom.GetSymbol() != source['element'] or atom.GetFormalCharge() != source.get('formalCharge', 0) or not atom.GetNoImplicit() or atom.GetNumImplicitHs() or atom.GetNumExplicitHs() or (p.x, p.y, p.z) != (source['x'], source['y'], source['z']):
            raise ValueError('chemical/coordinate change')
    orders = {tuple(sorted((indices[b.GetBeginAtomIdx()], indices[b.GetEndAtomIdx()]))):
              1.5 if b.GetIsAromatic() else b.GetBondTypeAsDouble() for b in probe.GetBonds()}
    if set(orders) != set(edge_keys) or any(order not in (1, 1.5, 2, 3) for order in orders.values()):
        raise ValueError('edge change')
    return orders


def _components(indices, orders):
    adjacency = {i: set() for i in indices}
    for a, b in orders:
        adjacency[a].add(b)
        adjacency[b].add(a)
    remaining = set(indices)
    while remaining:
        component, pending = set(), [min(remaining)]
        while pending:
            i = pending.pop()
            if i in component:
                continue
            component.add(i)
            pending.extend(adjacency[i]-component)
        remaining -= component
        yield component


def _quantize_mbo(value):
    # The sequence makes every exact midpoint choose the lower order.
    for upper, order in ((.25, 0), (.75, .5), (1.25, 1), (1.75, 1.5), (2.5, 2)):
        if value <= upper:
            return order
    return 3


def _recover_local_rings(atoms, component, orders, order_cost):
    """Try bounded Kekule alternatives; only native-confirmed rings survive.

    A greedy distance upgrade can select one central double instead of two
    alternating doubles. Enumerating a five/six-membered local ring prevents
    an unrelated failed assignment from permanently erasing that aromaticity.
    No aromatic flags are accepted without sanitizing the full fixed graph.
    """
    mol, indices = _molecule(atoms, component, orders)
    rings = [tuple(indices[i] for i in ring) for ring in Chem.GetSymmSSSR(mol) if 5 <= len(ring) <= 6]
    recovered = dict(orders)
    for ring in rings:
        pairs = {tuple(sorted((ring[i], ring[(i+1) % len(ring)]))) for i in range(len(ring))}
        if all(recovered[p] == 1.5 for p in pairs):
            continue
        alternatives = []
        for doubles in itertools.combinations(sorted(pairs), len(ring)//2):
            if any(sum(i in p for p in doubles) > 1 for i in ring):
                continue
            trial = dict(recovered)
            trial.update({p: 2 if p in doubles else 1 for p in pairs})
            try:
                probe, order_indices = _molecule(atoms, component, trial)
                proposal = _checked(probe, atoms, order_indices, trial)
                if not all(proposal[p] == 1.5 for p in pairs):
                    continue
                if any(proposal[p] != recovered[p] and proposal[p] != 1.5 for p in proposal if p not in pairs):
                    continue
                cost = sum(order_cost(p, value) for p, value in proposal.items())
                if cost <= sum(order_cost(p, value) for p, value in recovered.items())+.75*len(pairs):
                    alternatives.append((cost, tuple(sorted(proposal.items())), proposal))
            except Exception:
                continue
        if alternatives:
            recovered = min(alternatives, key=lambda item: item[:2])[2]
    return recovered


def _close_weak_contacts(atoms, indices, orders, weak, capacity):
    """Bounded fixed-charge closure search; certain multiple bonds stay fixed."""
    def checked(trial):
        mol, mapping = _molecule(atoms, indices, trial)
        Chem.SanitizeMol(mol)
        proposal = _checked(mol, atoms, mapping, trial)
        radicals = {mapping[a.GetIdx()]: a.GetNumRadicalElectrons() for a in mol.GetAtoms() if a.GetNumRadicalElectrons()}
        return proposal, radicals

    try:
        baseline, radicals = checked(orders)
    except Exception:
        return orders, set(), None
    best, accepted, remaining = baseline, set(), radicals
    rank = (sum(radicals.values()), 0, 0, ())
    if not radicals:
        return best, accepted, remaining
    # A bounded local set avoids exponential searches on dense geometries.
    candidates = sorted(weak, key=lambda p: (-sum(i in radicals for i in p), -weak[p]['score'], p))[:8]
    for size in range(1, len(candidates)+1):
        for subset in itertools.combinations(candidates, size):
            trial = dict(baseline)
            valence = {i: sum(order for p, order in trial.items() if i in p) for i in capacity}
            for pair in subset:
                trial[pair] = 1
                for i in pair:
                    valence[i] += 1
            if any(valence[i] > capacity[i] for pair in subset for i in pair):
                continue
            try:
                proposal, trial_radicals = checked(trial)
                if any(proposal[p] != baseline[p] for p in baseline):
                    continue
                fit = sum(weak[p]['distance'] for p in subset)
                trial_rank = (sum(trial_radicals.values()), size, fit, tuple(subset))
                if trial_rank < rank:
                    best, accepted, remaining, rank = proposal, set(subset), trial_radicals, trial_rank
            except Exception:
                continue
    return best, accepted, remaining


def _mbo_perceive(structure, evidence, reject):
    atoms = structure['atoms']
    metal = {i for i, atom in enumerate(atoms) if atom['element'] in METALS}
    table = Chem.GetPeriodicTable()
    radii = {}
    bonds, organic_neighbours, metal_candidates, conflicts = [], {i: set() for i in range(len(atoms))}, {}, set()

    def radius(i):
        if i not in radii:
            radii[i] = table.GetRcovalent(table.GetAtomicNumber(atoms[i]['element']))
            if not _finite(radii[i]) or radii[i] <= 0:
                reject('perception-radius', 'A metal-distance contact lacks a positive checked native covalent radius; no fallback radius was invented.')
        return radii[i]

    for a, b in itertools.combinations(range(len(atoms)), 2):
        pair = (a, b)
        distance = math.hypot(*(atoms[a][k]-atoms[b][k] for k in ('x', 'y', 'z')))
        if not math.isfinite(distance):
            reject('perception-coordinate-range', 'Finite input coordinates overflowed the pair-distance calculation; no bond candidates were accepted.')
        bo = evidence.get(pair)
        order = _quantize_mbo(bo) if bo is not None else 0
        is_metal = a in metal or b in metal
        if order:
            bond = dict(a=a, b=b, order=order, perception='gfn2-mbo', mbo=bo)
            if order in (.5, 1.5):
                bond.update(fractional=True, aromatic=False)
            bonds.append(bond)
            if not is_metal:
                organic_neighbours[a].add(b)
                organic_neighbours[b].add(a)
        elif bo is not None and not is_metal:
            conflicts.add(pair)
        if not is_metal:
            continue
        # Positive measured bins above were accepted without any geometric
        # gate. This bounded candidate table is used only for weak/missing
        # metal assistance and the pre-existing second-shell comparison.
        ratio = distance/(radius(a)+radius(b))
        score = 2*(1.30-ratio)+(min(1.7, .5*(math.log(bo)-math.log(.1))) if bo is not None else 0)
        if .55 <= ratio <= 1.55 and score > 0:
            metal_candidates[pair] = dict(distance=distance, score=score, bo=bo, measured=bool(order))
        elif bo is not None and not order:
            conflicts.add(pair)

    for pair, data in sorted(metal_candidates.items()):
        if data['measured']:
            continue
        a, b = pair
        if 'H' in (atoms[a]['element'], atoms[b]['element']):
            hydrogen = a if atoms[a]['element'] == 'H' else b
            if organic_neighbours[hydrogen] and (data['bo'] is None or data['bo'] < .25):
                conflicts.add(pair)
                continue
        shadowed = False
        for m, ligand in ((a, b), (b, a)):
            if m not in metal or ligand in metal:
                continue
            for neighbour in organic_neighbours[ligand]:
                prior = metal_candidates.get(tuple(sorted((m, neighbour))))
                if not prior or prior['distance'] >= data['distance'] or prior['score'] <= data['score']:
                    continue
                u = [atoms[neighbour][k]-atoms[m][k] for k in ('x', 'y', 'z')]
                v = [atoms[ligand][k]-atoms[m][k] for k in ('x', 'y', 'z')]
                cosine = sum(x*y for x, y in zip(u, v))/(prior['distance']*data['distance'])
                if cosine > .85:
                    shadowed = True
        if shadowed:
            conflicts.add(pair)
            continue
        bond = dict(a=a, b=b, order=1, kind='coordination', perception='metal-distance')
        if data['bo'] is not None:
            bond['mbo'] = data['bo']
        bonds.append(bond)
    bonds.sort(key=lambda bond: (bond['a'], bond['b']))
    output = copy.deepcopy(structure)
    output['bonds'] = bonds
    output['bondSource'] = 'inferred'
    output.pop('bondPerceptionIssues', None)
    output.setdefault('notes', []).append('Native Mayer (AO) values were quantized to 0/0.5/1/1.5/2/3 with midpoint ties choosing the lower order. Measured fractional connections are non-aromatic; no nonmetal distance, valence or RDKit override was applied. Sparse absent entries remain unknown; only weak/missing metal contacts use distance assistance. Source atoms, coordinates and electronic state were retained.')
    summary = dict(method='gfn2-assisted', bondCount=len(bonds), coordinationCount=sum(b.get('kind') == 'coordination' for b in bonds),
                   evidenceCount=len(evidence), conflictCount=len(conflicts), rdkitComponentCount=0, fallbackComponentCount=0)
    return output, summary


def perceive(request, structure, reject):
    atoms = structure['atoms']
    parameters = _empirical_parameters(request, reject)
    for key in ('charge', 'multiplicity'):
        value = structure.get(key)
        if value is not None and (not isinstance(value, int) or isinstance(value, bool) or key == 'multiplicity' and value < 1):
            reject('perception-electronic-state', 'Composite perception preserves valid integer electronic-state fields; it does not repair invalid protocol values.')
    if any(isinstance(a.get('formalCharge', 0), bool) for a in atoms) or any(isinstance(b.get(k), bool) for b in structure.get('bonds', []) for k in ('a', 'b', 'order')):
        reject('perception-protocol', 'Boolean atom charges or connection indices/orders are not valid chemical numbers.')
    evidence = _evidence(request, structure, reject)
    if evidence is not None:
        if parameters is not None:
            reject('perception-parameters', 'Empirical parameters cannot rewrite measured Mayer evidence.')
        return _mbo_perceive(structure, evidence, reject)
    table = Chem.GetPeriodicTable()
    radii = [table.GetRcovalent(table.GetAtomicNumber(a['element'])) for a in atoms]
    if any(not _finite(r) or r <= 0 for r in radii):
        reject('perception-radius', 'An element lacks a positive checked native covalent radius; no fallback radius was invented.')
    metal = {i for i, a in enumerate(atoms) if a['element'] in METALS}
    capacity = {i: _capacity(a) for i, a in enumerate(atoms) if i not in metal}
    candidates, coordination, conflicts, issues, weak = {}, {}, set(), {}, {}

    def issue(pair, kind, reason):
        issues[pair] = dict(atomIds=[atoms[i]['id'] for i in pair], kind=kind, reason=reason)
    distances = {}
    for a, b in itertools.combinations(range(len(atoms)), 2):
        pair = (a, b)
        distance = math.hypot(*(atoms[a][k]-atoms[b][k] for k in ('x', 'y', 'z')))
        if not math.isfinite(distance):
            reject('perception-coordinate-range', 'Finite input coordinates overflowed the pair-distance calculation; no bond candidates were accepted.')
        distances[pair] = distance
        override = None
        if parameters is not None:
            if any(atoms[i]['element'] in parameters['excludedElements'] for i in pair):
                continue
            override = next((entry for entry in parameters['pairOverrides'] if sorted(entry['elements']) == sorted(atoms[i]['element'] for i in pair)), None)
            lower = override['minDistance'] if override else max(.35, parameters['minDistanceFactor']*(radii[a]+radii[b]))
            upper = override['maxDistance'] if override else parameters['maxDistanceFactor']*(radii[a]+radii[b])
            if distance < lower or distance > upper:
                if distance < lower:
                    issue(pair, 'unresolved', 'Atom pair is below the explicitly selected empirical lower distance bound.')
                continue
        ratio = distance/(radii[a]+radii[b])
        bo = evidence.get(pair) if evidence is not None else None
        is_metal = a in metal or b in metal
        hydrogen = 'H' in (atoms[a]['element'], atoms[b]['element'])
        limit = 1.55 if is_metal or bo is not None else 1.28
        if hydrogen and not is_metal:
            limit = min(limit, 1.28)
        # MBO cannot turn a distant contact or near-coincidence into a bond.
        if parameters is None and (ratio < .55 or ratio > limit):
            if bo is not None:
                conflicts.add(pair)
            continue
        # User-approved observed/non-bond boundary for ordinary covalent
        # relations only. Sparse missing entries remain unknown; metal
        # coordination does not inherit this organic 0.5 cutoff.
        if not is_metal and bo is not None and bo < .5:
            conflicts.add(pair)
            continue
        score = 2*((1.30 if is_metal else 1.22)-ratio)+(min(1.7, .5*(math.log(bo)-math.log(.1))) if bo is not None else 0)
        if score <= 0 and parameters is None:
            if bo is not None:
                conflicts.add(pair)
            continue
        # Long reaction contacts should not consume a normal covalent valence
        # and force a distant carbonyl/ring to change order. Keep them as
        # explicit uncertainty annotations, outside the force-field graph.
        if not is_metal and not hydrogen and override is None and (parameters is None or parameters['bondOrderMode'] == 'auto-organic') and _stretched_contact(atoms, a, b, distance):
            conflicts.add(pair)
            weak[pair] = dict(distance=distance, score=score)
            issue(pair, 'weak-contact', 'Stretched distance-only contact was excluded from the ordinary covalent candidate; its reaction-state connectivity is uncertain.')
            continue
        target = coordination if is_metal else candidates
        target[pair] = dict(distance=distance, score=score, bo=bo, ratio=ratio)
    orders, used = {}, {i: 0 for i in capacity}
    # Reserve ordinary terminal-H covalent partners before heavy-atom order
    # assignment. This restriction never limits explicit metal bridge H.
    def rank(pair):
        a, b = pair
        bo = candidates[pair]['bo']
        # Observed evidence has priority; an absent sparse entry is still an
        # empirical candidate, not a zero-valued measurement.
        measured = (bo is None, -(bo if bo is not None else 0))
        h = a if atoms[a]['element'] == 'H' else b if atoms[b]['element'] == 'H' else None
        if h is not None:
            other = b if h == a else a
            target = H_SEEDS.get(atoms[other]['element'], radii[a]+radii[b])
            fit = abs(candidates[pair]['distance']-target)
            return (0, *measured, fit, -candidates[pair]['score'], atoms[a]['id'], atoms[b]['id'])
        return (1, *measured, 0, -candidates[pair]['score'], atoms[a]['id'], atoms[b]['id'])
    for pair in sorted(candidates, key=rank):
        a, b = pair
        if (parameters is None or parameters['bondOrderMode'] == 'auto-organic') and (used[a] >= capacity[a] or used[b] >= capacity[b]):
            conflicts.add(pair)
            issue(pair, 'partial', 'Competing distance-only contact was excluded to retain a valid ordinary covalent valence; this contact is not confirmed absent.')
            continue
        orders[pair] = 1
        used[a] += 1
        used[b] += 1

    def order_cost(pair, order):
        a, b = pair
        seeds = SEEDS.get(tuple(sorted((atoms[a]['element'], atoms[b]['element']))))
        target = seeds[int(order)-1] if seeds and order in (1, 2, 3) else (radii[a]+radii[b])*(1-.1332*math.log(order))
        if order == 1.5:
            target = .5*((seeds[0]+seeds[1]) if seeds else 2*(radii[a]+radii[b])*.92)
        value = ((distances[pair]-target)/.12)**2
        bo = candidates[pair]['bo']
        if bo is None:
            return value
        # For an observed ordinary organic pair, choose the closest supported
        # order subject to the covalent graph budget. Distance only breaks a
        # near-degenerate choice; it cannot outweigh clear near-2/near-3 MBO.
        # The original raw measurement is not clamped or written back.
        return (order-min(3., bo))**2+.05*min(1., value)

    # Bounded local order upgrades, with the whole covalent budget considered.
    while parameters is None or parameters['bondOrderMode'] == 'auto-organic':
        options = []
        for pair, order in orders.items():
            a, b = pair
            if order >= 3 or 'H' in (atoms[a]['element'], atoms[b]['element']) or used[a] >= capacity[a] or used[b] >= capacity[b]:
                continue
            improvement = order_cost(pair, order)-order_cost(pair, order+1)
            if improvement > .05:
                options.append((-improvement, pair))
        if not options:
            break
        _, pair = min(options)
        orders[pair] += 1
        for i in pair:
            used[i] += 1

    def measurement_compatible(proposal, baseline):
        # Every checked native result, including SanitizeMol-only fallbacks,
        # must pass this same gate. Sanitation can aromaticize Kekule bonds;
        # that representation change is not permission to override near-2 MBO.
        contradicted = {
            p for p, value in proposal.items()
            if candidates[p]['bo'] is not None and
            not (value == 1.5 and 1.25 <= candidates[p]['bo'] <= 1.75) and
            (value-min(3., candidates[p]['bo']))**2 >
            (baseline[p]-min(3., candidates[p]['bo']))**2+1e-9
        }
        conflicts.update(contradicted)
        return not contradicted

    native_count = fallback_count = 0
    for component in _components(capacity, orders):
        if parameters is not None and parameters['bondOrderMode'] == 'connectivity-only':
            continue
        local = {p: v for p, v in orders.items() if set(p) <= component}
        if not local:
            continue
        try:
            local = _recover_local_rings(atoms, component, local, order_cost)
            orders.update(local)
        except Exception:
            pass
        adopted = False
        if structure.get('charge') is not None and structure.get('multiplicity') is not None:
            try:
                mol, indices = _molecule(atoms, component, {p: 1 for p in local})
                rdDetermineBonds.DetermineBondOrders(mol, charge=sum(a.get('formalCharge', 0) for a in (atoms[i] for i in indices)),
                                                     allowChargedFragments=False, embedChiral=False, maxIterations=10000)
                proposal = _checked(mol, atoms, indices, local)
                # RDKit's consistency proposal is evidence, not an override of
                # distance/MBO. Very poor-fit high orders are not adopted.
                if (measurement_compatible(proposal, local) and
                        all(v == 1.5 or order_cost(p, v) <= order_cost(p, local[p])+.75 for p, v in proposal.items()) and
                        sum(order_cost(p, v) for p, v in proposal.items()) <= sum(order_cost(p, v) for p, v in local.items())+.75*len(local)):
                    for p, v in proposal.items():
                        if v != orders[p]:
                            conflicts.add(p)
                        orders[p] = v
                    adopted = True
            except Exception:
                pass
        if not adopted:
            # Even the geometry-only path uses fixed-charge native sanitation
            # to establish actual ring aromaticity, never an MBO range guess.
            try:
                mol, indices = _molecule(atoms, component, local)
                proposal = _checked(mol, atoms, indices, local)
                if measurement_compatible(proposal, local):
                    orders.update(proposal)
                    adopted = True
                # Successful sanitation established the local graph's validity.
                # A conflicting aromatic representation is not applied; retain
                # the budget-valid local orders rather than forcing all doubles.
            except Exception:
                # Repair only the atom neighbourhood identified by native
                # sanitation. An unrelated carbonyl or ring never becomes
                # all-single merely because another site failed.
                repaired = dict(local)
                for _ in range(2*len(local)):
                    mol, indices = _molecule(atoms, component, repaired)
                    affected = set()
                    for problem in Chem.DetectChemistryProblems(mol):
                        if hasattr(problem, 'GetAtomIdx'):
                            affected.add(indices[problem.GetAtomIdx()])
                        elif hasattr(problem, 'GetAtomIndices'):
                            affected.update(indices[i] for i in problem.GetAtomIndices())
                    choices = [p for p, value in repaired.items() if value > 1 and affected.intersection(p)]
                    if not choices:
                        break
                    pair = min(choices, key=lambda p: (order_cost(p, repaired[p]-1)-order_cost(p, repaired[p]), p))
                    repaired[pair] -= 1
                    conflicts.add(pair)
                    issue(pair, 'unresolved', 'A local multiple-bond assignment was reduced after native sanitation rejected its atom neighbourhood; unaffected functional groups were retained.')
                    try:
                        mol, indices = _molecule(atoms, component, repaired)
                        proposal = _checked(mol, atoms, indices, repaired)
                        orders.update(proposal)
                        adopted = True
                        break
                    except Exception:
                        pass
                if not adopted:
                    for pair in local:
                        if pair not in issues:
                            issue(pair, 'unresolved', 'This local component could not be fully validated; its distance-based orders are candidates only.')
        native_count += int(adopted)
        fallback_count += int(not adopted)

    if weak and structure.get('multiplicity') in (None, 1):
        orders, restored, radicals = _close_weak_contacts(atoms, capacity, orders, weak, capacity)
        for pair in restored:
            issue(pair, 'partial', 'A stretched distance-only contact was retained as a single bond to recover a fixed-charge closed-shell ordinary candidate; its reaction-state connectivity remains uncertain.')
        if radicals:
            for atom in radicals:
                anchor = next((p for p in sorted(weak) if atom in p), next((p for p in sorted(orders) if atom in p), None))
                if anchor:
                    issue(anchor, 'unresolved', 'The local candidate still contains unresolved radical valence at a source singlet site; ordinary force-field coverage does not confirm its electronic state.')

    bonds = [dict(a=a, b=b, order=order, **({'aromatic': True} if order == 1.5 else {})) for (a, b), order in sorted(orders.items())]
    if parameters is not None and parameters['bondOrderMode'] == 'connectivity-only':
        for bond in bonds:
            bond['orderKnown'] = False
            bond['perception'] = 'empirical-distance'
    elif parameters is not None:
        for bond in bonds:
            bond['perception'] = 'empirical-organic'
    organic_neighbours = {i: set() for i in range(len(atoms))}
    for a, b in orders:
        organic_neighbours[a].add(b)
        organic_neighbours[b].add(a)
    for pair, data in sorted(coordination.items(), key=lambda item: (item[1]['bo'] is None, -(item[1]['bo'] if item[1]['bo'] is not None else 0), -item[1]['score'], item[0])):
        a, b = pair
        if 'H' in (atoms[a]['element'], atoms[b]['element']):
            hydrogen = a if atoms[a]['element'] == 'H' else b
            if organic_neighbours[hydrogen] and (data['bo'] is None or data['bo'] < .25):
                conflicts.add(pair)
                continue
        # A weak outside ligand atom behind its nearer organic neighbour is a
        # second-shell contact, not an automatic extra coordination endpoint.
        shadowed = False
        for m, ligand in ((a, b), (b, a)):
            if m not in metal or ligand in metal:
                continue
            for neighbour in organic_neighbours[ligand]:
                prior = coordination.get(tuple(sorted((m, neighbour))))
                if not prior or prior['distance'] >= data['distance'] or prior['score'] <= data['score']:
                    continue
                u = [atoms[neighbour][k]-atoms[m][k] for k in ('x', 'y', 'z')]
                v = [atoms[ligand][k]-atoms[m][k] for k in ('x', 'y', 'z')]
                cosine = sum(x*y for x, y in zip(u, v))/(prior['distance']*data['distance'])
                if cosine > .85 and (data['bo'] is None or data['bo'] < .5):
                    shadowed = True
        if shadowed:
            conflicts.add(pair)
            continue
        bonds.append(dict(a=a, b=b, order=1, kind='coordination'))
    bonds.sort(key=lambda b: (b['a'], b['b']))
    output = copy.deepcopy(structure)
    output['bonds'] = bonds
    output['bondSource'] = 'inferred'
    output.pop('bondPerceptionIssues', None)
    merged_issues = _merge_perception_issues([issues[pair] for pair in sorted(issues)], short_hydrogen_contact_issues(output))
    if parameters is not None:
        excluded_ids = {atom['id'] for atom in atoms if atom['element'] in parameters['excludedElements']}
        merged_issues = [entry for entry in merged_issues if not excluded_ids.intersection(entry['atomIds'])]
    if merged_issues:
        output['bondPerceptionIssues'] = merged_issues
    method = 'gfn2-assisted' if evidence is not None else 'empirical'
    summary = dict(method=method, bondCount=len(bonds), coordinationCount=sum(b.get('kind') == 'coordination' for b in bonds),
                   evidenceCount=len(evidence) if evidence is not None else 0, conflictCount=len(conflicts),
                   rdkitComponentCount=native_count, fallbackComponentCount=fallback_count)
    output.setdefault('notes', []).append('Distance/RDKit bond candidates were locally reconciled; source atoms, coordinates, formal charges, total charge and multiplicity were retained. Weak or unresolved reaction contacts are annotated separately from ordinary covalent bonds; no force-field validity or transition-state preservation is implied.')
    return output, summary
