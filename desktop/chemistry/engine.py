"""Single-request native chemistry worker. stdout is exactly one JSON object.

No files, network, implicit hydrogens, or persistent molecule state are used.
The desktop host owns deadlines/cancellation by terminating this process.
"""
from __future__ import annotations

import copy
import json
import math
import sys

from rdkit import Chem, RDLogger, rdBase
from rdkit.Chem import AllChem, rdDetermineBonds

try:
    import _finite_empirical_accel
except ImportError:
    _finite_empirical_accel = None

try:
    import diagnostics
except ModuleNotFoundError:
    # Existing external tests import this standalone worker by file location.
    # Resolve its diagnostic sibling without changing the caller's sys.path.
    import importlib.util
    from pathlib import Path
    _diagnostics_spec = importlib.util.spec_from_file_location("diagnostics", Path(__file__).with_name("diagnostics.py"))
    diagnostics = importlib.util.module_from_spec(_diagnostics_spec)
    _diagnostics_spec.loader.exec_module(diagnostics)

# Native diagnostics can contain atom fragments; return bounded domain messages.
RDLogger.DisableLog("rdApp.*")
ENGINE = "RDKit"
VERSION = rdBase.rdkitVersion


class Rejected(Exception):
    def __init__(self, code, message, diagnostics=None):
        super().__init__(message)
        self.code = code
        self.diagnostics = diagnostics or {}


def reject(code, message, diagnostics=None):
    raise Rejected(code, message, diagnostics)


def require_resolved_perception(structure):
    if any(issue.get('kind') == 'unresolved' for issue in structure.get('bondPerceptionIssues', [])):
        reject('perception-unresolved', 'This partial bond-perception candidate has unresolved local chemistry; confirm or edit that region before generating 3D coordinates.')


def error_payload(exc, fallback_message):
    if isinstance(exc, Rejected):
        result = dict(code=exc.code, message=str(exc))
        if exc.diagnostics:
            result["diagnostic"] = exc.diagnostics
        return result
    return dict(code="native-failure", message=fallback_message)


def coordinates(structure):
    return [(a["x"], a["y"], a["z"]) for a in structure["atoms"]]


def periodic(structure):
    return any(structure.get("cell", {}).get("pbc", ())) or any(
        any(b.get("image", [0, 0, 0])) for b in structure.get("bonds", [])
    )


def validate(request, operations=("generate3d", "perceive-bonds", "convert")):
    if request.get("operation") not in operations:
        reject("operation", "Unsupported chemistry operation.")
    if 'sourceStereo' in request and request['operation'] != 'generate3d':
        reject('stereo-source', 'The original 2D stereo reference applies only to this 3D generation operation.')
    policy = request.get("bondPerceptionPolicy")
    if "empiricalBondParameters" in request:
        if request["operation"] != "perceive-bonds":
            reject("perception-parameters", "Empirical parameters require explicit bond perception.")
        _bond_perception_module()._empirical_parameters(request, reject)
    if policy is not None and (policy not in ("coordinate-import", "composite-v1") or request["operation"] != "perceive-bonds"):
        reject("bond-perception-policy", "Unknown or incompatible bond-perception policy.")
    if "bondOrderEvidence" in request and policy != "composite-v1":
        reject("bond-order-evidence-policy", "Native bond-order evidence belongs only to explicit composite-v1 perception.")
    structure = request.get("structure", {})
    if structure.get('periodicSource', {}).get('completeness') == 'partial' and request['operation'] != 'convert':
        reject('periodic-cell-incomplete', 'The source contains incomplete translation vectors; it is not an ordinary finite molecule and cannot run without a complete confirmed cell.')
    atoms = structure.get("atoms", [])
    if not atoms:
        reject("atom-count", "Native modeling requires a nonempty explicit atom inventory.")
    ids = [a.get("id") for a in atoms]
    if any(not isinstance(i, str) or not i for i in ids):
        reject("atom-identity", "Every explicit atom needs a unique stable ID.")
    id_set = set(ids)
    if len(id_set) != len(ids):
        reject("atom-identity", "Every explicit atom needs a unique stable ID.")
    if _finite_empirical_accel is not None and type(atoms) is list and all(type(atom) is dict for atom in atoms):
        status = _finite_empirical_accel.check_rows(atoms, Chem.GetPeriodicTable().GetAtomicNumber)
        if status == 1:
            reject("coordinates", "All coordinates must be finite numbers.")
        if status == 2:
            reject("element", "An atom has an unsupported element.")
        if status == 3:
            reject("charge", "Atom formal charges must be integers.")
    else:
        for atom in atoms:
            if not all(isinstance(atom.get(k), (int, float)) and not isinstance(atom.get(k), bool)
                       and math.isfinite(atom[k]) for k in ("x", "y", "z")):
                reject("coordinates", "All coordinates must be finite numbers.")
            try:
                if Chem.GetPeriodicTable().GetAtomicNumber(atom.get("element", "")) < 1:
                    raise ValueError()
            except Exception:
                reject("element", "An atom has an unsupported element.")
            if not isinstance(atom.get("formalCharge", 0), int):
                reject("charge", "Atom formal charges must be integers.")
    movable = request.get("movableAtomIds")
    if not isinstance(movable, list) or len(set(movable)) != len(movable) or any(i not in id_set for i in movable):
        reject("movable-identity", "Movable atoms must be unique IDs in the current model.")
    seen = set()
    for bond in structure.get("bonds", []):
        a, b = bond.get("a"), bond.get("b")
        if not isinstance(a, int) or not isinstance(b, int) or min(a, b) < 0 or max(a, b) >= len(atoms) or a == b:
            reject("bond-identity", "Bond indices must reference two distinct current atoms.")
        pair = tuple(sorted((a, b)))
        if pair in seen:
            reject("duplicate-bond", "Duplicate bond objects cannot parameterize a force field.")
        seen.add(pair)
        if bond.get('orderKnown') is False and (bond.get('perception') not in ('periodic-distance', 'empirical-distance') or bond.get('perception') == 'periodic-distance' and not structure.get('cell') or bond.get('order') != 1 or bond.get('mbo') is not None or bond.get('aromatic') or bond.get('fractional')):
            reject('periodic-bond-order', 'An empirical relation is unknown-order connectivity, not a measured chemical bond order.')
        empirical_rebuild = request['operation'] == 'perceive-bonds' and policy == 'composite-v1' and bond.get('perception') == 'empirical-distance'
        if bond.get('orderKnown') is False and not empirical_rebuild and not (request['operation'] == 'convert' and request.get('format') == 'xyz'):
            reject('unknown-bond-order', 'Unknown-order periodic connectivity cannot be passed off as force-field or molecular bond typing.')
        coordinate_export = request['operation'] == 'convert' and request.get('format') == 'xyz'
        if bond.get("order") not in (0.5, 1, 1.5, 2, 3) or (bond.get("kind") == "coordination" and not coordinate_export and policy != "composite-v1"):
            reject("bond-type", "Auxiliary and coordination bonds require explicit compatible chemistry; they are not force-field covalent bonds.")
        if (bond.get("order") == .5 and bond.get("fractional") is not True or
                bond.get("fractional") is True and (bond.get("order") not in (.5, 1.5) or bond.get("aromatic") is True)):
            reject("bond-type", "An explicit fractional connection must have order 0.5 or 1.5 and must not be aromatic; order 0.5 requires fractional metadata.")
    if request["operation"] != "convert":
        if periodic(structure):
            reject("periodic-unsupported", "Native molecular generation and bond perception do not support periodic models.")
        if request["operation"] in ("generate3d", "md") and not movable:
            reject("no-movable-atoms", "There are no explicitly movable atoms.")
    if request["operation"] == "generate3d" and set(movable) != set(ids):
        reject("partial-generation", "3D generation requires the entire explicit molecule to be movable.")
    constraints = request.get("constraints", [])
    if not isinstance(constraints, list):
        reject("constraints", "Internal-coordinate constraints must be a list.")
    for item in constraints:
        images = item.get('images')
        if images is not None and (not isinstance(images, list) or len(images) != len(item.get('atomIds', [])) or any(not isinstance(image, list) or len(image) != 3 or any(type(value) is not int for value in image) for image in images)):
            reject('constraint-image', 'Internal-coordinate images must be integer triples for each endpoint.')
        if images is not None and any(any(image) for image in images):
            reject('image-coordinate-unsupported', 'This backend does not execute image-resolved internal-coordinate constraints; base IDs are not a substitute.')
        indices = item.get("atomIds", [])
        if item.get("action") not in ("freeze", "scan") or item.get("type") not in ("B", "A", "D"):
            reject("constraints", "Unknown internal-coordinate type or action.")
        if len(indices) != {"B": 2, "A": 3, "D": 4}[item["type"]] or len(set(indices)) != len(indices) or any(i not in ids for i in indices):
            reject("constraint-identity", "Internal coordinates need the correct number of distinct current atom IDs.")
    if request["operation"] == "generate3d" and any(c["action"] == "freeze" for c in constraints):
        reject("generation-internal-freeze", "ETKDG reconstructs the full molecule; generating 3D would not preserve frozen internal coordinates.")
    return structure


