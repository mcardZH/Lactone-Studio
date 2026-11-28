import { defaultSettings } from '../../core/gaussian';
import { createOrcaCommonSettings, type OrcaTask, type OrcaVersion } from '../../core/orca';
import {
  findSolventEntry, getSolventEntries, hasSolvation, searchSolvents, solventSelectionForModelChange, sortSolvents,
  validateSolventSelection, type SolventEntry, type SolventModel, type SolventSelection,
} from '../../core/solvents';
import type { TaskId } from '../../core/types';
import type { InputDraftConfiguration, InputDraftView, InputEngine } from './input-drafts';
import { toolError } from './types';

type Catalog = { engine: InputEngine; solventModel: SolventModel; version?: OrcaVersion | 'common' };
type SolventFields = {
  solvent: string; solventModel: SolventModel; solvation?: SolventSelection;
  version?: OrcaVersion; task?: InputDraftConfiguration['task']; inheritedRoute?: { solvent?: string };
};
type CatalogQuery = Partial<Catalog> & { query?: string };

/** Apply explicit selections as a unit. Native model-only changes can translate a retained ID. */
export function inputSolventEdit(engine: InputEngine, previous: Pick<SolventFields,'solventModel'|'solvation'>,
  patch: { solvent?: string; solventModel?: SolventModel; solvation?: SolventSelection | null }) {
  if (patch.solvation !== undefined || patch.solvent !== undefined) {
    return { ...(patch.solvation === null ? { solvent: '' } : {}), solvation: patch.solvation ?? undefined };
  }
  if (patch.solventModel === undefined || patch.solventModel === previous.solventModel) return undefined;
  return { solvation: solventSelectionForModelChange({ engine, version: engine === 'orca' ? 'common' : undefined,
    selection: previous.solvation, currentModel: previous.solventModel, nextModel: patch.solventModel }) };
}

function getFields(view: InputDraftView): SolventFields {
  const actual = view.parameters.settings as Partial<SolventFields> | undefined;
  if (actual?.solvent !== undefined && actual.solventModel !== undefined) return actual as SolventFields;
  const defaults = view.engine === 'gaussian' ? defaultSettings('optfreq') : createOrcaCommonSettings('optfreq');
  return { ...defaults, ...actual };
}

function catalogFor(view: InputDraftView, options: CatalogQuery = {}): Catalog {
  const engine = options.engine ?? view.engine;
  const current = engine === view.engine ? getFields(view)
    : engine === 'gaussian' ? defaultSettings('optfreq') : createOrcaCommonSettings('optfreq');
  const solventModel = options.solventModel ?? current.solventModel;
  if ((engine === 'gaussian' && solventModel === 'cpcm') || (engine === 'orca' && solventModel === 'iefpcm')) {
    throw toolError('INPUT_SOLVENT_MODEL_INVALID', '该输入引擎没有此溶剂模型。', {
      engine, solventModel, allowed: engine === 'gaussian' ? ['iefpcm', 'smd'] : ['cpcm', 'smd'],
    });
  }
  return { engine, solventModel, ...(engine === 'orca' ? { version: options.version ?? 'common' } : {}) };
}

function entriesFor(catalog: Catalog, retainedId?: string) {
  return getSolventEntries(catalog.engine, catalog.solventModel, catalog.version, retainedId);
}

function simplify(entry: SolventEntry, catalog: Catalog) {
  const keyword = catalog.engine === 'gaussian' ? (catalog.solventModel === 'smd' ? entry.gaussian?.smd : entry.gaussian?.pcm)
    : (catalog.solventModel === 'smd' ? entry.orca?.smd : entry.orca?.cpcm);
  return { id: entry.id, name: entry.englishName, chineseName: entry.chineseName, keyword };
}

function matchedEntries(catalog: Catalog, query: string, retainedId?: string) {
  const exact = query ? findSolventEntry(catalog.engine, catalog.solventModel, query, catalog.version) : undefined;
  const matches = searchSolvents(entriesFor(catalog, retainedId), query);
  return (exact ? [exact, ...sortSolvents(matches).filter(entry => entry.id !== exact.id)] : sortSolvents(matches, 'common'))
    .map(entry => simplify(entry, catalog));
}

