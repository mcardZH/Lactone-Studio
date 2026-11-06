"""Explicit local geometry repair coupled to the original retained UFF terms.

This is an editor preoptimization objective, never an MD molecular potential.
RDKit 2025.03.6's UFF builder skips unavailable parameter-dependent terms;
its Python wrapper directly constructs that same field without `foundAll`.
https://github.com/rdkit/rdkit/blob/Release_2025_03_6/Code/GraphMol/ForceFieldHelpers/UFF/Builder.cpp
https://github.com/rdkit/rdkit/blob/Release_2025_03_6/Code/GraphMol/ForceFieldHelpers/Wrap/rdForceFields.cpp

The regions overlap at trustworthy boundary contributions. No atom types,
charges, hydrogens, edges or native UFF formulas are invented or replaced.
Failed-sanitization cache state is NEVER passed into the UFF builder. A fresh
selectively initialized graph supplies native types. Untrusted atoms receive an
adapter-only atomic-number-zero/null-parameter mask, never chemical caps or
invented parameters. Retained native type and term queries must be unchanged.
The public structure never receives the mask. Explicitly authorized geometry-only
fallback is possible only without any trustworthy native UFF contribution.
"""
from __future__ import annotations

import copy
import itertools
import math

import numpy as np

import engine
import geometry_clean

SCALE_POLICY = 'uff-bond-stiffness-v1'


def _components(adjacency):
    remaining = set(range(len(adjacency)))
    result = []
    while remaining:
        start = min(remaining)
        component, pending = set(), [start]
        while pending:
            node = pending.pop()
            if node in component:
                continue
            component.add(node)
            pending.extend(adjacency[node]-component)
        remaining -= component
        result.append(component)
    return result


def _ring_blocks(adjacency):
    """Topological cyclic biconnected blocks; no chemistry cache is involved."""
    discovery, low, edge_stack, blocks = {}, {}, [], []

    def visit(node, parent=None):
        discovery[node] = low[node] = len(discovery)
        for neighbour in sorted(adjacency[node]):
            if neighbour == parent:
                continue
            if neighbour not in discovery:
                edge_stack.append((node, neighbour))
                visit(neighbour, node)
                low[node] = min(low[node], low[neighbour])
                if low[neighbour] >= discovery[node]:
                    edges = []
                    while edge_stack:
                        edge = edge_stack.pop()
                        edges.append(edge)
                        if edge == (node, neighbour):
                            break
                    atoms = {i for edge in edges for i in edge}
                    if len(edges) >= len(atoms) and len(atoms) >= 3:
                        blocks.append(atoms)
            elif discovery[neighbour] < discovery[node]:
                edge_stack.append((node, neighbour))
                low[node] = min(low[node], discovery[neighbour])

    for node in range(len(adjacency)):
        if node not in discovery:
            visit(node)
    return blocks


def _part_structure(structure, indices):
    """Exact original component, with index-only edge remapping and no caps."""
    indices = sorted(indices)
    mapping = {old: new for new, old in enumerate(indices)}
    result = copy.deepcopy(structure)
    result['atoms'] = [copy.deepcopy(structure['atoms'][i]) for i in indices]
    result['bonds'] = [dict(copy.deepcopy(bond), a=mapping[bond['a']], b=mapping[bond['b']])
                       for bond in structure.get('bonds', [])
                       if bond['a'] in mapping and bond['b'] in mapping]
    # A component does not inherit a whole-model total charge or spin. Its
    # explicit formal charges remain exact; no charge distribution is assigned.
    result['charge'] = None
    result['multiplicity'] = None
    result.pop('molfile', None)
    return result


def _chemical_signature(mol):
    atoms = [(a.GetProp('_StableId'), a.GetAtomicNum(), a.GetFormalCharge(), a.GetNoImplicit(),
              a.GetNumExplicitHs(), a.GetNumImplicitHs()) for a in mol.GetAtoms()]
    bonds = sorted((min(b.GetBeginAtomIdx(), b.GetEndAtomIdx()), max(b.GetBeginAtomIdx(), b.GetEndAtomIdx()),
                    b.GetBondTypeAsDouble(), b.GetIsAromatic()) for b in mol.GetBonds())
    return atoms, bonds