def molecule(structure, sanitize=True, declared_stereo=True):
    rw = Chem.RWMol()
    for item in structure["atoms"]:
        atom = Chem.Atom(item["element"])
        atom.SetFormalCharge(item.get("formalCharge", 0))
        # Editable open valences remain open. Never infer or materialize H here.
        atom.SetNoImplicit(True)
        atom.SetProp("_StableId", item["id"])
        rw.AddAtom(atom)
    types = {1: Chem.BondType.SINGLE, 1.5: Chem.BondType.AROMATIC,
             2: Chem.BondType.DOUBLE, 3: Chem.BondType.TRIPLE}
    for item in structure.get("bonds", []):
        fractional = item.get("fractional") is True
        aromatic = not fractional and (item.get("aromatic", False) or item["order"] == 1.5)
        if fractional and item["order"] == .5:
            reject("fractional-representation", "This RDKit molecule adapter cannot faithfully represent order 0.5; use coordinate export to preserve the measured graph.")
        rw.AddBond(item["a"], item["b"], Chem.BondType.ONEANDAHALF if fractional else (Chem.BondType.AROMATIC if aromatic else types[item["order"]]))
        bond = rw.GetBondBetweenAtoms(item["a"], item["b"])
        if fractional:
            bond.SetBoolProp("_ExplicitFractional", True)
        if aromatic:
            bond.SetIsAromatic(True)
            rw.GetAtomWithIdx(item["a"]).SetIsAromatic(True)
            rw.GetAtomWithIdx(item["b"]).SetIsAromatic(True)
        if item.get("stereo") in (1, 6):
            bond.SetBondDir(Chem.BondDir.BEGINWEDGE if item["stereo"] == 1 else Chem.BondDir.BEGINDASH)
    mol = rw.GetMol()
    conformer = Chem.Conformer(len(structure["atoms"]))
    conformer.Set3D(structure.get("dimension", 3) != 2)
    for i, pos in enumerate(coordinates(structure)):
        conformer.SetAtomPosition(i, pos)
    mol.AddConformer(conformer, assignId=True)
    mol.UpdatePropertyCache(strict=False)
    if sanitize:
        try:
            Chem.SanitizeMol(mol)
        except Exception:
            # Sanitization may partially update its molecule before failing.
            # Reconstruct only for diagnostics, then inspect a separate copy.
            evidence = {}
            try:
                evidence = diagnostics.sanitization(molecule(structure, sanitize=False), structure)
            except Exception:
                pass
            reject("sanitization", "The explicit graph cannot be sanitized without changing chemistry; edit its valence, charge or bonds before optimizing.", evidence)
        if sum(a.GetFormalCharge() for a in mol.GetAtoms()) != sum(a.get("formalCharge", 0) for a in structure["atoms"]):
            reject("charge-change", "Sanitization would change an explicit formal charge.")
        charge = structure.get("charge")
        if charge is not None and charge != sum(a.GetFormalCharge() for a in mol.GetAtoms()):
            reject("charge-mismatch", "Overall charge and explicit atom formal charges disagree. The supplied graph and charge must describe the same model.")
        if structure.get("dimension", 3) == 2:
            Chem.AssignChiralTypesFromBondDirs(mol)
            # The common graph carries E/Z through its actual 2D coordinates,
            # not SMILES slash directions. Register the controlling neighbour
            # directions before translating them to StereoAtoms/bond stereo.
            Chem.SetDoubleBondNeighborDirections(mol, mol.GetConformer())
            Chem.SetBondStereoFromDirections(mol)
        else:
            Chem.AssignStereochemistryFrom3D(mol)
        # Ordered stable-ID parity is not a CIP label. Calibrate RDKit's local
        # neighbour ordering on a synthetic tetrahedron, without embedding.
        for i, item in enumerate(structure["atoms"]):
            if not declared_stereo:
                continue
            parity = item.get("stereoParity", 0)
            if not parity:
                continue
            neighbours = sorted((n.GetIdx() for n in mol.GetAtomWithIdx(i).GetNeighbors()),
                                key=lambda j: structure["atoms"][j]["id"])
            if len(neighbours) != 4:
                reject("stereo-unsupported", "Specified tetrahedral parity requires four explicit neighbours.")
            tmp = Chem.Mol(mol)
            conf = tmp.GetConformer()
            # These are synthetic spatial coordinates, even when the caller's
            # conformer is a 2D drawing. RDKit must not re-read the old wedges.
            conf.Set3D(True)
            # This ordering has a positive determinant.
            points = ((1, 0, 0), (0, 1, 0), (0, 0, 1), (0, 0, 0))
            conf.SetAtomPosition(i, (.25 * parity, .25, .25))
            for j, p in zip(neighbours, points):
                conf.SetAtomPosition(j, (p[0] * parity, p[1], p[2]))
            Chem.AssignAtomChiralTagsFromStructure(tmp, replaceExistingTags=True)
            mol.GetAtomWithIdx(i).SetChiralTag(tmp.GetAtomWithIdx(i).GetChiralTag())
        Chem.AssignStereochemistry(mol, cleanIt=False, force=True)
    return mol


