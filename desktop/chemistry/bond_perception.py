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
import heapq
import itertools
import math
from functools import cache

from rdkit import Chem
from rdkit.Chem import rdDetermineBonds, rdchem

try:
    import finite_empirical
except ModuleNotFoundError as error:
    # Some standalone callers load this module by file location.
    if error.name != 'finite_empirical':
        raise
    finite_empirical = None

METALS = set(('Li Be Na Mg Al K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn '
              'Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po '
              'Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv').split())
SEEDS = {('C', 'C'): (1.54, 1.34, 1.20), ('C', 'N'): (1.47, 1.29, 1.16),
         ('C', 'O'): (1.43, 1.23, 1.13), ('N', 'N'): (1.45, 1.25, 1.10),
         ('N', 'O'): (1.40, 1.21, 1.15), ('O', 'O'): (1.48, 1.21, 1.10)}
H_SEEDS = {'H': .74, 'C': 1.09, 'N': 1.01, 'O': .97, 'S': 1.34}
BOND_TYPES = {1: Chem.BondType.SINGLE, 2: Chem.BondType.DOUBLE, 3: Chem.BondType.TRIPLE, 1.5: Chem.BondType.AROMATIC}


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _neighbor_search(atoms, radius):
    """Conservative Cartesian search only. Callers keep the exact distance rules."""
    if len(atoms) < 48:
        return None
    points = [tuple(atom[axis] for axis in ('x', 'y', 'z')) for atom in atoms]
    # Preserve the checked original distance path for extreme finite input.
    # Even overflow in a pair that would not be a candidate must be detected.
    magnitude = max(abs(value) for point in points for value in point)
    if not math.isfinite(magnitude) or magnitude >= 1e12:
        return None
    # Pad the closed distance cutoff for cell-boundary arithmetic. A pair
    # within the cutoff must then be in the same or an adjacent bin in each axis.
    width = max(1.0, radius) + 16 * math.ulp(max(magnitude, radius, 1.0))
    bins = {}
    slots = []
    for i, point in enumerate(points):
        key = tuple(math.floor(axis / width) for axis in point)
        slots.append(key)
        bins.setdefault(key, []).append(i)

    neighbor_bins = {}

    def nearby(index):
        slot = slots[index]
        if slot not in neighbor_bins:
            x, y, z = slot
            indices = []
            for i in range(x - 1, x + 2):
                for j in range(y - 1, y + 2):
                    for k in range(z - 1, z + 2):
                        bucket = bins.get((i, j, k))
                        if bucket:
                            indices.extend(bucket)
            # Each atom appears in at most 27 cached neighbourhoods.
            neighbor_bins[slot] = sorted(indices)
        return neighbor_bins[slot]

    return nearby


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


def _capacity(element, formal_charge):
    # Only ordinary covalent atoms use RDKit's charged isoelectronic valences.
    # This function is never applied to a metal coordination endpoint.
    table = Chem.GetPeriodicTable()
    number = table.GetAtomicNumber(element)-formal_charge
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


def short_hydrogen_contact_issues(structure, nearby=None):
    """Geometry-only donor-H...acceptor annotations, never covalent edges.

    Each H needs one ordinary O/N/S donor. At most its two nearest additional
    O/N/S contacts survive the 1.6-radius-sum and >=120-degree angle bounds.
    These editor heuristics are neither measured fractional bonds nor TS proof.
    """
    atoms, bonds = structure['atoms'], structure.get('bonds', [])
    elements = [atom['element'] for atom in atoms]
    donor_elements = {'O', 'N', 'S'}
    if donor_elements.isdisjoint(elements):
        return []
    donors = {}
    existing = set()
    for bond in bonds:
        a, b = bond['a'], bond['b']
        first_h, second_h = elements[a] == 'H', elements[b] == 'H'
        if not first_h and not second_h:
            continue
        existing.add((a, b) if a < b else (b, a))
        if bond.get('kind') == 'coordination' or bond.get('fractional'):
            continue
        if first_h:
            donors[a] = None if a in donors else b
        if second_h:
            donors[b] = None if b in donors else a
    table = Chem.GetPeriodicTable()
    acceptor_radii = {element: table.GetRcovalent(1) + table.GetRcovalent(table.GetAtomicNumber(element))
                      for element in donor_elements}
    issues = []
    for h, donor in sorted(donors.items()):
        if donor is None or elements[donor] not in donor_elements:
            continue
        possible = [i for i in (nearby(h) if nearby is not None else range(len(atoms)))
                    if i != donor and elements[i] in donor_elements]
        if not possible:
            continue
        atom = atoms[h]
        u = [atoms[donor][k]-atom[k] for k in ('x', 'y', 'z')]
        donor_distance = math.hypot(*u)
        if not math.isfinite(donor_distance) or donor_distance <= 1e-8:
            continue
        contacts = []
        for acceptor in possible:
            other = atoms[acceptor]
            pair = (h, acceptor) if h < acceptor else (acceptor, h)
            if pair in existing:
                continue
            v = [other[k]-atom[k] for k in ('x', 'y', 'z')]
            distance = math.hypot(*v)
            radius_sum = acceptor_radii[elements[acceptor]]
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


