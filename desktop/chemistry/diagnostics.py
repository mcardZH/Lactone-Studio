"""Optional, best-effort failure evidence; never changes the working molecule.

RDKit 2025.03.6 primary sources:
Code/GraphMol/MolOps.cpp: detectChemistryProblems copies its input and returns
sanitization exceptions with GetAtomIdx/GetAtomIndices in the Python wrapper.
Code/GraphMol/ForceFieldHelpers/UFF/AtomTyper.cpp: getAtomTypes (used by
UFFHasAllMoleculeParams) and getUFFVdWParams use the same getAtomLabel and
ParamCollection lookup. Querying (i, i) isolates missing atomic UFF parameters.
https://github.com/rdkit/rdkit/blob/Release_2025_03_6/Code/GraphMol/ForceFieldHelpers/UFF/AtomTyper.cpp

These diagnostics establish problem locations, not alternative chemistry or a
force field's scientific validity. Unknown failure locations remain absent.
"""
from rdkit import Chem
from rdkit.Chem import AllChem


def _ids(structure, indices, mol=None):
    atoms = structure["atoms"]
    ids = [atom["id"] for atom in atoms]
    if (any(not isinstance(item, str) or not item for item in ids)
            or len(set(ids)) != len(ids)):
        return []
    if mol is not None:
        if mol.GetNumAtoms() != len(ids):
            return []
        for i, atom_id in enumerate(ids):
            atom = mol.GetAtomWithIdx(i)
            if not atom.HasProp("_StableId") or atom.GetProp("_StableId") != atom_id:
                return []
    indices = sorted(set(indices))
    if any(not isinstance(i, int) or isinstance(i, bool) or not 0 <= i < len(ids)
           for i in indices):
        return []
    return [ids[i] for i in indices]


def _evidence(phase, atom_ids):
    result = dict(schema=1, phase=phase)
    if atom_ids:
        result["atomIds"] = atom_ids
    return result


def sanitization(mol, structure):
    try:
        probe = Chem.Mol(mol)
        indices = []
        for problem in Chem.DetectChemistryProblems(probe):
            if hasattr(problem, "GetAtomIdx"):
                indices.append(problem.GetAtomIdx())
            elif hasattr(problem, "GetAtomIndices"):
                indices.extend(problem.GetAtomIndices())
        return _evidence("sanitization", _ids(structure, indices, probe))
    except Exception:
        return {}


def uff_missing_types(mol, structure):
    try:
        probe = Chem.Mol(mol)
        indices = [i for i in range(probe.GetNumAtoms())
                   if AllChem.GetUFFVdWParams(probe, i, i) is None]
        return _evidence("parameterization", _ids(structure, indices, probe))
    except Exception:
        return {}


def fractional_connections(structure):
    try:
        indices = [i for bond in structure.get("bonds", []) if bond.get("fractional") is True
                   for i in (bond["a"], bond["b"])]
        return _evidence("parameterization", _ids(structure, indices))
    except Exception:
        return {}