def _legacy_2d_stereo_source(structure):
    """Recover a wedge reference without using temporary diagram-H positions.

    New 2D entry points send their pre-expansion source explicitly. For old
    callers, terminal non-wedge H can be represented as a counted ligand;
    actual wedge-to-H endpoints remain explicit and retain their stable IDs.
    """
    graph = structure.get('bonds', [])
    removed = set()
    counts = {}
    for index, atom in enumerate(structure['atoms']):
        edges = [bond for bond in graph if index in (bond['a'], bond['b'])]
        if atom['element'] == 'H' and len(edges) == 1 and edges[0]['order'] == 1 and not edges[0].get('stereo'):
            parent = edges[0]['b'] if edges[0]['a'] == index else edges[0]['a']
            if structure['atoms'][parent]['element'] != 'H':
                removed.add(index)
                counts[parent] = counts.get(parent, 0) + 1
    return dict(schema='es-2d-stereo/v1', atoms=[dict(id=atom['id'], element=atom['element'],
                x=atom['x'], y=atom['y'], formalCharge=atom.get('formalCharge', 0), hydrogenCount=counts.get(i, 0))
                for i, atom in enumerate(structure['atoms']) if i not in removed],
                bonds=[dict(a=structure['atoms'][bond['a']]['id'], b=structure['atoms'][bond['b']]['id'],
                            order=bond['order'], stereo=bond.get('stereo', 0))
                       for bond in graph if bond['a'] not in removed and bond['b'] not in removed])


def _source_stereo_molecule(source, structure):
    """Read the original 2D graph; no derived parity/CIP is an authority."""
    if (not isinstance(source, dict) or source.get('schema') != 'es-2d-stereo/v1'
            or not isinstance(source.get('atoms'), list) or not isinstance(source.get('bonds'), list)):
        reject('stereo-source', 'The original 2D stereochemical reference is invalid.')
    target = {atom['id']: atom for atom in structure['atoms']}
    rw, indices = Chem.RWMol(), {}
    for item in source['atoms']:
        if (not isinstance(item, dict) or not isinstance(item.get('id'), str) or item['id'] in indices
                or item['id'] not in target or item.get('element') != target[item['id']]['element']
                or type(item.get('formalCharge', 0)) is not int
                or item.get('formalCharge', 0) != target[item['id']].get('formalCharge', 0)
                or any(type(item.get(axis)) not in (int, float) or not math.isfinite(item[axis]) for axis in ('x', 'y'))):
            reject('stereo-source', 'The original 2D atoms do not match the generated model identities.')
        atom = Chem.Atom(item['element'])
        atom.SetFormalCharge(item.get('formalCharge', 0))
        count = item.get('hydrogenCount')
        if count is not None:
            if type(count) is not int or count < 0:
                reject('stereo-source', 'The original 2D hydrogen count is invalid.')
            atom.SetNumExplicitHs(count)
            atom.SetNoImplicit(True)
        atom.SetProp('_StableId', item['id'])
        indices[item['id']] = rw.AddAtom(atom)
    types = {1: Chem.BondType.SINGLE, 1.5: Chem.BondType.AROMATIC, 2: Chem.BondType.DOUBLE, 3: Chem.BondType.TRIPLE}
    pairs = set()
    for item in source['bonds']:
        if (not isinstance(item, dict) or item.get('a') not in indices or item.get('b') not in indices
                or item['a'] == item['b'] or item.get('order') not in types or item.get('stereo', 0) not in (0, 1, 6)
                or item.get('stereo') and item['order'] != 1):
            reject('stereo-source', 'The original 2D connection/stereo endpoints are invalid.')
        pair = frozenset((item['a'], item['b']))
        if pair in pairs:
            reject('stereo-source', 'The original 2D reference repeats a connection.')
        pairs.add(pair)
        a, b = indices[item['a']], indices[item['b']]
        rw.AddBond(a, b, types[item['order']])
        bond = rw.GetBondBetweenAtoms(a, b)
        if item['order'] == 1.5:
            bond.SetIsAromatic(True)
            rw.GetAtomWithIdx(a).SetIsAromatic(True)
            rw.GetAtomWithIdx(b).SetIsAromatic(True)
        if item.get('stereo'):
            bond.SetBondDir(Chem.BondDir.BEGINWEDGE if item['stereo'] == 1 else Chem.BondDir.BEGINDASH)
    mol = rw.GetMol()
    conf = Chem.Conformer(len(source['atoms']))
    conf.Set3D(False)
    for index, item in enumerate(source['atoms']):
        conf.SetAtomPosition(index, (item['x'], item['y'], 0.))
    mol.AddConformer(conf)
    try:
        Chem.SanitizeMol(mol)
        Chem.AssignChiralTypesFromBondDirs(mol, replaceExistingTags=True)
        Chem.SetDoubleBondNeighborDirections(mol, mol.GetConformer())
        Chem.SetBondStereoFromDirections(mol)
        Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
        mol = Chem.AddHs(mol, addCoords=False)
        groups = source.get('stereoGroups', [])
        if not isinstance(groups, list):
            reject('stereo-source', 'The original stereo groups are invalid.')
        grouped, keys, native_groups = set(), set(), []
        editable = Chem.RWMol(mol)
        types = {'ABS': Chem.StereoGroupType.STEREO_ABSOLUTE,
                 'AND': Chem.StereoGroupType.STEREO_AND, 'OR': Chem.StereoGroupType.STEREO_OR}
        for group in groups:
            if (not isinstance(group, dict) or group.get('type') not in types
                    or not isinstance(group.get('id'), str) or not group['id']
                    or not isinstance(group.get('atomIds'), list) or not group['atomIds']):
                reject('stereo-source', 'The original stereo group declaration is invalid.')
            key = (group['type'], group['id'])
            members = group['atomIds']
            if key in keys or any(not isinstance(identity, str) or identity not in indices or identity in grouped for identity in members):
                reject('stereo-source', 'The original stereo group contains duplicate or unknown atom identities.')
            keys.add(key)
            for identity in members:
                if identity in grouped:
                    reject('stereo-source', 'The original stereo group repeats an atom identity.')
                grouped.add(identity)
            # Equivalent ligands can legitimately remove a nominal centre.
            # Keep its source membership but only attach native stereo atoms.
            active = [indices[identity] for identity in members
                      if mol.GetAtomWithIdx(indices[identity]).GetChiralTag() != Chem.ChiralType.CHI_UNSPECIFIED]
            if active:
                native_groups.append(Chem.CreateStereoGroup(types[group['type']], editable, active))
        editable.SetStereoGroups(native_groups)
        return editable.GetMol()
    except Exception as error:
        reject('stereo-source', 'The original 2D stereochemical graph could not be read without changing its chemistry.',
               {'nativeMessage': str(error)[:2048]})