def _molecule(atoms, indices, orders, *, coordinates=True):
    indices = sorted(indices)
    mapping = {old: new for new, old in enumerate(indices)}
    rw = Chem.RWMol()
    conf = Chem.Conformer(len(indices)) if coordinates else None
    if conf is not None:
        conf.Set3D(True)
    for old in indices:
        item = atoms[old]
        atom = Chem.Atom(item['element'])
        atom.SetFormalCharge(item.get('formalCharge', 0))
        atom.SetNoImplicit(True)
        atom.SetProp('_StableId', item['id'])
        new = rw.AddAtom(atom)
        if conf is not None:
            conf.SetAtomPosition(new, (item['x'], item['y'], item['z']))
    for (a, b), order in sorted(orders.items()):
        if a not in mapping or b not in mapping:
            continue
        rw.AddBond(mapping[a], mapping[b], BOND_TYPES[order])
        if order == 1.5:
            rw.GetBondBetweenAtoms(mapping[a], mapping[b]).SetIsAromatic(True)
            rw.GetAtomWithIdx(mapping[a]).SetIsAromatic(True)
            rw.GetAtomWithIdx(mapping[b]).SetIsAromatic(True)
    mol = rw.GetMol()
    if conf is not None:
        mol.AddConformer(conf)
    mol.UpdatePropertyCache(strict=False)
    return mol, indices


def _checked(mol, atoms, indices, edge_keys, *, coordinates=True):
    # The detached graph-only callers supply a fresh molecule that can be
    # sanitized in place. They have no coordinate-dependent native stage.
    probe = Chem.Mol(mol) if coordinates else mol
    Chem.SanitizeMol(probe)
    if probe.GetNumAtoms() != len(indices):
        raise ValueError('atom count')
    conformation = probe.GetConformer() if coordinates else None
    for i, atom in enumerate(probe.GetAtoms()):
        source = atoms[indices[i]]
        if (atom.GetProp('_StableId') != source['id'] or atom.GetSymbol() != source['element']
                or atom.GetFormalCharge() != source.get('formalCharge', 0) or not atom.GetNoImplicit()
                or atom.GetNumImplicitHs() or atom.GetNumExplicitHs()):
            raise ValueError('chemical identity change')
        if conformation is not None:
            point = conformation.GetAtomPosition(i)
            if (point.x, point.y, point.z) != (source['x'], source['y'], source['z']):
                raise ValueError('coordinate change')
    orders = {tuple(sorted((indices[b.GetBeginAtomIdx()], indices[b.GetEndAtomIdx()]))):
              1.5 if b.GetIsAromatic() else b.GetBondTypeAsDouble() for b in probe.GetBonds()}
    if set(orders) != set(edge_keys) or any(order not in (1, 1.5, 2, 3) for order in orders.values()):
        raise ValueError('edge change')
    return orders


def _ordered_components(orders):
    """Group each edge once; retain the original order within each component."""
    adjacency = {}
    for a, b in orders:
        adjacency.setdefault(a, []).append(b)
        adjacency.setdefault(b, []).append(a)
    by_atom, components = {}, []
    for root in sorted(adjacency):
        if root in by_atom:
            continue
        component, local = [], {}
        components.append((component, local))
        by_atom[root] = local
        pending = [root]
        while pending:
            i = pending.pop()
            component.append(i)
            for j in adjacency[i]:
                if j not in by_atom:
                    by_atom[j] = local
                    pending.append(j)
    for pair, order in orders.items():
        by_atom[pair[0]][pair] = order
    return components


def _quantize_mbo(value):
    # The sequence makes every exact midpoint choose the lower order.
    for upper, order in ((.25, 0), (.75, .5), (1.25, 1), (1.75, 1.5), (2.5, 2)):
        if value <= upper:
            return order
    return 3