def _unchanged_molecule(structure):
    """Prove sanitize did not clean up charges/edges behind the public graph."""
    raw = engine.molecule(structure, sanitize=False)
    initial_atoms, initial_bonds = _chemical_signature(raw)
    mol = engine.molecule(structure)
    final_atoms, final_bonds = _chemical_signature(mol)
    if initial_atoms != final_atoms:
        engine.reject('hybrid-chemistry-change', 'Native sanitization would change an explicit atom charge, identity or hydrogen state; partial UFF was not built for a different chemical graph.')
    if initial_bonds != final_bonds:
        # Aromatic and Kekule drawings may be equivalent. Normalize only those
        # representations on separate copies, never run chemical CLEANUP.
        before, after = engine.Chem.Mol(raw), engine.Chem.Mol(mol)
        flags = (engine.Chem.SanitizeFlags.SANITIZE_SYMMRINGS | engine.Chem.SanitizeFlags.SANITIZE_KEKULIZE |
                 engine.Chem.SanitizeFlags.SANITIZE_SETAROMATICITY)
        try:
            engine.Chem.SanitizeMol(before, sanitizeOps=flags)
            engine.Chem.SanitizeMol(after, sanitizeOps=flags)
            equivalent = _chemical_signature(before) == _chemical_signature(after)
        except Exception:
            equivalent = False
        if not equivalent:
            engine.reject('hybrid-chemistry-change', 'Native sanitization would rewrite explicit bonds beyond an equivalent aromatic/Kekule representation; the original graph was retained without partial UFF.')
    return mol


def _native_query(mol, name, indices):
    value = getattr(engine.AllChem, name)(mol, *indices)
    if value is not None:
        numbers = value if isinstance(value, tuple) else (value,)
        if not all(math.isfinite(float(number)) for number in numbers):
            engine.reject('hybrid-nonfinite', 'A native UFF parameter query returned a nonfinite value.')
    return value


def _term_inventory(mol, *, budget=None):
    """Native query keys with the actual builder's topological eligibility.

    Torsions depend on typed middle atoms and SP2 flags on the ends; inversions
    do not consult the type vector, and depend on center identity/SP2-O ends.
    Hence their complete queries, not just vdW type checks, are audited below.
    This inventories native contributions; it does not implement their formulas.
    """
    adjacency = [{a.GetIdx() for a in atom.GetNeighbors()} for atom in mol.GetAtoms()]
    terms = []
    attempted = 0

    def reserve():
        nonlocal attempted
        if budget is not None and attempted >= budget:
            engine.reject('hybrid-complexity', 'The explicit graph exceeds the bounded native parameter-audit budget.')
        attempted += 1

    def add(name, indices, dependencies):
        reserve()
        terms.append((name, indices, dependencies))

    for i in range(mol.GetNumAtoms()):
        add('GetUFFVdWParams', (i, i), {i})
    for bond in mol.GetBonds():
        a, b = bond.GetBeginAtomIdx(), bond.GetEndAtomIdx()
        add('GetUFFBondStretchParams', (a, b), {a, b})
        # Builder.cpp DefaultTorsionBondSmarts excludes centers in triple bonds.
        if all(len(adjacency[i]) > 1 and not any(edge.GetBondTypeAsDouble() == 3 for edge in mol.GetAtomWithIdx(i).GetBonds()) for i in (a, b)):
            for left in sorted(adjacency[a]-{b}):
                for right in sorted(adjacency[b]-{a, left}):
                    add('GetUFFTorsionParams', (left, a, b, right), {a, b})
    for center, neighbours in enumerate(adjacency):
        for a, b in itertools.combinations(sorted(neighbours), 2):
            add('GetUFFAngleBendParams', (a, center, b), {a, center, b})
        if len(neighbours) == 3:
            a, b, c = sorted(neighbours)
            # Three native inversion contributions, one for each out-of-plane
            # neighbour, rather than an invented inversion/torsion formula.
            for x, y, z in ((a, b, c), (a, c, b), (b, a, c)):
                add('GetUFFInversionParams', (x, center, y, z), {center})
    for a, b in itertools.combinations(range(mol.GetNumAtoms()), 2):
        if b not in adjacency[a] and not adjacency[a] & adjacency[b]:
            # Count every query attempt before calling native code, including
            # None/out-of-threshold results that never enter the inventory.
            reserve()
            value = _native_query(mol, 'GetUFFVdWParams', (a, b))
            if value is not None and np.linalg.norm(np.asarray(mol.GetConformer().GetAtomPosition(a))-np.asarray(mol.GetConformer().GetAtomPosition(b))) < 1e6*float(value[0]):
                terms.append(('GetUFFVdWParams', (a, b), {a, b}))
    return terms


