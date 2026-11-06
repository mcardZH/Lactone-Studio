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
        reject('perception-unresolved', 'This partial bond-perception candidate has unresolved local chemistry; confirm or edit that region before ordinary force-field optimization, MD or embedding.')


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
    return bool(structure.get("cell")) or any(
        any(b.get("image", [0, 0, 0])) for b in structure.get("bonds", [])
    )


def validate_periodic_cell(structure):
    """Fixed-cell mechanical admission; axes are evidence, not a vacuum guess."""
    cell = structure.get('cell')
    if not isinstance(cell, dict) or not isinstance(cell.get('pbc'), list) or len(cell['pbc']) != 3 or any(type(v) is not bool for v in cell['pbc']):
        reject('periodic-cell', 'Periodic geometry needs a complete cell and three explicit periodic-axis flags.')
    provenance = cell.get('pbcProvenance')
    if provenance is not None and (not isinstance(provenance, dict) or provenance.get('kind') not in ('source-explicit', 'format-defined', 'user-confirmed', 'unconfirmed') or not isinstance(provenance.get('evidence'), str) or not provenance['evidence'].strip()):
        reject('periodic-axes-provenance', 'Periodic-axis provenance is malformed.')
    if provenance and provenance.get('kind') == 'unconfirmed':
        reject('periodic-axes-unconfirmed', 'The periodic axes have not been confirmed from source or by the user.')
    vectors = cell.get('vectors')
    if not isinstance(vectors, list) or len(vectors) != 3 or any(not isinstance(row, list) or len(row) != 3 or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in row) for row in vectors):
        reject('periodic-cell', 'Cell vectors must be a finite 3 by 3 Angstrom matrix.')
    a, b, c = vectors
    volume = a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0])
    if abs(volume) < 1e-10:
        reject('periodic-cell', 'A singular cell cannot define periodic geometry.')
    origin = cell.get('origin', [0, 0, 0])
    if not isinstance(origin, list) or len(origin) != 3 or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in origin):
        reject('periodic-cell', 'Cell origin must be finite.')
    return cell


def validate(request):
    if request.get("operation") not in ("optimize", "generate3d", "perceive-bonds", "convert", "geometry"):
        reject("operation", "Unsupported chemistry operation.")
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
    if any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
        reject("atom-identity", "Every explicit atom needs a unique stable ID.")
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
    if not isinstance(movable, list) or len(set(movable)) != len(movable) or any(i not in ids for i in movable):
        reject("movable-identity", "Movable atoms must be unique IDs in the current model.")
    seen = set()
    periodic_geometry = request['operation'] == 'geometry' and bool(structure.get('cell'))
    if periodic_geometry:
        cell = validate_periodic_cell(structure)
        if request.get('constraints'):
            reject('periodic-internal-constraints', 'Periodic mechanical geometry currently supports atomic freezes only; image-aware B/A/D execution is not available.')
    for bond in structure.get("bonds", []):
        a, b = bond.get("a"), bond.get("b")
        image = bond.get('image', [0, 0, 0])
        if periodic_geometry and (not isinstance(image, list) or len(image) != 3 or any(type(v) is not int or abs(v) > 1000000 or v and not cell['pbc'][i] for i, v in enumerate(image))):
            reject('periodic-bond-image', 'A periodic relation needs a finite integer image on confirmed periodic axes.')
        if not isinstance(a, int) or not isinstance(b, int) or min(a, b) < 0 or max(a, b) >= len(atoms) or a == b and not (periodic_geometry and any(image)):
            reject("bond-identity", "Bond indices must reference two distinct current atoms.")
        pair = (min(a, b), max(a, b), tuple(image if a <= b else [-v for v in image])) if periodic_geometry else tuple(sorted((a, b)))
        if periodic_geometry and a == b and next((v for v in image if v), 0) < 0:
            pair = (a, b, tuple(-v for v in image))
        if pair in seen:
            reject("duplicate-bond", "Duplicate bond objects cannot parameterize a force field.")
        seen.add(pair)
        if bond.get('orderKnown') is False and (bond.get('perception') not in ('periodic-distance', 'empirical-distance') or bond.get('perception') == 'periodic-distance' and not structure.get('cell') or bond.get('order') != 1 or bond.get('mbo') is not None or bond.get('aromatic') or bond.get('fractional')):
            reject('periodic-bond-order', 'An empirical relation is unknown-order connectivity, not a measured chemical bond order.')
        empirical_rebuild = request['operation'] == 'perceive-bonds' and policy == 'composite-v1' and bond.get('perception') == 'empirical-distance'
        if bond.get('orderKnown') is False and request['operation'] != 'geometry' and not empirical_rebuild and not (request['operation'] == 'convert' and request.get('format') == 'xyz'):
            reject('unknown-bond-order', 'Unknown-order periodic connectivity cannot be passed off as force-field or molecular bond typing.')
        coordinate_export = request['operation'] == 'convert' and request.get('format') == 'xyz'
        if bond.get("order") not in (0.5, 1, 1.5, 2, 3) or (bond.get("kind") == "coordination" and request["operation"] != "geometry" and not coordinate_export and policy != "composite-v1"):
            reject("bond-type", "Auxiliary and coordination bonds require explicit compatible chemistry; they are not force-field covalent bonds.")
        if (bond.get("order") == .5 and bond.get("fractional") is not True or
                bond.get("fractional") is True and (bond.get("order") not in (.5, 1.5) or bond.get("aromatic") is True)):
            reject("bond-type", "An explicit fractional connection must have order 0.5 or 1.5 and must not be aromatic; order 0.5 requires fractional metadata.")
    if request["operation"] != "convert":
        if periodic(structure) and not periodic_geometry:
            reject("periodic-unsupported", "Native molecule generation, force fields and bond perception do not support periodic models.")
        if request["operation"] in ("optimize", "generate3d", "geometry") and not movable:
            reject("no-movable-atoms", "There are no explicitly movable atoms.")
    if request["operation"] == "generate3d" and set(movable) != set(ids):
        reject("partial-generation", "3D generation requires the entire explicit molecule to be movable; use local optimization for a selection.")
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
            reject("fractional-representation", "This RDKit molecule adapter cannot faithfully represent order 0.5; use coordinate export or mechanical geometry without sanitizing the measured graph.")
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
            reject("charge-mismatch", "Overall charge and explicit atom formal charges disagree; native force fields cannot assign a charge distribution silently.")
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
            # This ordering has a positive determinant.
            points = ((1, 0, 0), (0, 1, 0), (0, 0, 1), (0, 0, 0))
            for j, p in zip(neighbours, points):
                conf.SetAtomPosition(j, (p[0] * parity, p[1], p[2]))
            Chem.AssignAtomChiralTagsFromStructure(tmp, replaceExistingTags=True)
            mol.GetAtomWithIdx(i).SetChiralTag(tmp.GetAtomWithIdx(i).GetChiralTag())
        Chem.AssignStereochemistry(mol, cleanIt=False, force=True)
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