def _recover_local_rings(atoms, component, orders, order_cost, session=None):
    """Try bounded Kekule alternatives; only native-confirmed rings survive.

    A greedy distance upgrade can select one central double instead of two
    alternating doubles. Enumerating a five/six-membered local ring prevents
    an unrelated failed assignment from permanently erasing that aromaticity.
    No aromatic flags are accepted without sanitizing the full fixed graph.
    """
    if len(orders) == len(component) - 1:
        return orders
    def find_rings():
        mol, indices = _molecule(atoms, component, orders, coordinates=session is None)
        return tuple(tuple(indices[i] for i in ring) for ring in Chem.GetSymmSSSR(mol) if 5 <= len(ring) <= 6)

    rings = session.graph('rings', component, orders, find_rings) if session else find_rings()
    recovered = dict(orders)
    for ring in rings:
        pairs = {tuple(sorted((ring[i], ring[(i+1) % len(ring)]))) for i in range(len(ring))}
        if all(recovered[p] == 1.5 for p in pairs):
            continue

        def viable_trials():
            candidates = []
            deterministic = True
            for doubles in itertools.combinations(sorted(pairs), len(ring)//2):
                if any(sum(i in p for p in doubles) > 1 for i in ring):
                    continue
                trial = dict(recovered)
                trial.update({p: 2 if p in doubles else 1 for p in pairs})
                try:
                    proposal = _sanitize_graph(atoms, component, trial, coordinates=session is None)
                except rdchem.MolSanitizeException:
                    continue
                except Exception:
                    deterministic = False
                    continue
                if (all(proposal[p] == 1.5 for p in pairs)
                        and not any(proposal[p] != recovered[p] and proposal[p] != 1.5 for p in proposal if p not in pairs)):
                    candidates.append(proposal)
            if session and not deterministic:
                # Source-independent memoization must not retain a partial
                # trial inventory produced by an unexpected native failure.
                raise _UncachedRingTrials(tuple(candidates))
            return tuple(candidates)

        try:
            proposals = session.graph('trial', component, recovered, viable_trials, ring=ring) if session else viable_trials()
        except _UncachedRingTrials as incomplete:
            proposals = incomplete.args[0]
        alternatives = []
        if proposals:
            limit = sum(order_cost(p, value) for p, value in recovered.items())+.75*len(pairs)
            for proposal in proposals:
                cost = sum(order_cost(p, value) for p, value in proposal.items())
                if cost <= limit:
                    alternatives.append((cost, tuple(sorted(proposal.items())), proposal))
        if alternatives:
            recovered = min(alternatives, key=lambda item: item[:2])[2]
    return recovered


class _UncachedRingTrials(Exception):
    pass


def _sanitize_graph(atoms, component, orders, *, coordinates=True):
    mol, indices = _molecule(atoms, component, orders, coordinates=coordinates)
    return _checked(mol, atoms, indices, orders, coordinates=coordinates)


def _native_graph_proposal(atoms, component, orders, *, session=None):
    def determine():
        if session:
            unchanged = finite_empirical.unchanged_hydrocarbon_tree(atoms, component, orders)
            if unchanged is not None:
                return unchanged
        mol, indices = _molecule(atoms, component, dict.fromkeys(orders, 1), coordinates=session is None)
        rdDetermineBonds.DetermineBondOrders(mol, charge=sum(atoms[i].get('formalCharge', 0) for i in indices),
                                             allowChargedFragments=False, embedChiral=False, maxIterations=10000)
        return _checked(mol, atoms, indices, orders, coordinates=session is None)

    return session.graph('native', component, orders, determine, negative=(rdchem.MolSanitizeException,)) if session else determine()


def _chemistry_problem_atoms(atoms, component, orders, *, coordinates=True):
    mol, indices = _molecule(atoms, component, orders, coordinates=coordinates)
    affected = set()
    for problem in Chem.DetectChemistryProblems(mol):
        if hasattr(problem, 'GetAtomIdx'):
            affected.add(indices[problem.GetAtomIdx()])
        elif hasattr(problem, 'GetAtomIndices'):
            affected.update(indices[i] for i in problem.GetAtomIndices())
    return tuple(sorted(affected))


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
    valence = dict.fromkeys(capacity, 0)
    for (a, b), order in baseline.items():
        valence[a] += order
        valence[b] += order
    for size in range(1, len(candidates)+1):
        for subset in itertools.combinations(candidates, size):
            additions = {}
            for a, b in subset:
                additions[a] = additions.get(a, 0) + 1
                additions[b] = additions.get(b, 0) + 1
            if any(valence[i]+count > capacity[i] for i, count in additions.items()):
                continue
            trial = dict(baseline)
            trial.update(dict.fromkeys(subset, 1))
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
        # Future subsets are larger and cannot beat a zero-radical winner.
        if rank[0] == 0:
            break
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

    search_radius = 1.55 * (max(radius(i) for i in metal) + max(radius(i) for i in range(len(atoms)))) if metal and len(atoms) > 1 else 0.
    nearby = _neighbor_search(atoms, search_radius)
    if nearby is None:
        pairs = itertools.combinations(range(len(atoms)), 2)
    else:
        candidates = set(evidence)
        for i in metal:
            candidates.update((min(i, j), max(i, j)) for j in nearby(i) if j != i)
        pairs = sorted(candidates)
    for a, b in pairs:
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


def perceive(request, structure, reject, *, session=None):
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
    if parameters is not None:
        session = None
    if session is not None:
        session.bind(atoms)
    table = Chem.GetPeriodicTable()
    elements = [atom['element'] for atom in atoms]
    radii_by_element = {element: table.GetRcovalent(table.GetAtomicNumber(element)) for element in dict.fromkeys(elements)}
    if any(not _finite(r) or r <= 0 for r in radii_by_element.values()):
        reject('perception-radius', 'An element lacks a positive checked native covalent radius; no fallback radius was invented.')
    radii = [radii_by_element[element] for element in elements]
    metal = {i for i, element in enumerate(elements) if element in METALS}
    covalent_types = {i: (element, atoms[i].get('formalCharge', 0)) for i, element in enumerate(elements) if i not in metal}
    capacity_by_type = {kind: _capacity(*kind) for kind in dict.fromkeys(covalent_types.values())}
    capacity = {i: capacity_by_type[kind] for i, kind in covalent_types.items()}
    labels = [atom['id'] for atom in atoms]
    positions = [(atom['x'], atom['y'], atom['z']) for atom in atoms]
    hydrogens = [element == 'H' for element in elements]
    pair_targets = {}
    for left in radii_by_element:
        for right in radii_by_element:
            seeds = SEEDS.get(tuple(sorted((left, right))))
            pair_radius = radii_by_element[left] + radii_by_element[right]
            targets = seeds or tuple(pair_radius*(1-.1332*math.log(order)) for order in (1, 2, 3))
            aromatic_target = .5*((seeds[0]+seeds[1]) if seeds else 2*pair_radius*.92)
            stretched = max(seeds[0]*1.10, seeds[0]+.12) if seeds else math.inf
            pair_targets[left, right] = (targets, aromatic_target, stretched)
    candidates, coordination, conflicts, issues, weak = {}, {}, set(), {}, {}

    def issue(pair, kind, reason):
        issues[pair] = dict(atomIds=[atoms[i]['id'] for i in pair], kind=kind, reason=reason)
    overrides = {} if parameters is None else {tuple(sorted(entry['elements'])): entry for entry in parameters['pairOverrides']}
    excluded = set() if parameters is None else set(parameters['excludedElements'])
    # This covers the largest donor-H contact search (1.6 times a radii
    # sum) and the default covalent/metal cutoffs; include any user extension.
    max_radius_sum = 2 * max(radii, default=0.)
    search_radius = 1.6 * max_radius_sum
    if parameters is not None:
        search_radius = max(search_radius, parameters['maxDistanceFactor'] * max_radius_sum,
                            max((entry['maxDistance'] for entry in overrides.values()), default=0.))
    rows = session.neighbor_rows(positions, radii, [i in metal for i in range(len(atoms))],
                                hydrogens, [element in ('O', 'N', 'S') for element in elements], search_radius) if session else None
    nearby = rows.__getitem__ if rows is not None else _neighbor_search(atoms, search_radius)
    accel = finite_empirical.accelerator if session else None

    def register_weak(pair, distance, score):
        conflicts.add(pair)
        weak[pair] = dict(distance=distance, score=score)
        issue(pair, 'weak-contact', 'Stretched distance-only contact was excluded from the ordinary covalent candidate; its reaction-state connectivity is uncertain.')

    if accel is not None and rows is not None:
        numbers = {symbol: i for i, symbol in enumerate(radii_by_element)}
        atom_types = [(numbers[element], i in metal, hydrogens[i]) for i, element in enumerate(elements)]
        stretched_limits = tuple(tuple(pair_targets[a, b][2] for b in numbers) for a in numbers)
        candidates, coordination, stretches = accel.measure(positions, rows, radii, atom_types, stretched_limits, math.hypot)
        for pair, (distance, score) in stretches.items():
            register_weak(pair, distance, score)
    else:
        if nearby is None:
            pairs = itertools.combinations(range(len(atoms)), 2)
        else:
            pairs = ((a, b) for a in range(len(atoms)) for b in nearby(a) if b > a)
        for a, b in pairs:
            pair = (a, b)
            ax, ay, az = positions[a]
            bx, by, bz = positions[b]
            distance = math.hypot(ax-bx, ay-by, az-bz)
            if not math.isfinite(distance):
                reject('perception-coordinate-range', 'Finite input coordinates overflowed the pair-distance calculation; no bond candidates were accepted.')
            override = None
            radius_sum = radii[a]+radii[b]
            if parameters is not None:
                if elements[a] in excluded or elements[b] in excluded:
                    continue
                override = overrides.get(tuple(sorted((elements[a], elements[b]))))
                lower = override['minDistance'] if override else max(.35, parameters['minDistanceFactor']*radius_sum)
                upper = override['maxDistance'] if override else parameters['maxDistanceFactor']*radius_sum
                if distance < lower or distance > upper:
                    if distance < lower:
                        issue(pair, 'unresolved', 'Atom pair is below the explicitly selected empirical lower distance bound.')
                    continue
            ratio = distance/radius_sum
            is_metal = a in metal or b in metal
            limit = 1.55 if is_metal else 1.28
            score = 2*((1.30 if is_metal else 1.22)-ratio)
            if parameters is None and (ratio < .55 or ratio > limit or score <= 0):
                continue
            if (not is_metal and not (hydrogens[a] or hydrogens[b]) and override is None
                    and (parameters is None or parameters['bondOrderMode'] == 'auto-organic')
                    and distance > pair_targets[elements[a], elements[b]][2]):
                register_weak(pair, distance, score)
                continue
            target = coordination if is_metal else candidates
            target[pair] = (distance, score)
    orders, used = {}, {i: 0 for i in capacity}
    # Reserve ordinary terminal-H covalent partners before heavy-atom order
    # assignment. This restriction never limits explicit metal bridge H.
    def rank(pair):
        a, b = pair
        distance, score = candidates[pair]
        if hydrogens[a] or hydrogens[b]:
            other = b if hydrogens[a] else a
            target = H_SEEDS.get(elements[other], radii[a]+radii[b])
            return (0, abs(distance-target), -score, labels[a], labels[b])
        return (1, 0, -score, labels[a], labels[b])

    for pair in sorted(candidates, key=rank):
        a, b = pair
        if (parameters is None or parameters['bondOrderMode'] == 'auto-organic') and (used[a] >= capacity[a] or used[b] >= capacity[b]):
            conflicts.add(pair)
            issue(pair, 'partial', 'Competing distance-only contact was excluded to retain a valid ordinary covalent valence; this contact is not confirmed absent.')
            continue
        orders[pair] = 1
        used[a] += 1
        used[b] += 1

    @cache
    def order_cost(pair, order):
        a, b = pair
        targets, aromatic_target, _ = pair_targets[elements[a], elements[b]]
        target = aromatic_target if order == 1.5 else targets[int(order)-1]
        return ((candidates[pair][0]-target)/.12)**2

    # Bounded local order upgrades, with the whole covalent budget considered.
    def upgrade(pair, order):
        a, b = pair
        if order >= 3 or hydrogens[a] or hydrogens[b] or used[a] >= capacity[a] or used[b] >= capacity[b]:
            return None
        improvement = order_cost(pair, order)-order_cost(pair, order+1)
        return (-improvement, pair) if improvement > .05 else None

    auto_order = parameters is None or parameters['bondOrderMode'] == 'auto-organic'
    if auto_order:
        options = []
        for pair, order in orders.items():
            option = upgrade(pair, order)
            if option is not None:
                options.append(option)
        heapq.heapify(options)
        # Priorities change only for the chosen pair. Other pairs can become
        # ineligible as their endpoint budgets are exhausted.
        while options:
            _, pair = heapq.heappop(options)
            a, b = pair
            if used[a] >= capacity[a] or used[b] >= capacity[b]:
                continue
            orders[pair] += 1
            used[a] += 1
            used[b] += 1
            option = upgrade(pair, orders[pair])
            if option is not None:
                heapq.heappush(options, option)

    native_count = fallback_count = 0
    components = (accel.components(len(atoms), orders) if accel else _ordered_components(orders)) if auto_order else ()
    for component, local in components:
        try:
            local = _recover_local_rings(atoms, component, local, order_cost, session)
            orders.update(local)
        except Exception:
            pass
        adopted = False
        if structure.get('charge') is not None and structure.get('multiplicity') is not None:
            try:
                proposal = _native_graph_proposal(atoms, component, local, session=session)
                # RDKit's consistency proposal is evidence, not an override of
                # distance/MBO. Very poor-fit high orders are not adopted.
                if (all(v == 1.5 or order_cost(p, v) <= order_cost(p, local[p])+.75 for p, v in proposal.items()) and
                        sum(order_cost(p, v) for p, v in proposal.items()) <= sum(order_cost(p, v) for p, v in local.items())+.75*len(local)):
                    for p, v in proposal.items():
                        if v != orders[p]:
                            conflicts.add(p)
                        orders[p] = v
                    adopted = True
            except Exception:
                pass
        def sanitize(edge_orders):
            def check():
                return _sanitize_graph(atoms, component, edge_orders, coordinates=session is None)
            if session:
                return session.graph('sanitize', component, edge_orders, check, negative=(rdchem.MolSanitizeException,))
            return check()

        if not adopted:
            # Even the geometry-only path uses fixed-charge native sanitation
            # to establish actual ring aromaticity, never an MBO range guess.
            try:
                proposal = sanitize(local)
                orders.update(proposal)
                adopted = True
            except Exception:
                # Repair only the atom neighbourhood identified by native
                # sanitation. An unrelated carbonyl or ring never becomes
                # all-single merely because another site failed.
                repaired = dict(local)
                for _ in range(2*len(local)):
                    def find_problems():
                        return _chemistry_problem_atoms(atoms, component, repaired, coordinates=session is None)
                    affected = session.graph('problem', component, repaired, find_problems) if session else find_problems()
                    choices = [p for p, value in repaired.items() if value > 1 and affected.intersection(p)]
                    if not choices:
                        break
                    pair = min(choices, key=lambda p: (order_cost(p, repaired[p]-1)-order_cost(p, repaired[p]), p))
                    repaired[pair] -= 1
                    conflicts.add(pair)
                    issue(pair, 'unresolved', 'A local multiple-bond assignment was reduced after native sanitation rejected its atom neighbourhood; unaffected functional groups were retained.')
                    try:
                        proposal = sanitize(repaired)
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
        closure = session.close_neutral_forest(orders, weak, capacity) if session else None
        orders, restored, radicals = closure if closure is not None else _close_weak_contacts(atoms, capacity, orders, weak, capacity)
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
    for pair, data in sorted(coordination.items(), key=lambda item: (-item[1][1], item[0])):
        a, b = pair
        if hydrogens[a] or hydrogens[b]:
            hydrogen = a if hydrogens[a] else b
            if organic_neighbours[hydrogen]:
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
                if not prior or prior[0] >= data[0] or prior[1] <= data[1]:
                    continue
                u = [atoms[neighbour][k]-atoms[m][k] for k in ('x', 'y', 'z')]
                v = [atoms[ligand][k]-atoms[m][k] for k in ('x', 'y', 'z')]
                cosine = sum(x*y for x, y in zip(u, v))/(prior[0]*data[0])
                if cosine > .85:
                    shadowed = True
        if shadowed:
            conflicts.add(pair)
            continue
        bonds.append(dict(a=a, b=b, order=1, kind='coordination'))
    bonds.sort(key=lambda b: (b['a'], b['b']))
    # Do not copy an old graph just to replace it. Flat protocol atom records
    # are cheap to detach, while any extension data keeps deep-copy semantics.
    atomic_types = (str, int, float, bool, type(None))
    output = {key: copy.deepcopy(value) for key, value in structure.items()
              if key not in ('atoms', 'bonds', 'bondPerceptionIssues')}
    output['atoms'] = (accel.copy_atoms(atoms, copy.deepcopy) if accel else
                       [dict(atom) if all(type(value) in atomic_types for value in atom.values())
                        else copy.deepcopy(atom) for atom in atoms])
    output['bonds'] = bonds
    output['bondSource'] = 'inferred'
    merged_issues = _merge_perception_issues([issues[pair] for pair in sorted(issues)], short_hydrogen_contact_issues(output, nearby))
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
