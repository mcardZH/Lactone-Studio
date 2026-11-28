import { objectSchema, presentationFields, toolError, type McCall, type McTool } from './types';

const text = { type: 'string', minLength: 1 };
const database = { enum: ['pubchem', 'cod', 'rcsb'] };
const recordType = { enum: ['3d', '2d', 'entry', 'ligand-ideal'], description: 'PubChem import defaults to 3d SDF and also offers 2d. RCSB search/import defaults to entry and also offers ligand-ideal.' };
const searchFields = { query: { ...text, description: 'Required for search only. Name or ID, or an explicit queryType supported by the database.' },
  queryType: { enum: ['auto', 'id', 'name', 'inchikey', 'smiles', 'doi', 'formula'], description: 'Search only. PubChem supports name, id, inchikey and smiles; COD name, id, doi and formula; RCSB name and id.' },
  limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Search only. Number of candidates to return, default 10.' } };
const importFields = { recordId: { ...text, description: 'Required for import only. Use a specific database ID, such as PubChem CID, COD entry ID, or RCSB PDB/CCD code.' },
  revision: { type: 'integer', minimum: 1, description: 'COD import only. Omit to use the current record.' },
  destination: { ...text, description: 'Import only. Optional absolute file path for saving the exact downloaded record, with its original connectivity or other fields. An existing file is kept. Read original.status, path and sha256 for this copy.' },
  show: { type: 'boolean', description: 'Import only. Legacy display option; explicit presentation takes precedence.' },
  presentation: { ...presentationFields.presentation, description: 'Import only. Follow the workbench, keep the current view in the background, or explicitly reveal the ES window.' } };
const search = objectSchema({ action: { const: 'search' }, database, recordType, ...searchFields }, ['action', 'database', 'query']);
const importRecord = objectSchema({ action: { const: 'import' }, database, recordType, ...importFields }, ['action', 'database', 'recordId']);

export function structureSourceTool(callSource: (args: Record<string, unknown>, call: McCall) => Promise<unknown>): McTool {
  return {
    name: 'structure_source',
    description: 'Search public structure databases (give query) or import an exact record (give recordId) into the current ES project. Set destination on import to also save the unmodified downloaded record. PubChem searches name, CID, InChIKey or SMILES and retrieves 3D SDF by default (or explicitly select 2d). COD searches ID, name, DOI or Hill-format formula and imports crystal CIF, optionally by revision. RCSB searches PDB entries (legacy PDB coordinates when available) or chemical components via recordType=ligand-ideal (CCD ideal SDF). Each request goes only to the selected public database. Import with presentation=background keeps the current view.',
    inputSchema: objectSchema({ action: { enum: ['search', 'import'] }, database, recordType, ...searchFields, ...importFields }, ['action', 'database']),
    argumentValidationSchema: { type: 'object', oneOf: [search, importRecord] },
    call(args, call) {
      if (!call) throw toolError('UNAVAILABLE', '请先连接当前 ES 窗口。');
      return callSource(args, call);
    },
  };
}

export const inlineStructureFormats = ['xyz', 'extxyz', 'mol', 'sdf', 'cif', 'poscar', 'pdb'] as const;
export const inlineStructureItem = objectSchema({ text: { ...text, description: 'Exact UTF-8 structure body. No file or network access.' },
  format: { enum: inlineStructureFormats }, name: { ...text, description: 'Optional model filename or label.' },
  source: { ...text, description: 'Optional caller-supplied provenance text retained with the structure.' },
}, ['text', 'format']);