export function readInputSolvent(view: InputDraftView) {
  const { solventModel, solvent, solvation, version, task, inheritedRoute } = getFields(view);
  const active = hasSolvation({ solvent, solvation });
  const catalog: Catalog = { engine: view.engine, solventModel, ...(view.engine === 'orca' ? { version: 'common' } : {}) };
  const entry = solvation?.mode === 'builtin' ? entriesFor(catalog, solvation.id).find(value => value.id === solvation.id)
    : !solvation && active ? findSolventEntry(view.engine, solventModel, solvent, catalog.version) : undefined;
  const requireRefractiveIndex = task === 'td' || task === 'tdopt' || task === 'esd';
  const current = { engine: view.engine, solventModel, solvent, solvation: solvation ?? null, ...(version ? { version } : {}),
    ...(entry ? { builtin: simplify(entry, catalog) } : {}), phase: inheritedRoute?.solvent ? 'inherited' : active ? 'solvated' : 'gas' };
  const selection = solvation ?? (entry ? { mode: 'builtin', id: entry.id } as const : undefined);
  const issues = inheritedRoute?.solvent ? [] : validateSolventSelection(selection, view.engine, solventModel, catalog.version, { requireRefractiveIndex });
  if (active && !selection && !inheritedRoute?.solvent) issues.push({ field: 'solvent', message: '来源溶剂名称未在当前软件和模型中核对。' });
  return { current, issues };
}

export function inputSolventOptions(view: InputDraftView, args: CatalogQuery) {
  const query = args.query?.trim() ?? '';
  const catalog = catalogFor(view, args);
  const { current, issues } = readInputSolvent(view);
  const entries = matchedEntries(catalog, query, catalog.engine === view.engine ? current.solvation?.id : undefined);
  return { modelRef: view.documentId, draftVersion: view.draftVersion, current, issues, catalog, query, entries,
    clearConfiguration: { engine: view.engine, settings: { solvation: null } } };
}

function recoveryFor(view: InputDraftView, catalog: Catalog, query: string, includeMatches: boolean) {
  const { current } = readInputSolvent(view);
  const target = { modelRef: view.documentId, expectedDraft: view.draftVersion };
  const candidates = includeMatches ? matchedEntries(catalog, query).slice(0, 6) : undefined;
  const lookup = { tool: 'input_solvents', arguments: { modelRef: view.documentId, ...catalog, ...(candidates?.length && query ? { query } : {}) } };
  return { modelRef: view.documentId, draftVersion: view.draftVersion, current, catalog,
    ...(candidates ? { candidates } : {}), recovery: lookup,
    clear: { tool: 'input_draft', arguments: { ...target, configuration: { engine: view.engine, settings: { solvation: null } } } } };
}

/** Reject newly requested unmapped built-ins before the native draft can change. */
export function prepareInputSolventWrite(view: InputDraftView, configuration: InputDraftConfiguration): InputDraftConfiguration {
  const { engine, task, settings } = configuration;
  const requested = settings?.solvation;
  const solvent = settings?.solvent;
  if (requested === undefined && solvent === undefined) return configuration;
  const current = getFields(view);
  if (requested === null || (requested === undefined && solvent !== undefined && !hasSolvation({ solvent }))) {
    // A round-tripped gas-phase draft must not clear unrelated confirmations.
    const existingGas = view.engine === engine && !current.solvent && !current.solvation && !current.inheritedRoute?.solvent;
    return { ...configuration, settings: { ...settings, solvent: '', solvation: existingGas ? undefined : null } };
  }
  if (requested?.mode === 'custom') return { ...configuration, settings: { ...settings, solvent: 'custom' } };

  const base = engine === view.engine && (task === undefined || task === current.task) ? current : engine === 'gaussian'
    ? defaultSettings((task ?? 'optfreq') as TaskId)
    : createOrcaCommonSettings((task ?? 'optfreq') as OrcaTask);
  const catalog = catalogFor(view, { engine, solventModel: settings?.solventModel ?? base.solventModel });
  const query = requested?.id ?? solvent ?? '';
  const found = requested?.mode === 'builtin' ? entriesFor(catalog, query).find(entry => entry.id === query)
    : findSolventEntry(engine, catalog.solventModel, query, catalog.version);
  if (found) return requested ? { ...configuration, settings: { ...settings, solvent: found.englishName } } : configuration;
  const sameExisting = engine === view.engine && base === current && catalog.solventModel === current.solventModel
    && (requested ? requested.mode === current.solvation?.mode && requested.id === current.solvation.id : solvent === current.solvent && !current.solvation);
  if (sameExisting) return configuration;
  const field = requested ? 'configuration.settings.solvation.id' : 'configuration.settings.solvent';
  throw toolError('INPUT_SOLVENT_UNRECOGNIZED', '该溶剂超出当前引擎和溶剂模型的内置目录。', {
    field, submitted: query, ...recoveryFor(view, catalog, query, true),
  });
}

export function inputSolventIssue(view: InputDraftView) {
  const { current, issues } = readInputSolvent(view);
  if (!issues.length) return undefined;
  const query = current.solvation?.id ?? current.solvent;
  const catalog = catalogFor(view);
  return { issues, ...recoveryFor(view, catalog, query, Boolean(query)) };
}