def _transfer_source_stereo(reference, target):
    """Map counted H to existing output H and transfer native neighbour parity."""
    target_ids = {atom.GetProp('_StableId'): atom.GetIdx() for atom in target.GetAtoms()}
    mapping, source_ids = {}, set()
    for atom in reference.GetAtoms():
        if atom.HasProp('_StableId'):
            identity = atom.GetProp('_StableId')
            if identity not in target_ids:
                reject('stereo-source', 'The original stereochemical atom is missing from the generated model.')
            mapping[atom.GetIdx()] = target_ids[identity]
            source_ids.add(identity)
    required = set()
    for atom in reference.GetAtoms():
        if atom.GetChiralTag() != Chem.ChiralType.CHI_UNSPECIFIED:
            required.update(neighbour.GetIdx() for neighbour in atom.GetNeighbors())
    for bond in reference.GetBonds():
        if bond.GetStereo() in (Chem.BondStereo.STEREOE, Chem.BondStereo.STEREOZ):
            required.update(bond.GetStereoAtoms())
    source_h, target_h = {}, {}
    for atom in reference.GetAtoms():
        if atom.GetIdx() in mapping or atom.GetIdx() not in required:
            continue
        neighbours = list(atom.GetNeighbors())
        if atom.GetAtomicNum() != 1 or len(neighbours) != 1 or neighbours[0].GetIdx() not in mapping:
            reject('stereo-source', 'The original implicit ligand cannot be mapped to the explicit model.')
        parent = mapping[neighbours[0].GetIdx()]
        source_h.setdefault(parent, []).append(atom.GetIdx())
    for atom in target.GetAtoms():
        if atom.GetProp('_StableId') in source_ids:
            continue
        neighbours = list(atom.GetNeighbors())
        if atom.GetAtomicNum() == 1 and len(neighbours) == 1 and neighbours[0].GetIdx() in source_h:
            target_h.setdefault(neighbours[0].GetIdx(), []).append(atom.GetIdx())
    if any(len(values) != 1 or len(target_h.get(parent, [])) != 1 for parent, values in source_h.items()):
        reject('stereo-source', 'A specified stereochemical hydrogen cannot be mapped uniquely to its original centre.')
    for parent, values in source_h.items():
        for source_index, target_index in zip(values, sorted(target_h[parent], key=lambda i: target.GetAtomWithIdx(i).GetProp('_StableId'))):
            mapping[source_index] = target_index
    source_edges = sorted((min(mapping[b.GetBeginAtomIdx()], mapping[b.GetEndAtomIdx()]),
                           max(mapping[b.GetBeginAtomIdx()], mapping[b.GetEndAtomIdx()]), b.GetBondTypeAsDouble()) for b in reference.GetBonds()
                          if b.GetBeginAtom().HasProp('_StableId') and b.GetEndAtom().HasProp('_StableId'))
    target_edges = sorted((min(b.GetBeginAtomIdx(), b.GetEndAtomIdx()), max(b.GetBeginAtomIdx(), b.GetEndAtomIdx()),
                           b.GetBondTypeAsDouble()) for b in target.GetBonds()
                          if b.GetBeginAtom().GetProp('_StableId') in source_ids and b.GetEndAtom().GetProp('_StableId') in source_ids)
    if source_edges != target_edges:
        reject('stereo-source', 'The generated model changed the original 2D connection graph.')
    Chem.RemoveStereochemistry(target)
    for atom in reference.GetAtoms():
        if atom.GetChiralTag() == Chem.ChiralType.CHI_UNSPECIFIED:
            continue
        other = target.GetAtomWithIdx(mapping[atom.GetIdx()])
        source_order = [mapping[n.GetIdx()] for n in atom.GetNeighbors()]
        target_order = [n.GetIdx() for n in other.GetNeighbors()]
        order = [target_order.index(index) for index in source_order]
        other.SetChiralTag(atom.GetChiralTag())
        if sum(order[i] > order[j] for i in range(len(order)) for j in range(i + 1, len(order))) % 2:
            other.InvertChirality()
    # Validate the actual target atom centres before installing double-bond
    # declarations. cleanIt=True after programmatic SetStereo would erase
    # a valid E/Z declaration that has no serialized slash-direction cache.
    Chem.AssignStereochemistry(target, cleanIt=True, force=True)
    for bond in reference.GetBonds():
        if bond.GetStereo() not in (Chem.BondStereo.STEREOE, Chem.BondStereo.STEREOZ):
            continue
        begin, end = mapping[bond.GetBeginAtomIdx()], mapping[bond.GetEndAtomIdx()]
        other = target.GetBondBetweenAtoms(begin, end)
        neighbours = [mapping[index] for index in bond.GetStereoAtoms()]
        if other.GetBeginAtomIdx() != begin:
            neighbours.reverse()
        other.SetStereoAtoms(*neighbours)
        other.SetStereo(bond.GetStereo())
    Chem.SetDoubleBondNeighborDirections(target)
    Chem.AssignStereochemistry(target, cleanIt=False, force=True)
    editable = Chem.RWMol(target)
    editable.SetStereoGroups([Chem.CreateStereoGroup(group.GetGroupType(), editable,
        [mapping[atom.GetIdx()] for atom in group.GetAtoms()]) for group in reference.GetStereoGroups()])
    return editable.GetMol()


def generation_molecule(structure, source=None):
    if source is not None:
        if (not isinstance(source, dict) or source.get('schema') != 'es-2d-stereo/v1'
                or not isinstance(source.get('atoms'), list) or not isinstance(source.get('bonds'), list)
                or not all(isinstance(bond, dict) for bond in source['bonds'])):
            reject('stereo-source', 'The original 2D stereochemical reference is invalid.')
        degree = {}
        for bond in source['bonds']:
            for identity in (bond.get('a'), bond.get('b')):
                if isinstance(identity, str):
                    degree[identity] = degree.get(identity, 0) + 1
        relevant = bool(source.get('stereoGroups')) or any(bond.get('stereo') in (1, 6) or bond.get('order') == 2
                       and degree.get(bond.get('a'), 0) > 1 and degree.get(bond.get('b'), 0) > 1 for bond in source['bonds'])
    else:
        relevant = False
    if source is not None and not relevant:
        # No declared stereo or potentially configurable double bond: use the
        # one target graph already required for embedding, without constructing
        # a second molecule or turning old derived metadata into a declaration.
        mol = molecule(structure, declared_stereo=False)
        Chem.RemoveStereochemistry(mol)
        return mol
    if source is not None or structure.get('dimension', 3) == 2 and any(b.get('stereo') in (1, 6) for b in structure.get('bonds', [])):
        reference = _source_stereo_molecule(source if source is not None else _legacy_2d_stereo_source(structure), structure)
        return _transfer_source_stereo(reference, molecule(structure, declared_stereo=False))
    # Legacy explicit ordered parity is calibrated using an actual 3D synthetic
    # conformer; the caller's planar flag can no longer invalidate that mapping.
    mol = molecule(structure)
    Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
    return mol


def sub(a, b):
    return tuple(x-y for x, y in zip(a, b))


def cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def dot(a, b):
    return sum(x*y for x, y in zip(a, b))