def check_stereo(before, after, generation=False):
    bt, bd = stereo_geometry(before)
    at, ad = stereo_geometry(after)
    for i, prior in bt.items():
        expected = before["atoms"][i]["stereoParity"] if generation else prior
        if not expected or at.get(i) != expected:
            reject("stereo-change", "Automatic geometry changed or flattened specified tetrahedral stereochemistry.")
    for key, prior in bd.items():
        if prior and ad.get(key) != prior:
            a, b, left, right = key
            reject("stereo-change", "Automatic geometry changed or flattened an existing double-bond configuration.",
                   {"kind": "double-bond-geometry", "bondAtomIds": [before["atoms"][i]["id"] for i in (a, b)],
                    "referenceAtomIds": [before["atoms"][i]["id"] for i in (left, right)],
                    "beforeSign": prior, "afterSign": ad.get(key)})
    # Independently read actual final geometry. Do not allow declared parity or
    # cached wedge metadata to mask an inversion in the returned XYZ.
    expected = molecule(before)
    actual = molecule(after, declared_stereo=False)
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
                reject("stereo-change", "Native stereochemical validation detected an E/Z inversion or loss.")


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
    # MMFF's aromaticity typing may differ internally; compare a sanitized
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


def constrained_minimize(request, structure, mol, ff, steps, warnings):
    try:
        import numpy as np
        from scipy import __version__ as scipy_version
        from scipy.optimize import minimize
    except ImportError:
        reject("constraint-dependency", "Exact internal-coordinate optimization requires the existing SciPy runtime; it is unavailable.")
    ids = {a["id"]: i for i, a in enumerate(structure["atoms"])}
    positions = np.asarray(coordinates(structure), dtype=float)
    movable = set(request["movableAtomIds"])
    variable_indices = [3*i+j for i, a in enumerate(structure["atoms"]) if a["id"] in movable for j in range(3)]
    initial = positions.ravel().copy()
    rows = []
    for item in request.get("constraints", []):
        if item["action"] != "freeze":
            continue
        indices = tuple(ids[i] for i in item["atomIds"])
        rows.append((item, indices, internal_value(positions, item["type"], indices)))

    def full(x):
        # Fixed XYZ are copied unchanged, never solver variables or restored
        # after a global minimization. Only movable coordinates are substituted.
        flat = initial.copy()
        flat[variable_indices] = x
        return flat

    def energy(x):
        value = ff.CalcEnergy(full(x).tolist())
        if not math.isfinite(value):
            reject("energy", "Constrained force-field energy became non-finite.")
        return value

    def gradient(x):
        values = np.asarray(ff.CalcGrad(full(x).tolist()))[variable_indices]
        if not np.all(np.isfinite(values)):
            reject("gradient", "Constrained force-field gradients became non-finite.")
        return values

    active, keys = [], set()
    for item, indices, target in rows:
        # Constraints on fixed points are already satisfied exactly. Identical
        # rows need one equality, while every requested row is checked below.
        if not any(structure["atoms"][i]["id"] in movable for i in indices):
            continue
        key = (item["type"], min(indices, indices[::-1]))
        if key in keys:
            continue
        keys.add(key)
        active.append(dict(type="eq", fun=lambda x, row=(item, indices, target): coordinate_delta(
            internal_value(full(x).reshape((-1, 3)), row[0]["type"], row[1]), row[2], row[0]["type"])))
    result = minimize(energy, initial[variable_indices], jac=gradient, method="SLSQP", constraints=active,
                      options=dict(maxiter=steps, ftol=1e-9, disp=False))
    if not result.success and result.status != 9:
        reject("constraint-solver", "The exact internal-coordinate solver could not resolve this constraint set; the input structure is unchanged.")
    final = full(result.x).reshape((-1, 3))
    residuals = []
    for item, indices, target in rows:
        actual = internal_value(final, item["type"], indices)
        residual = coordinate_delta(actual, target, item["type"])
        tolerance = 1e-6 if item["type"] == "B" else 1e-5
        if abs(residual) > tolerance:
            reject("constraint-residual", "A frozen internal coordinate exceeded its verified residual tolerance; the result was rejected.")
        scale = 1 if item["type"] == "B" else 180/math.pi
        residuals.append(dict(id=item.get("id"), type=item["type"], target=target*scale,
                              actual=actual*scale, residual=residual*scale,
                              unit="angstrom" if item["type"] == "B" else "degree"))
    conf = mol.GetConformer()
    for i, atom in enumerate(structure["atoms"]):
        if atom["id"] in movable:
            conf.SetAtomPosition(i, final[i].tolist())
    warnings.append(f"Frozen internal coordinates used SciPy {scipy_version} SLSQP equality constraints on movable XYZ only; verified tolerance is 1e-6 angstrom / 1e-5 radian.")
    return (0 if result.success else 1), residuals