def _fresh_initialized(structure):
    """Initialize without strict valence/CLEANUP, never a failed sanitize cache."""
    mol = engine.molecule(structure, sanitize=False)
    original = _chemical_signature(mol)
    flags = engine.Chem.SanitizeFlags
    # A single native selective pass preserves the ring cache through the later
    # stages: separate SanitizeMol calls clear earlier computed properties.
    trial = engine.Chem.Mol(mol)
    stages = flags.SANITIZE_SYMMRINGS | flags.SANITIZE_FINDRADICALS | flags.SANITIZE_SETCONJUGATION | flags.SANITIZE_SETHYBRIDIZATION
    try:
        engine.Chem.SanitizeMol(trial, sanitizeOps=stages)
    except Exception:
        engine.reject('hybrid-typing-isolation', 'Native selective chemistry initialization could not establish trustworthy UFF types; no failed sanitization cache was reused.')
    if _chemical_signature(trial) != original:
        engine.reject('hybrid-chemistry-change', 'Selective initialization changed explicit chemistry; no altered chemical model was used.')
    return trial


def _mask_typing(initialized, roots, structure):
    """Adapter-only null parameter mask with fixed-point native term auditing."""
    excluded = set(roots)
    reasons = {i: ['native-problem-or-missing-type'] for i in excluded}
    terms = _term_inventory(initialized)
    before = {(name, indices): _native_query(initialized, name, indices) for name, indices, _ in terms}
    # Invalid aromatic or conjugated chemistry has nonlocal typing dependencies.
    # Expand along those dependencies, without swallowing saturated branches.
    changed = True
    while changed:
        changed = False
        for bond in initialized.GetBonds():
            endpoints = {bond.GetBeginAtomIdx(), bond.GetEndAtomIdx()}
            if endpoints & excluded and (bond.GetIsAromatic() or bond.GetIsConjugated()) and not endpoints <= excluded:
                for i in endpoints-excluded:
                    reasons.setdefault(i, []).append('aromatic-or-conjugated-dependency')
                excluded.update(endpoints)
                changed = True
    for _ in range(initialized.GetNumAtoms()+1):
        work = engine.Chem.Mol(initialized)
        for i in excluded:
            atom = work.GetAtomWithIdx(i)
            atom.SetAtomicNum(0)
            atom.SetHybridization(engine.Chem.HybridizationType.UNSPECIFIED)
            # This is a null-parameter marker, never sanitized as another
            # chemical molecule and never passed into a returned structure.
        # SetAtomicNum invalidates RDKit's ring cache. Rebuild only graph rings,
        # never chemical sanitization, and prove the unchanged ring topology.
        engine.Chem.GetSymmSSSR(work)
        if sorted(map(sorted, work.GetRingInfo().AtomRings())) != sorted(map(sorted, initialized.GetRingInfo().AtomRings())):
            engine.reject('hybrid-graph-change', 'The adapter null mask changed native ring topology.')
        added = set()
        affected = []
        coverage = {}
        for name, indices, typed_dependencies in terms:
            if typed_dependencies & excluded:
                continue
            value = _native_query(work, name, indices)
            if value != before[(name, indices)]:
                affected.append((name, typed_dependencies))
            elif value is not None:
                coverage[(name, indices)] = value
        # A changed torsion needs *one* untyped middle atom to be suppressed.
        # First apply unavoidable atom/inversion-center exclusions. Then choose
        # a nearby shared torsion center, rather than masking both middle atoms
        # and needlessly propagating mechanics down an otherwise healthy chain.
        for name, dependencies in affected:
            if name != 'GetUFFTorsionParams':
                added.update(dependencies)
                for i in dependencies:
                    reasons.setdefault(i, []).append(name+'-changed-after-mask')
        distances = {i: 0 for i in excluded}
        pending = list(sorted(excluded))
        for i in pending:
            for neighbour in initialized.GetAtomWithIdx(i).GetNeighbors():
                j = neighbour.GetIdx()
                if j not in distances:
                    distances[j] = distances[i]+1
                    pending.append(j)
        torsions = [dependencies for name, dependencies in affected if name == 'GetUFFTorsionParams']
        while any(not dependencies & added for dependencies in torsions):
            uncovered = [dependencies for dependencies in torsions if not dependencies & added]
            candidates = set().union(*uncovered)
            index = min(candidates, key=lambda i: (distances.get(i, math.inf), -sum(i in dependencies for dependencies in uncovered), i))
            added.add(index)
            reasons.setdefault(index, []).append('GetUFFTorsionParams-changed-after-mask')
        if added:
            excluded.update(added)
            continue
        if any(_native_query(work, 'GetUFFVdWParams', (i, i)) is not None for i in excluded):
            engine.reject('hybrid-typing-isolation', 'The internal null-parameter mask retained an unsupported UFF atom type.')
        # Inversions bypass UFF params, but a masked center has atomic number 0
        # and must not produce any native inversion. Torsion centers likewise
        # must have no parameter; their ends are checked by the audit above.
        for name, indices, dependencies in terms:
            if name in ('GetUFFInversionParams', 'GetUFFTorsionParams') and dependencies & excluded:
                if _native_query(work, name, indices) is not None:
                    engine.reject('hybrid-typing-isolation', 'An excluded native inversion or torsion center retained a contribution.')
        return work, excluded, coverage, reasons
    engine.reject('hybrid-typing-isolation', 'The native type-dependency audit did not reach a stable local partition.')