def stereo_geometry(structure):
    xyz = coordinates(structure)
    graph = structure.get("bonds", [])
    tetra, double = {}, {}
    for i, item in enumerate(structure["atoms"]):
        if not item.get("stereoParity"):
            continue
        ns = sorted((b["b"] if b["a"] == i else b["a"] for b in graph if i in (b["a"], b["b"])),
                    key=lambda j: structure["atoms"][j]["id"])
        if len(ns) != 4:
            reject("stereo-unsupported", "Specified tetrahedral parity requires four explicit neighbours.")
        p = [xyz[j] for j in ns]
        value = dot(sub(p[0], p[3]), cross(sub(p[1], p[3]), sub(p[2], p[3])))
        tetra[i] = 0 if abs(value) < 1e-7 else (1 if value > 0 else -1)
    for b in graph:
        if b["order"] != 2:
            continue
        a, c = b["a"], b["b"]
        left = sorted(x["b"] if x["a"] == a else x["a"] for x in graph if a in (x["a"], x["b"]) and c not in (x["a"], x["b"]))
        right = sorted(x["b"] if x["a"] == c else x["a"] for x in graph if c in (x["a"], x["b"]) and a not in (x["a"], x["b"]))
        if not left or not right:
            continue
        axis = sub(xyz[c], xyz[a])
        value = dot(cross(axis, sub(xyz[left[0]], xyz[a])), cross(axis, sub(xyz[right[0]], xyz[c])))
        double[(a, c, left[0], right[0])] = 0 if abs(value) < 1e-8 else (1 if value > 0 else -1)
    return tetra, double


def check_stereo(before, after, generation=False, reference=None):
    # The reference is captured once, before embedding. Compare only genuine
    # native stereocentres/E-Z bonds; arbitrary neighbour-index signs are not
    # configurations (notably two equivalent ring paths or identical ligands).
    expected = reference if reference is not None else (generation_molecule(before) if generation else molecule(before, declared_stereo=False))
    actual = molecule(after, declared_stereo=False)
    Chem.AssignStereochemistry(actual, cleanIt=True, force=True)
    # One valid representative may invert every centre of an AND/OR group.
    # Normalize only a complete group inversion before the existing native
    # tetrahedral/E-Z/ring comparison. Never accept a single-centre inversion.
    for group in expected.GetStereoGroups():
        if group.GetGroupType() == Chem.StereoGroupType.STEREO_ABSOLUTE:
            continue
        flips = []
        for atom in group.GetAtoms():
            other = actual.GetAtomWithIdx(atom.GetIdx())
            if other.GetChiralTag() == Chem.ChiralType.CHI_UNSPECIFIED:
                reject('stereo-change', 'Native validation detected loss of an enhanced stereo group centre.')
            flips.append(other.GetChiralTag() != atom.GetChiralTag())
        if any(flips) and not all(flips):
            reject('stereo-change', 'Native validation detected a change within an enhanced stereo group.')
        if flips and all(flips):
            for atom in group.GetAtoms():
                actual.GetAtomWithIdx(atom.GetIdx()).InvertChirality()
    Chem.AssignStereochemistry(actual, cleanIt=True, force=True)
    for atom in expected.GetAtoms():
        if atom.HasProp("_CIPCode"):
            other = actual.GetAtomWithIdx(atom.GetIdx())
            if not other.HasProp("_CIPCode") or atom.GetProp("_CIPCode") != other.GetProp("_CIPCode"):
                reject("stereo-change", "Native stereochemical validation detected a tetrahedral inversion or loss.")
    for bond in expected.GetBonds():
        stereo = bond.GetStereo()
        if stereo in (Chem.BondStereo.STEREOE, Chem.BondStereo.STEREOZ):
            other = actual.GetBondBetweenAtoms(bond.GetBeginAtomIdx(), bond.GetEndAtomIdx())
            if other.GetStereo() != stereo:
                reject("stereo-change", "Native stereochemical validation detected an E/Z inversion or loss.",
                       {'kind': 'double-bond-geometry', 'bondAtomIds': [before['atoms'][index]['id']
                        for index in (bond.GetBeginAtomIdx(), bond.GetEndAtomIdx())],
                        'expectedStereo': str(stereo), 'actualStereo': str(other.GetStereo())})
    if any(atom.GetChiralTag() != Chem.ChiralType.CHI_UNSPECIFIED and not atom.HasProp('_CIPCode') for atom in expected.GetAtoms()):
        # Coupled ring cis/trans can be defined without independently named
        # R/S centres. Canonical stereo graph comparison permits equivalent
        # ring-path permutations while preserving the declared relationship.
        observed = Chem.Mol(actual)
        for atom in observed.GetAtoms():
            if expected.GetAtomWithIdx(atom.GetIdx()).GetChiralTag() == Chem.ChiralType.CHI_UNSPECIFIED:
                atom.SetChiralTag(Chem.ChiralType.CHI_UNSPECIFIED)
        for bond in observed.GetBonds():
            bond.SetBondDir(Chem.BondDir.NONE)
            prior = expected.GetBondBetweenAtoms(bond.GetBeginAtomIdx(), bond.GetEndAtomIdx())
            if prior.GetStereo() not in (Chem.BondStereo.STEREOE, Chem.BondStereo.STEREOZ):
                bond.SetStereo(Chem.BondStereo.STEREONONE)
        Chem.AssignStereochemistry(observed, cleanIt=True, force=True)
        if Chem.MolToSmiles(Chem.RemoveHs(expected), isomericSmiles=True) != Chem.MolToSmiles(Chem.RemoveHs(observed), isomericSmiles=True):
            reject('stereo-change', 'Native stereochemical validation detected a change in the specified ring configuration.')


def with_coordinates(structure, mol):
    result = copy.deepcopy(structure)
    conf = mol.GetConformer()
    for i, item in enumerate(result["atoms"]):
        p = conf.GetAtomPosition(i)
        if not all(math.isfinite(value) for value in (p.x, p.y, p.z)):
            reject("coordinates", "The native result contains non-finite coordinates; no result was accepted.")
        item.update(x=p.x, y=p.y, z=p.z)
    result["dimension"] = 3
    # Never return stale cached coordinates to legacy serialization paths.
    result.pop("molfile", None)
    return result


def native_graph_signature(mol):
    # Native aromaticity typing may differ internally; compare a sanitized
    # copy using RDKit's ordinary aromaticity without mutating the worker mol.
    normalized = Chem.Mol(mol)
    Chem.SanitizeMol(normalized)
    atoms = [(a.GetProp("_StableId"), a.GetAtomicNum(), a.GetFormalCharge(),
              a.GetNumExplicitHs(), a.GetNumImplicitHs(), a.GetNumRadicalElectrons(), a.GetIsAromatic())
             for a in normalized.GetAtoms()]
    bonds = sorted((min(b.GetBeginAtomIdx(), b.GetEndAtomIdx()), max(b.GetBeginAtomIdx(), b.GetEndAtomIdx()),
                    b.GetBondTypeAsDouble(), b.GetIsAromatic()) for b in normalized.GetBonds())
    return atoms, bonds