def optimize(request, structure, mol, warnings):
    # The installed standard MMFF/UFF path has not validated the full potential
    # for ONEANDAHALF edges. Never replace them with SINGLE/DOUBLE or silently
    # omit bonded terms. Mechanical geometry clean is a separate explicit mode.
    if any(b.get("fractional") is True for b in structure.get("bonds", [])):
        reject("fractional-parameterization", "Standard force fields are not validated for explicit fractional connections; choose mechanical geometry clean without changing the graph.", diagnostics.fractional_connections(structure))
    original_graph = native_graph_signature(mol)
    choice = request.get("forcefield", "auto")
    if choice not in ("auto", "MMFF94", "MMFF94s", "UFF"):
        reject("forcefield", "Unknown force-field selection.")
    variant = "MMFF94s" if choice == "MMFF94s" else "MMFF94"
    ff = None
    actual = variant
    if choice != "UFF":
        if AllChem.MMFFHasAllMoleculeParams(mol):
            props = AllChem.MMFFGetMoleculeProperties(mol, mmffVariant=variant)
            if props is None:
                reject("parameterization", "MMFF properties could not be constructed for the explicit graph.")
            ff = AllChem.MMFFGetMoleculeForceField(mol, props, ignoreInterfragInteractions=False)
            if ff is None:
                reject("parameterization", "MMFF setup failed after parameter coverage; UFF fallback is only for missing parameters.")
        else:
            warnings.append(variant + " lacks parameters for this explicit graph; using UFF.")
    if ff is None:
        actual = "UFF"
        if not AllChem.UFFHasAllMoleculeParams(mol):
            reject("parameterization", "Neither the requested MMFF path nor UFF has parameters for the explicit graph.", diagnostics.uff_missing_types(mol, structure))
        ff = AllChem.UFFGetMoleculeForceField(mol, ignoreInterfragInteractions=False)
        if ff is None:
            reject("parameterization", "UFF setup failed for the explicit graph.")
    movable = set(request["movableAtomIds"])
    fixed = [i for i, a in enumerate(structure["atoms"]) if a["id"] not in movable]
    for i in fixed:
        ff.AddFixedPoint(i)
    ff.Initialize()
    before = ff.CalcEnergy()
    steps = request.get("steps", 500)
    if not isinstance(steps, int) or isinstance(steps, bool) or not 1 <= steps <= 2147483647:
        reject("steps", "Optimization steps must be a positive signed 32-bit integer supported by RDKit.")
    extra = {}
    freezes = [c for c in request.get("constraints", []) if c["action"] == "freeze"]
    if any(c["action"] == "scan" for c in request.get("constraints", [])):
        warnings.append("Scan coordinates are not frozen and no force-field scan was performed.")
    if freezes:
        status, extra["constraintResiduals"] = constrained_minimize(request, structure, mol, ff, steps, warnings)
    else:
        status = ff.Minimize(maxIts=steps, forceTol=1e-4, energyTol=1e-6)
    after = ff.CalcEnergy()
    if not math.isfinite(before) or not math.isfinite(after):
        reject("energy", "Force-field energy is non-finite; no coordinates were accepted.")
    if native_graph_signature(mol) != original_graph:
        reject("graph-change", "Native force-field setup or optimization changed the explicit chemical graph.")
    output = with_coordinates(structure, mol)
    for i in fixed:
        if coordinates(output)[i] != coordinates(structure)[i]:
            reject("fixed-atom-moved", "A fixed atom moved; the native result was rejected.")
    check_stereo(structure, output)
    if status:
        warnings.append("The iteration limit was reached; these are final coordinates, not a convergence claim.")
    warnings.append("Molecular force fields do not certify quantum electronic state or scientific convergence.")
    return output, dict(forcefield=actual, before=before, after=after, unit="kcal/mol", converged=status == 0, **extra)


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