def _isolated_graph_signature(mol):
    """Immutable explicit graph plus audited work-copy typing, no re-sanitize."""
    atoms = [(a.GetProp('_StableId'), a.GetAtomicNum(), a.GetFormalCharge(), a.GetNoImplicit(),
              a.GetNumExplicitHs(), a.GetNumImplicitHs(), a.GetNumRadicalElectrons(), a.GetIsAromatic(),
              int(a.GetHybridization()), a.GetTotalValence()) for a in mol.GetAtoms()]
    bonds = sorted((min(b.GetBeginAtomIdx(), b.GetEndAtomIdx()), max(b.GetBeginAtomIdx(), b.GetEndAtomIdx()),
                    b.GetBondTypeAsDouble(), b.GetIsAromatic()) for b in mol.GetBonds())
    return atoms, bonds


def classify(structure):
    """Native failures and audited typing dependencies, without graph whitelist."""
    n = len(structure['atoms'])
    if structure.get('charge') is not None and structure['charge'] != sum(atom.get('formalCharge', 0) for atom in structure['atoms']):
        engine.reject('charge-mismatch', 'Overall charge and explicit atom formal charges disagree; no charge distribution was assigned.')
    adjacency = [set() for _ in range(n)]
    for bond in structure.get('bonds', []):
        adjacency[bond['a']].add(bond['b'])
        adjacency[bond['b']].add(bond['a'])
    ids = {atom['id']: i for i, atom in enumerate(structure['atoms'])}
    incompatible = [bond for bond in structure.get('bonds', []) if
                    bond.get('fractional') is True or bond.get('kind') == 'coordination' or bond['order'] == .5]
    mol = None
    roots = set()
    if incompatible:
        roots = {i for bond in incompatible for i in (bond['a'], bond['b'])}
        trigger = 'fractional-parameterization' if any(b.get('fractional') is True for b in incompatible) else 'bond-type'
    else:
        try:
            mol = _unchanged_molecule(structure)
        except engine.Rejected as exc:
            if exc.code not in ('sanitization', 'hybrid-chemistry-change', 'charge-change'):
                raise
            evidence = exc.diagnostics or engine.diagnostics.sanitization(engine.molecule(structure, sanitize=False), structure)
            atom_ids = evidence.get('atomIds', [])
            if not atom_ids and exc.code in ('hybrid-chemistry-change', 'charge-change'):
                raw = engine.molecule(structure, sanitize=False)
                cleaned = engine.Chem.Mol(raw)
                engine.Chem.SanitizeMol(cleaned)
                before_atoms, before_bonds = _chemical_signature(raw)
                after_atoms, after_bonds = _chemical_signature(cleaned)
                altered = {i for i, (a, b) in enumerate(zip(before_atoms, after_atoms)) if a != b}
                for edge in set(before_bonds)^set(after_bonds):
                    altered.update(edge[:2])
                atom_ids = [structure['atoms'][i]['id'] for i in sorted(altered)]
            if not atom_ids or any(atom_id not in ids for atom_id in atom_ids):
                engine.reject('hybrid-problem-location', 'Sanitization failed without trustworthy atom identities; a local mechanical region cannot be inferred.')
            roots = {ids[atom_id] for atom_id in atom_ids}
            trigger = 'sanitization'
        except Exception:
            engine.reject('hybrid-conversion', 'The internal chemistry conversion failed without a trustworthy local region; no partial UFF was constructed.')
        else:
            if engine.AllChem.UFFHasAllMoleculeParams(mol):
                engine.reject('hybrid-not-needed', 'The unchanged graph has complete UFF coverage; use the normal full force-field route.')
            evidence = engine.diagnostics.uff_missing_types(mol, structure)
            atom_ids = evidence.get('atomIds', [])
            if not atom_ids or any(atom_id not in ids for atom_id in atom_ids):
                engine.reject('hybrid-problem-location', 'Missing UFF parameters have no trustworthy atom locations; no local substitute was guessed.')
            roots = {ids[atom_id] for atom_id in atom_ids}
            trigger = 'parameterization'
    selective = mol is None
    if selective:
        mol = _fresh_initialized(structure)
        additional = engine.diagnostics.sanitization(mol, structure).get('atomIds', [])
        roots.update(ids[atom_id] for atom_id in additional if atom_id in ids)
        # A failure must not hide an earlier CLEANUP charge rewrite. Inspect
        # independent original-component probes solely as diagnostics; even a
        # failed probe's observed rewrite is evidence to EXCLUDE those atoms.
        # No probe cache, successful or failed, reaches the UFF work copy.
        for component in _components(adjacency):
            part = _part_structure(structure, component)
            raw = engine.molecule(part, sanitize=False)
            cleaned = engine.Chem.Mol(raw)
            try:
                engine.Chem.SanitizeMol(cleaned)
            except Exception:
                pass
            before_atoms, _ = _chemical_signature(raw)
            after_atoms, _ = _chemical_signature(cleaned)
            mapping = sorted(component)
            roots.update(mapping[i] for i, (a, b) in enumerate(zip(before_atoms, after_atoms)) if a != b)
    missing = {i for i in range(n) if _native_query(mol, 'GetUFFVdWParams', (i, i)) is None}
    roots.update(missing)
    # Always audit a null mask, including missing-parameter atoms whose native
    # inversion contributions are independent of their missing atomic params.
    initialized = mol
    mol, excluded, coverage, reasons = _mask_typing(initialized, roots, structure)
    local = set(excluded)
    for root in excluded:
        local.update(adjacency[root])
    boundary = {i for i in local if adjacency[i]-local} | {j for i in local for j in adjacency[i]-local}
    return dict(mol=mol, roots=roots, local=local, boundary=boundary, adjacency=adjacency, trigger=trigger,
                isolated_typing=True, excluded=excluded, coverage=coverage, initialized=initialized,
                selective=selective, typing_loss_reasons=reasons)