def internal_value(positions, kind, indices):
    p = [positions[i] for i in indices]
    if kind == "B":
        value = math.sqrt(dot(sub(p[1], p[0]), sub(p[1], p[0])))
        if value < 1e-10:
            reject("constraint-geometry", "A frozen distance is undefined for coincident atoms.")
        return value
    if kind == "A":
        a, b = sub(p[0], p[1]), sub(p[2], p[1])
        norm = math.sqrt(dot(a, a)*dot(b, b))
        if norm < 1e-12:
            reject("constraint-geometry", "A frozen angle contains coincident atoms.")
        cosine = max(-1.0, min(1.0, dot(a, b)/norm))
        if abs(cosine) > 1-1e-12:
            reject("constraint-geometry", "A linear frozen angle has singular Cartesian derivatives; this constraint was not optimized.")
        return math.acos(cosine)
    axis = sub(p[2], p[1])
    length = math.sqrt(dot(axis, axis))
    n1, n2 = cross(sub(p[0], p[1]), axis), cross(axis, sub(p[3], p[2]))
    if length < 1e-10 or dot(n1, n1) < 1e-16 or dot(n2, n2) < 1e-16:
        reject("constraint-geometry", "A frozen dihedral contains a coincident or linear plane.")
    return math.atan2(dot(cross(n1, n2), tuple(v/length for v in axis)), dot(n1, n2))


def coordinate_delta(value, target, kind):
    delta = value-target
    return math.atan2(math.sin(delta), math.cos(delta)) if kind == "D" else delta


def _bond_perception_module():
    try:
        import bond_perception
    except ModuleNotFoundError:
        import importlib.util
        from pathlib import Path
        spec = importlib.util.spec_from_file_location('bond_perception', Path(__file__).with_name('bond_perception.py'))
        bond_perception = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bond_perception)
    return bond_perception


def composite_perceive(request, structure, *, finite_session=None):
    return _bond_perception_module().perceive(request, structure, reject, session=finite_session)


def perceive(request, structure):
    if request.get("bondPerceptionPolicy") == "composite-v1":
        return composite_perceive(request, structure)[0]
    if request.get("bondPerceptionPolicy") == "coordinate-import":
        return perceive_import(request, structure)
    # Start without covalent edges; merge/protected-edge policy belongs to domain.
    blank = copy.deepcopy(structure)
    blank["bonds"] = []
    mol = molecule(blank, sanitize=False)
    factor = {"conservative": 1.10, "standard": 1.30, "aggressive": 1.50}.get(request.get("aggression", "standard"))
    if factor is None:
        reject("aggression", "Unknown bond-perception aggression.")
    charge = structure.get("charge")
    if charge is None:
        charge = sum(a.get("formalCharge", 0) for a in structure["atoms"])
    try:
        rdDetermineBonds.DetermineBonds(mol, charge=charge, covFactor=factor, useVdw=True,
                                       allowChargedFragments=True, embedChiral=False)
    except Exception:
        reject("bond-perception", "No consistent bond orders were found for these coordinates and charge; the original model is unchanged.")
    if [a.GetFormalCharge() for a in mol.GetAtoms()] != [a.get("formalCharge", 0) for a in structure["atoms"]]:
        reject("perception-charge-change", "The candidate would change atom formal charges; no candidate was accepted.")
    output = copy.deepcopy(structure)
    output["bonds"] = [dict(a=b.GetBeginAtomIdx(), b=b.GetEndAtomIdx(),
                            order=1.5 if b.GetIsAromatic() else b.GetBondTypeAsDouble(),
                            **({"aromatic": True} if b.GetIsAromatic() else {})) for b in mol.GetBonds()]
    output["bondSource"] = "inferred"
    output.pop("molfile", None)
    return output


def _perceive_import_local_fallback(request, structure, charge):
    # The strict importer remains the first choice. A failed global order
    # assignment may still contain sound local rings/functional groups.
    blank = copy.deepcopy(structure)
    blank['bonds'] = []
    blank['charge'] = charge
    blank['multiplicity'] = 1
    output, _ = composite_perceive(dict(request, bondPerceptionPolicy='composite-v1'), blank)
    if not output['bonds'] or any(b.get('kind') == 'coordination' for b in output['bonds']):
        reject('bond-perception', 'No ordinary local covalent candidate could be recovered; the source structure is unchanged.')
    sanitized = False
    radical_indices = []
    try:
        probe = molecule(output)
        radical_indices = [atom.GetIdx() for atom in probe.GetAtoms() if atom.GetNumRadicalElectrons()]
        if radical_indices:
            raise ValueError('unresolved radical state')
        sanitized = True
    except Exception:
        # Preserve certain local groups even when the reaction region has no
        # closed-shell Lewis representation. Ordinary engines are blocked by
        # this issue, rather than silently parameterizing inferred radicals.
        issues = output.setdefault('bondPerceptionIssues', [])
        if radical_indices:
            atom = radical_indices[0]
            adjacent = next((b for b in output['bonds'] if atom in (b['a'], b['b'])), None)
            if adjacent:
                pair = [adjacent['a'], adjacent['b']]
            else:
                other = min((i for i in range(len(output['atoms'])) if i != atom), key=lambda i: math.dist(coordinates(output)[atom], coordinates(output)[i]))
                pair = [atom, other]
        else:
            pair = [output['bonds'][0]['a'], output['bonds'][0]['b']]
        atom_ids = [output['atoms'][i]['id'] for i in sorted(pair)]
        issue = dict(atomIds=atom_ids, kind='unresolved', reason='The strict import failed and the local candidate has unresolved valence/electronic state; confirm this region before using the inferred graph.')
        previous = next((i for i, value in enumerate(issues) if set(value['atomIds']) == set(atom_ids)), None)
        if previous is None:
            issues.append(issue)
        else:
            issues[previous] = issue
    for key in ('charge', 'multiplicity'):
        if key in structure:
            output[key] = structure[key]
        else:
            output.pop(key, None)
    output.pop('molfile', None)
    status = 'A sanitized closed-shell covalent graph was recovered; reaction contacts remain uncertain.' if sanitized else 'The partial local graph remains unresolved; confirm or edit this region before using the inferred graph.'
    output.setdefault('notes', []).append(f'RDKit {VERSION} strict coordinate-import order assignment failed; a local distance-based fallback retained recoverable functional groups. Molecular identity and hydrogen completeness are not confirmed. {status} Source charge and multiplicity were retained.')
    if structure.get('charge') is None:
        output['notes'].append('Neutral charge 0 was assumed for bond perception only; source charge and multiplicity remain unchanged and calculation electronic state is not confirmed.')
    # Make a partial result explicit even when native failure did not name a
    # particular long contact. One graph edge is an annotation anchor only.
    if not output.get('bondPerceptionIssues'):
        bond = output['bonds'][0]
        output['bondPerceptionIssues'] = [dict(atomIds=[output['atoms'][i]['id'] for i in (bond['a'], bond['b'])], kind='partial',
                                            reason='Strict global bond-order assignment failed; this locally recovered ordinary graph is a partial distance-based candidate.')]
    return output