def composite_perceive(request, structure):
    return _bond_perception_module().perceive(request, structure, reject)


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
    covered = False
    radical_indices = []
    try:
        probe = molecule(output)
        radical_indices = [atom.GetIdx() for atom in probe.GetAtoms() if atom.GetNumRadicalElectrons()]
        if radical_indices:
            raise ValueError('unresolved radical state')
        if not (AllChem.MMFFHasAllMoleculeParams(probe) or AllChem.UFFHasAllMoleculeParams(probe)):
            raise ValueError('no ordinary force-field coverage')
        covered = True
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
        issue = dict(atomIds=atom_ids, kind='unresolved', reason='The strict import failed and the local candidate has unresolved valence/electronic state or lacks ordinary force-field coverage; confirm this region before optimization or MD.')
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
    status = 'A sanitized closed-shell ordinary graph with native force-field coverage was recovered; reaction contacts remain uncertain.' if covered else 'The partial local graph remains unresolved; ordinary force-field optimization, MD and embedding require that region to be confirmed or edited.'
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
    if periodic(structure) and fmt != "sdf":
        reject("periodic-format-loss", "This molecule format would discard the periodic cell; use an explicit cell format.")
    # Assign native stereochemistry when the graph is valid, but retain the
    # raw explicit graph for format writers when users are editing valence.
    if periodic(structure):
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


def run(request):
    structure = validate(request)
    warnings = []
    output = copy.deepcopy(structure)
    extra = {}
    engine = ENGINE
    operation = request["operation"]
    if operation in ('optimize', 'generate3d'):
        require_resolved_perception(structure)
    if operation in ("optimize", "generate3d") and any(b.get("fractional") is True for b in structure.get("bonds", [])):
        reject("fractional-parameterization", "Standard force fields and embedding are not validated for explicit fractional connections; choose mechanical geometry clean without changing the graph.", diagnostics.fractional_connections(structure))
    if operation == "optimize":
        mol = molecule(structure)
        output, extra = optimize(request, structure, mol, warnings)
    elif operation == "generate3d":
        mol = molecule(structure)
        original_graph = native_graph_signature(mol)
        parameters = AllChem.ETKDGv3()
        parameters.randomSeed = 0x511
        parameters.numThreads = 1
        parameters.enforceChirality = True
        parameters.useRandomCoords = True
        if AllChem.EmbedMolecule(mol, parameters) != 0:
            reject("embedding", "ETKDG could not generate this explicit graph; no atoms or hydrogens were added.")
        if native_graph_signature(mol) != original_graph:
            reject("graph-change", "3D embedding changed the explicit chemical graph.")
        output = with_coordinates(structure, mol)
        check_stereo(structure, output, generation=True)
        warnings.append("ETKDG generated explicit-atom coordinates; no force-field optimization or convergence is implied.")
    elif operation == "perceive-bonds":
        if request.get("bondPerceptionPolicy") == "composite-v1":
            output, extra["bondPerceptionSummary"] = composite_perceive(request, structure)
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