def calibration(bond_parameters):
    """Scale existing 5*(dr/r0)^2 to retained UFF .5*kb*dr^2.

    kb is kcal/mol/angstrom^2, r0 angstrom, so kb*r0^2/10 is kcal/mol.
    The robust median uses only actual positive retained UFF stretch terms.
    It is an explicit preoptimization normalization, not a fitted new FF.
    """
    candidates = [float(kb)*float(r0)**2/10 for kb, r0 in bond_parameters
                  if all(math.isfinite(float(value)) and float(value) > 0 for value in (kb, r0))]
    if not candidates:
        engine.reject('hybrid-scale-reference', 'No retained positive UFF bond-stretch parameter exists to calibrate the local geometry objective; no strength was guessed.')
    scale = float(np.median(candidates))
    if not math.isfinite(scale) or scale <= 0:
        engine.reject('hybrid-scale-reference', 'Retained UFF bond stiffness did not produce a finite positive normalization.')
    return scale


class Objective:
    def __init__(self, structure, ports=(), scale_policy=None, allow_pure=False):
        if scale_policy != SCALE_POLICY:
            engine.reject('hybrid-scale-policy', 'Hybrid preoptimization requires an explicitly selected UFF bond-stiffness normalization policy; no default strength was applied.')
        self.structure = copy.deepcopy(structure)
        self.partition = classify(structure)
        self.local = self.partition['local']
        self.mol = self.partition['mol']
        self.mapping = list(range(len(structure['atoms'])))
        self.trusted = set(self.mapping)-self.partition['excluded']
        self.trusted_components = []
        # Complete independently unchanged components can still receive native
        # stereochemical checks. Connected failed chemistry remains protected
        # by geometry Session's explicit tetrahedral/E-Z coordinate invariants.
        for component in _components(self.partition['adjacency']):
            if not component & self.partition['roots']:
                part = _part_structure(structure, component)
                _unchanged_molecule(part)
                self.trusted_components.append(part)
        self.to_native = {original: native for native, original in enumerate(self.mapping)}
        self.native_indices = set(self.to_native)
        self.graph = self._graph_signature()
        self.coverage = self.partition['coverage']
        self.reference_parameters = []
        for bond in structure.get('bonds', []):
            value = self._parameter('GetUFFBondStretchParams', bond['a'], bond['b'])
            if value is not None and all(float(number) > 0 for number in value):
                self.reference_parameters.append(value)
        self.pure = not self.reference_parameters
        native_terms = [(name, indices, value) for (name, indices), value in self.coverage.items()
                        if name != 'GetUFFVdWParams' or indices[0] != indices[1]]
        self.fallback_reason = 'no-uff-region' if not native_terms else 'no-uff-scale'
        if self.pure and native_terms:
            # A real angle/torsion/inversion/nonbonded contribution must not be
            # discarded merely because the approved bond scale is unavailable.
            calibration([])
        if self.pure and allow_pure is not True:
            if self.fallback_reason == 'no-uff-region':
                engine.reject('hybrid-no-uff-region', 'No trustworthy native UFF region remains; explicitly select geometry-only fallback to continue.')
            calibration([])
        self.scale = 1. if self.pure else calibration(self.reference_parameters)
        self.mechanics = geometry_clean.Objective(structure, ports)
        self.neighbours = self.mechanics.neighbours
        if self.pure:
            self.ff = None
            self.trusted = set()
            self.local = set(self.mapping)
            self.partition['boundary'] = set()
            self.term_counts = dict(bond=len(self.mechanics.lengths), angle=len(self.mechanics.angles),
                                    plane=len(self.mechanics.planes), repulsion=len(self.mechanics.pairs), referenceUFFBond=0)
            self.evaluate(self.mechanics.initial)
            return
        try:
            self.ff = engine.AllChem.UFFGetMoleculeForceField(self.mol, vdwThresh=1e6, ignoreInterfragInteractions=False)
            if self.ff is None:
                raise ValueError('no field')
            self.ff.Initialize()
        except Exception:
            engine.reject('hybrid-uff-build', 'The original native UFF partial builder could not construct a finite trusted field; no UFF terms were reimplemented.')
        if self._graph_signature() != self.graph:
            engine.reject('hybrid-graph-change', 'Partial UFF construction changed its trustworthy explicit graph.')
        self.mechanics.lengths = [term for term in self.mechanics.lengths if
                                 set(term[:2]) & self.local and self._parameter('GetUFFBondStretchParams', *term[:2]) is None]
        self.mechanics.angles = [term for term in self.mechanics.angles if
                                set(term[:3]) & self.local and self._parameter('GetUFFAngleBendParams', *term[:3]) is None]
        self.mechanics.planes = [term for term in self.mechanics.planes if
                                set(term[:4]) & self.local and not self._covered_plane(term[:4])]
        self.native_adjacency = {self.mapping[a.GetIdx()]: {self.mapping[n.GetIdx()] for n in a.GetNeighbors()}
                                 for a in self.mol.GetAtoms()}
        self.mechanics.pair_atoms = self.local
        self.mechanics.pair_filter = lambda a, b: not self._covered_nonbonded(a, b)
        self.term_counts = dict(bond=len(self.mechanics.lengths), angle=len(self.mechanics.angles),
                                plane=len(self.mechanics.planes), repulsion=sum(1 for _ in self.mechanics.pair_indices()), referenceUFFBond=len(self.reference_parameters))
        self.evaluate(self.mechanics.initial)

    def _parameter(self, name, *indices):
        variants = [tuple(indices)]
        if name in ('GetUFFVdWParams', 'GetUFFBondStretchParams', 'GetUFFAngleBendParams', 'GetUFFTorsionParams'):
            variants.append(tuple(reversed(indices)))
        elif name == 'GetUFFInversionParams':
            a, center, b, c = indices
            variants = [(x, center, y, z) for x, y, z in itertools.permutations((a, b, c))]
        return next((self.coverage[(name, value)] for value in variants if (name, value) in self.coverage), None)

    def _graph_signature(self):
        return _isolated_graph_signature(self.mol) if self.partition['isolated_typing'] else engine.native_graph_signature(self.mol)

    def _covered_plane(self, indices):
        a, b, c, d = indices
        torsion = self._parameter('GetUFFTorsionParams', a, b, c, d)
        inversions = [self._parameter('GetUFFInversionParams', *term) for term in ((a, d, b, c), (a, b, c, d), (b, a, c, d), (a, c, b, d))]
        return any(value is not None and float(value) > 0 for value in [torsion]+inversions)

    def _covered_nonbonded(self, a, b):
        parameters = self._parameter('GetUFFVdWParams', a, b)
        if parameters is None:
            return False
        # Native UFF excludes 1-2 and 1-3 pairs even when atom parameters exist.
        # Such a missing term must not erase local severe-overlap protection,
        # notably genuine H/H around a center with unavailable angle typing.
        neighbours_a, neighbours_b = self.native_adjacency[a], self.native_adjacency[b]
        if b in neighbours_a or neighbours_a & neighbours_b:
            return False
        distance = float(np.linalg.norm(self.mechanics.initial[a]-self.mechanics.initial[b]))
        return distance < 1e6*float(parameters[0])

    def components(self, xyz):
        xyz = np.asarray(xyz, dtype=float)
        mechanical, mechanical_gradient = self.mechanics.evaluate(xyz)
        if self._graph_signature() != self.graph:
            engine.reject('hybrid-graph-change', 'The retained UFF graph changed during hybrid preoptimization.')
        if self.pure:
            return mechanical, mechanical_gradient, 0., mechanical
        native_xyz = xyz[self.mapping].ravel().tolist()
        energy = float(self.ff.CalcEnergy(native_xyz))
        native_gradient = np.asarray(self.ff.CalcGrad(native_xyz), dtype=float).reshape((-1, 3))
        if not math.isfinite(energy) or not np.all(np.isfinite(native_gradient)):
            engine.reject('hybrid-nonfinite', 'Partial UFF energy or gradients became nonfinite; no mechanical replacement was used to conceal it.')
        gradient = mechanical_gradient.copy()
        gradient[self.mapping] += native_gradient/self.scale
        value = energy/self.scale+mechanical
        return value, gradient, energy, mechanical

    def evaluate(self, xyz):
        value, gradient, _, _ = self.components(xyz)
        return value, gradient

    def metadata(self, xyz):
        _, _, energy, mechanical = self.components(xyz)
        atom_ids = lambda indices: [self.structure['atoms'][i]['id'] for i in sorted(indices)]
        result = dict(schema=1, mode='geometry-only' if self.pure else 'partial-uff-local', triggerCode=self.partition['trigger'],
                    problemAtomIds=atom_ids(self.partition['roots']), mechanicalAtomIds=atom_ids(self.local),
                    uffAtomIds=atom_ids(self.trusted), boundaryAtomIds=atom_ids(self.partition['boundary']),
                    uffEnergyKcalMol=energy, localMechanicalObjective=mechanical,
                    energyScaleKcalMol=self.scale, scalePolicy='pure-geometry-v1' if self.pure else SCALE_POLICY, termCounts=self.term_counts,
                    objective='mechanicalGeometry' if self.pure else 'partialUFF(kcal/mol)/energyScale(kcal/mol)+localMechanical',
                    regionsOverlap=bool(self.local & self.trusted), physicalPotential=False)
        if self.partition['isolated_typing']:
            result['typingProof'] = 'native-null-typing-mask-v3'
            result['typingIsolationAtomIds'] = atom_ids(self.partition['excluded'])
        if self.pure:
            result['fallbackReason'] = self.fallback_reason
        return result

    def check_stereo(self, output):
        by_id = {atom['id']: atom for atom in output['atoms']}
        for before in self.trusted_components:
            after = copy.deepcopy(before)
            for atom in after['atoms']:
                final = by_id[atom['id']]
                atom.update(x=final['x'], y=final['y'], z=final['z'])
            engine.check_stereo(before, after)