def perceive_import(request, structure):
    """A bounded explicit-atom import candidate, separate from manual policy."""
    if "bonds" in structure:
        reject("import-bond-table", "Coordinate-import perception cannot replace an existing connection table, including an explicitly empty table.")
    if structure.get("dimension", 3) != 3:
        reject("perception-dimension", "Coordinate-import bond perception requires actual three-dimensional coordinates.")
    multiplicity = structure.get("multiplicity")
    if multiplicity is not None and (not isinstance(multiplicity, int) or isinstance(multiplicity, bool) or multiplicity != 1):
        reject("perception-electronic-state", "Coordinate-import bond-order inference does not establish an open-shell electronic state; the source structure is unchanged.")
    # Metal coordination is not a covalent bond-order inference task. This
    # element gate is not a force-field coverage claim or an H-completeness test.
    nonmetals = {"H", "He", "B", "C", "N", "O", "F", "Ne", "Si", "P", "S", "Cl", "Ar",
                 "Ge", "As", "Se", "Br", "Kr", "Te", "I", "Xe"}
    if any(atom["element"] not in nonmetals for atom in structure["atoms"]):
        reject("perception-elements", "Coordinate-import inference does not establish metal coordination or unsupported-element bond orders; the source structure is unchanged.")
    charge = structure.get("charge")
    assumed_neutral = charge is None
    if assumed_neutral:
        charge = 0
    if not isinstance(charge, int) or isinstance(charge, bool):
        reject("perception-charge", "The source total charge must be an integer for coordinate-import bond perception.")
    electrons = sum(Chem.GetPeriodicTable().GetAtomicNumber(a['element']) for a in structure['atoms'])-charge
    if electrons < 1 or electrons % 2:
        reject('perception-electronic-state', 'Coordinate-import singlet inference requires an even explicit electron count; the source electronic state was not changed.')
    declared_charges = any("formalCharge" in atom for atom in structure["atoms"])
    blank = copy.deepcopy(structure)
    blank["bonds"] = []
    mol = molecule(blank, sanitize=False)
    factor = {"conservative": 1.10, "standard": 1.30, "aggressive": 1.50}.get(request.get("aggression", "standard"))
    if factor is None:
        reject("aggression", "Unknown bond-perception aggression.")
    try:
        rdDetermineBonds.DetermineBonds(mol, charge=charge, covFactor=factor, useVdw=True,
                                       allowChargedFragments=True, embedChiral=False)
        # Keep stereochemistry assignment disabled; sanitization on this
        # candidate copy supplies actual aromaticity rather than ring guesses.
        candidate = Chem.Mol(mol)
        Chem.SanitizeMol(candidate)
    except Exception:
        return _perceive_import_local_fallback(request, structure, charge)
    if candidate.GetNumAtoms() != len(structure["atoms"]):
        reject("perception-identity", "The candidate changed the explicit atom count; no candidate was accepted.")
    conf = candidate.GetConformer()
    source_positions = coordinates(structure)
    for i, item in enumerate(structure["atoms"]):
        atom = candidate.GetAtomWithIdx(i)
        pos = conf.GetAtomPosition(i)
        if (not atom.HasProp("_StableId") or atom.GetProp("_StableId") != item["id"]
                or atom.GetSymbol() != item["element"] or (pos.x, pos.y, pos.z) != source_positions[i]
                or atom.GetNumImplicitHs() or atom.GetNumExplicitHs()):
            reject("perception-identity", "The candidate changed an explicit atom identity, coordinate or hidden hydrogen count; no candidate was accepted.")
        if atom.GetNumRadicalElectrons():
            reject("perception-electronic-state", "The bond-order candidate contains radical electrons; coordinate-only inference cannot confirm its electronic state.")
    inferred_charges = [atom.GetFormalCharge() for atom in candidate.GetAtoms()]
    if sum(inferred_charges) != charge:
        reject("perception-charge-change", "The candidate formal charges do not match the source total charge or neutral inference assumption; no candidate was accepted.")
    source_charges = [atom.get("formalCharge", 0) for atom in structure["atoms"]]
    if declared_charges and inferred_charges != source_charges:
        reject("perception-charge-change", "The candidate would change atom formal charges; no candidate was accepted.")
    output = copy.deepcopy(structure)
    output["bonds"] = [dict(a=b.GetBeginAtomIdx(), b=b.GetEndAtomIdx(),
                            order=1.5 if b.GetIsAromatic() else b.GetBondTypeAsDouble(),
                            **({"aromatic": True} if b.GetIsAromatic() else {})) for b in candidate.GetBonds()]
    output["bondSource"] = "inferred"
    output.pop("molfile", None)
    output.pop('bondPerceptionIssues', None)
    issues = _bond_perception_module().strict_contact_issues(output)
    if issues:
        output['bondPerceptionIssues'] = issues
    notes = output.setdefault("notes", [])
    notes.append(f"RDKit {VERSION} inferred connectivity and bond orders from the supplied explicit atoms; no atoms or hydrogens were added. Molecular identity and hydrogen completeness are not confirmed.")
    notes.append("Neutral charge 0 was assumed for bond perception only; source charge and multiplicity remain unchanged and calculation electronic state is not confirmed." if assumed_neutral
                 else f"Bond perception used source total charge {charge}; source charge and multiplicity remain unchanged and calculation electronic state is not confirmed.")
    if not declared_charges and inferred_charges != source_charges:
        for item, atom_charge in zip(output["atoms"], inferred_charges):
            item["formalCharge"] = atom_charge
        notes.append(f"RDKit {VERSION} inferred the per-atom formal-charge distribution for this bond-order candidate; no source atom formal charges were supplied.")
    return output


def convert(request, structure):
    fmt = request.get("format")
    if fmt == "mol2":
        reject("format-removed", "MOL2 import and export are no longer supported; use MOL or SDF.")
    if fmt in ("gjf", "com"):
        reject("dedicated-gaussian-writer", "Gaussian input must use the dedicated syntax-preserving generator.")
    if fmt in ("cif", "poscar", "extxyz"):
        reject("dedicated-periodic-writer", "Use the existing explicit-cell writer for periodic and extended-coordinate formats.")
    if fmt == "xyz":
        return str(len(structure["atoms"])) + "\nEster Studio explicit coordinates\n" + "\n".join(
            f'{a["element"]} {a["x"]:.12g} {a["y"]:.12g} {a["z"]:.12g}' for a in structure["atoms"]) + "\n", "RDKit"
    if fmt in ("mol", "sdf", "pdb") and any(b.get("fractional") is True for b in structure.get("bonds", [])):
        # Actual installed probes: RDKit V2000 emits type 0 for ONEANDAHALF;
        # Never advertise either substitution as a faithful chemical export.
        reject("fractional-format", "This native chemical format cannot faithfully represent an explicit non-aromatic fractional connection; use a coordinate/input format or edit the connection explicitly.")
    explicit_cell = bool(structure.get('cell')) or periodic(structure)
    if explicit_cell and fmt != "sdf":
        reject("periodic-format-loss", "This molecule format would discard the periodic cell; use an explicit cell format.")
    # Assign native stereochemistry when the graph is valid, but retain the
    # raw explicit graph for format writers when users are editing valence.
    if explicit_cell:
        # SDF is only an explicit connection-table serialization here. The
        # file port adds the authoritative cell/images in standard data fields;
        # no periodic perception, force field or connectivity repair is run.
        mol = molecule(structure, sanitize=False)
    else:
        try:
            mol = molecule(structure)
        except Rejected:
            mol = molecule(structure, sanitize=False)
    if fmt in ("mol", "sdf"):
        text = Chem.MolToMolBlock(mol, includeStereo=True, kekulize=False, forceV3000=len(structure["atoms"]) > 999)
        if fmt == "sdf":
            text += "\n>  <SCIYUE_ATOM_IDS>\n" + json.dumps([a["id"] for a in structure["atoms"]]) + "\n\n$$$$\n"
        return text, "RDKit"
    if fmt == "pdb":
        return Chem.MolToPDBBlock(mol), "RDKit"
    reject("format", "Unsupported native output format.")