class Session(geometry_clean.Session):
    def __init__(self, request):
        if request.get('operation') != 'geometry' or request.get('geometryMode') != 'hybrid-local':
            engine.reject('hybrid-operation', 'Local hybrid preoptimization is only an explicitly selected geometry session, never MD.')
        if request.get('forcefield', 'auto') not in ('auto', 'UFF'):
            engine.reject('hybrid-forcefield', 'Local hybrid preoptimization retains partial UFF only; it does not mix MMFF terms.')
        if any(request.get('structure', {}).get('cell', {}).get('pbc', [])) or request.get('structure', {}).get('periodicSource'):
            engine.reject('periodic-hybrid-unsupported', 'Partial molecular UFF cannot be used as a periodic potential; select explicit fixed-cell mechanical geometry instead.')
        checked = copy.deepcopy(request)
        cell = checked.get('structure', {}).get('cell')
        if isinstance(cell, dict) and isinstance(cell.get('pbc'), list) and len(cell['pbc']) == 3 and all(v is False for v in cell['pbc']):
            checked['structure'].pop('cell')
        engine.validate(checked)
        if 'allowPureGeometryFallback' in request and request['allowPureGeometryFallback'] is not True:
            engine.reject('hybrid-pure-fallback', 'Pure geometry fallback requires the explicit boolean true authorization flag.')
        objective = Objective(request['structure'], request.get('attachmentPorts', []), request.get('hybridScalePolicy'), request.get('allowPureGeometryFallback', False))
        super().__init__(request, objective=objective)

    def _seed_overlaps(self):
        """Local, bounded and validated descent; no remote mechanical seed."""
        xyz = self.positions.copy()
        local = self.objective.local
        pairs = list(itertools.combinations(range(len(xyz)), 2))
        for i, j in pairs:
            if np.linalg.norm(xyz[i]-xyz[j]) < 1e-4 and not {i, j} & local:
                engine.reject('hybrid-outside-overlap', 'Coincident atoms in the trustworthy UFF periphery cannot be moved by a local mechanical seed; separate them explicitly or use an independently validated full-force-field route.')
        for i, j in pairs:
            if np.linalg.norm(xyz[i]-xyz[j]) >= 1e-4:
                continue
            endpoints = [index for index in (j, i) if index in local and index not in self.fixed]
            if not endpoints:
                engine.reject('hybrid-local-fixed-overlap', 'A local overlap has no movable local endpoint; no outside atom was displaced to repair it.')
            index = endpoints[0]
            direction = geometry_clean._unit([1+(index % 3), 1+((index+1) % 5), 1+((index+2) % 7)])
            prior = self.objective.evaluate(xyz)[0]
            chosen = None
            for distance in (.02, .01, .005, .002, .001):
                trial = xyz.copy()
                trial[index] += distance*direction
                if not np.all(np.isfinite(trial)) or np.max(np.linalg.norm(trial-self.positions, axis=1)) > .100000001:
                    continue
                residuals = self._residuals(trial)
                if residuals is None or self.objective.evaluate(trial)[0] > prior+1e-10:
                    continue
                original_positions, original_residuals = self.positions, self.constraint_residuals
                try:
                    # Run the same fixed-XYZ/graph/stereo validation as a
                    # published frame before allowing the base optimizer to
                    # publish this private candidate. Always restore state.
                    self.positions, self.constraint_residuals = trial, residuals
                    self.snapshot()
                except engine.Rejected:
                    continue
                finally:
                    self.positions, self.constraint_residuals = original_positions, original_residuals
                chosen = trial
                break
            if chosen is None:
                engine.reject('hybrid-local-overlap', 'The local overlap has no finite descending seed consistent with frozen coordinates and current stereochemistry; no seed frame was published.')
            xyz = chosen
        if self.objective.evaluate(xyz)[0] > self.objective.evaluate(self.positions)[0]+1e-10:
            engine.reject('hybrid-seed-descent', 'A local overlap seed raised the hybrid objective and was not published.')
        self.constraint_residuals = self._residuals(xyz)
        return xyz

    def snapshot(self):
        result = super().snapshot()
        self.objective.check_stereo(result['structure'])
        result['hybridGeometry'] = self.objective.metadata(self.positions)
        result['engine'] = 'Local geometry + SciPy' if self.objective.pure else 'RDKit partial UFF + local geometry + SciPy'
        result['warnings'] = (['Pure mechanical geometry preparation: no UFF terms are used, and this objective is not a molecular potential energy or MD parameterization. Explicit chemistry is unchanged.'] if self.objective.pure else
                              ['Dimensionless local hybrid preoptimization objective, not a validated full molecular potential or MD energy. Audited native UFF terms are retained, and only missing local geometry terms are supplemented; explicit chemistry is unchanged.'])
        return result