def run(request, *, finite_session=None):
    structure = validate(request)
    warnings = []
    extra = {}
    engine = ENGINE
    operation = request["operation"]
    if operation != "perceive-bonds":
        output = copy.deepcopy(structure)
    if operation == "generate3d":
        require_resolved_perception(structure)
        if any(b.get("fractional") is True for b in structure.get("bonds", [])):
            reject("fractional-parameterization", "3D embedding requires a supported molecular bond representation.", diagnostics.fractional_connections(structure))
        mol = generation_molecule(structure, request.get('sourceStereo'))
        original_graph = native_graph_signature(mol)
        failure = None
        for attempt, (seed, random_coordinates) in enumerate(((0x511, True), (0x512, True), (0x513, False)), 1):
            candidate = Chem.Mol(mol)
            parameters = AllChem.ETKDGv3()
            parameters.randomSeed = seed
            parameters.numThreads = 1
            parameters.enforceChirality = True
            parameters.useRandomCoords = random_coordinates
            if AllChem.EmbedMolecule(candidate, parameters) != 0:
                continue
            if native_graph_signature(candidate) != original_graph:
                reject("graph-change", "3D embedding changed the explicit chemical graph.")
            proposed = with_coordinates(structure, candidate)
            try:
                check_stereo(structure, proposed, generation=True, reference=mol)
            except Rejected as error:
                if error.code != 'stereo-change':
                    raise
                failure = error
                continue
            output = proposed
            if attempt > 1:
                warnings.append(f"ETKDGv3 produced a verified geometry on attempt {attempt} (seed {seed}, random coordinates: {random_coordinates}).")
            break
        else:
            if failure is not None:
                raise failure
            reject("embedding", "ETKDGv3 could not generate this explicit graph after three attempts; no atoms or hydrogens were added.")
        warnings.append("ETKDG generated explicit-atom coordinates; no force-field optimization or convergence is implied.")
    elif operation == "perceive-bonds":
        if request.get("bondPerceptionPolicy") == "composite-v1":
            output, extra["bondPerceptionSummary"] = composite_perceive(request, structure, finite_session=finite_session)
            extra["bondPerceptionPolicy"] = "composite-v1"
            warnings.extend(output.get("notes", [])[len(structure.get("notes", [])):])
        else:
            output = perceive(request, structure)
        if request.get("bondPerceptionPolicy") == "coordinate-import":
            extra["bondPerceptionPolicy"] = "coordinate-import"
            warnings.extend(output.get("notes", [])[len(structure.get("notes", [])):])
        warnings.append("These are candidate bonds; domain merge must apply protected edges and deleted-bond exclusions.")
    else:
        extra["text"], engine = convert(request, structure)
        extra["format"] = request["format"]
        if request["format"] != "sdf":
            warnings.append("This chemical format does not preserve application stable IDs or all modeling assignments; reload uses the format's actual fields.")
    engine_version = VERSION
    return dict(stamp=request.get("stamp"), operation=operation, structure=output,
                movableAtomIds=request["movableAtomIds"], engine=engine,
                engineVersion=engine_version, warnings=warnings, **extra)


def main():
    request = {}
    try:
        payload = sys.stdin.buffer.read()
        decoded = json.loads(payload.decode("utf-8"), parse_constant=lambda _: reject("request", "Non-finite JSON numbers are not supported."))
        if not isinstance(decoded, dict):
            reject("request", "Expected one JSON request object.")
        request = decoded
        result = run(request)
        status = 0
    except Exception as exc:
        result = dict(stamp=request.get("stamp"), operation=request.get("operation"),
                      structure=request.get("structure"), movableAtomIds=request.get("movableAtomIds", []),
                      engine=ENGINE, engineVersion=VERSION, warnings=[],
                      error=error_payload(exc, "The native operation failed; the original structure is unchanged."))
        status = 1
    sys.stdout.write(json.dumps(result, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n")
    return status


if __name__ == "__main__":
    if "--capabilities" in sys.argv:
        capabilities = dict(schema="sciyue-native-capabilities/v1", periodicGfn2BondOrders=False)
        try:
            import importlib.metadata
            import xtb_periodic_bonds
            from tblite.interface import Calculator
            from tblite.library import get_version
            if callable(xtb_periodic_bonds.PeriodicBondEvaluator) and callable(Calculator):
                capabilities.update(periodicGfn2BondOrders=True, module="xtb_periodic_bonds",
                                    tbliteVersion=importlib.metadata.version("tblite"),
                                    libraryVersion=".".join(map(str, get_version())))
        except Exception:
            pass
        print(json.dumps(capabilities, allow_nan=False, separators=(",", ":")))
        raise SystemExit(0)
    if "--crystal-modeling" in sys.argv:
        import crystal_modeling
        raise SystemExit(crystal_modeling.main())
    if "--crystal-modeling-worker" in sys.argv:
        import crystal_worker
        raise SystemExit(crystal_worker.main())
    if "--xtb-periodic" in sys.argv:
        import xtb_periodic
        raise SystemExit(xtb_periodic.main())
    if "--advanced-path" in sys.argv:
        import advanced_path
        raise SystemExit(advanced_path.main())
    if "--conformer-sampling" in sys.argv:
        import conformer_sampling
        raise SystemExit(conformer_sampling.main())
    if "--electronic-analysis" in sys.argv:
        import electronic_analysis_worker
        raise SystemExit(electronic_analysis_worker.main())
    if "--interactions" in sys.argv:
        import interaction_worker
        raise SystemExit(interaction_worker.main())
    if "--surface" in sys.argv:
        import surface_worker
        raise SystemExit(surface_worker.main())
    if "--empirical-worker" in sys.argv:
        import empirical_worker
        raise SystemExit(empirical_worker.main(run=run, error_payload=error_payload))
    if "--analysis" in sys.argv:
        import wavefunction_analysis
        raise SystemExit(wavefunction_analysis.main())
    if "--orbitals" in sys.argv:
        import orbitals_worker
        raise SystemExit(orbitals_worker.main())
    if "--dynamics" in sys.argv:
        import dynamics
        raise SystemExit(dynamics.main())
    raise SystemExit(main())
