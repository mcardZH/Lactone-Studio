import { applicationVersion } from '../../application-version';
import { flushSync } from 'react-dom';
import { citationExportRows, type CitationDecisions, type CitationFact, type CitationRegistry } from '../../citations';
import citationRegistry from '../../citations/data/registry.json';
import { desktopBridge } from '../../modeling/platform/desktop';
import {
  clampWorkbenchPaneSize,
  fixedWorkbenchToolLayout, WORKBENCH_PANE_LIMITS, type WorkbenchLayout, type WorkbenchPaneSizes,
} from '../../modeling/workbench-layout';
import { collectWorkspaceExportCitations, serializeWorkspaceCitations, type WorkspaceCitationFormat } from '../citations/workspace-export';
import type { FontSize } from '../FontSizeControl';
import { readInterfaceFontSize, setInterfaceFontSize } from '../interface-font-preferences';
import { DEFAULT_INTERFACE_THEME, INTERFACE_THEMES, readInterfaceTheme, setInterfaceTheme, type InterfaceTheme } from '../interface-theme-preferences';
import { validateHoldKeys } from '../modeling/use-model-shortcuts';
import type { WorkbenchLayoutState } from '../modeling/WorkbenchLayout';
import { mcpBridge } from './bridge';
import { objectSchema, toolError, type McCall, type McTool } from './types';

export interface WorkspaceCitationCapture {
  facts: CitationFact[];
  warnings: string[];
  retainedDocumentIds: string[];
  decisions: CitationDecisions;
  documentId?: string;
  assertCurrent?: () => void;
}

interface AuxiliaryToolContext {
  workbench: WorkbenchLayoutState;
  layout?: WorkspaceLayoutPort;
  showSettings?(target: WorkspaceSettingsTarget, call?: McCall): unknown | Promise<unknown>;
  captureCitations(documentId?: string): Promise<WorkspaceCitationCapture>;
}

export interface WorkspaceLayoutPatch {
  paneSizes:Partial<WorkbenchPaneSizes>;
  folds:Record<string,boolean>;
}
export interface WorkspaceLayoutSnapshot {
  owner:string;
  id?:string;
  paneSizes:Partial<WorkbenchPaneSizes>;
  folds:Record<string,boolean>;
  visiblePaneSizes:(keyof WorkbenchPaneSizes)[];
  visibleFolds:string[];
  actualPaneSizes:Partial<WorkbenchPaneSizes>;
  actualFolds:Record<string,boolean>;
  /** Native container fitting, when the current layout controller supplies it. */
  expectedPaneSizes?:Partial<WorkbenchPaneSizes>;
  containerWidth?:number;
}
/** The Shell routes writes to the same controller as its visible dividers.
 * read() observes committed state and actual controls in this exact window. */
export interface WorkspaceLayoutPort {
  read():WorkspaceLayoutSnapshot;
  write(patch:WorkspaceLayoutPatch):void;
  restore():void;
}

const themes = INTERFACE_THEMES;
const fontSizes = ['standard', 'large', 'larger'] as const;
const settingsPages = ['display', 'plots', 'labels', 'interface', 'resources', 'tools'] as const;
export interface WorkspaceSettingsTarget {
  page: typeof settingsPages[number];
}
const settingsAreas = ['interface', 'layout', 'shortcuts'] as const;
const settingsActions = ['read', 'write', 'restore'] as const;
const citationScopes = ['project', 'document'] as const;
const citationFormats = ['csv', 'bib', 'ris'] as const;
const dispositions = ['conflict', 'overwrite'] as const;
const foldNames = ['input.coordinates', 'input.preview'] as const;
const paneNames = Object.keys(WORKBENCH_PANE_LIMITS) as (keyof WorkbenchPaneSizes)[];
const enumSchema = (values: readonly string[]) => ({ type: 'string', enum: values });
const stringSchema = { type: 'string' };

function selected<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw toolError('INVALID_ARGUMENT', `无效的 ${field}。`);
  return value as T;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw toolError('INVALID_ARGUMENT', `需要有效的 ${field}。`);
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw toolError('INVALID_ARGUMENT', `需要有效的 ${field}。`);
  return value as Record<string, unknown>;
}

function layoutPatch(args: Record<string, unknown>):WorkspaceLayoutPatch {
  const paneSizes: Partial<WorkbenchPaneSizes> = {};
  const folds: WorkbenchLayout['folds'] = {};
  if (args.paneSizes !== undefined) for (const [key, value] of Object.entries(record(args.paneSizes, 'paneSizes'))) {
    const pane = selected(key, paneNames, 'paneSizes');
    if (typeof value !== 'number' || !Number.isFinite(value)) throw toolError('INVALID_ARGUMENT', `需要有效的 ${pane} 尺寸。`);
    paneSizes[pane] = clampWorkbenchPaneSize(pane, value);
  }
  if (args.folds !== undefined) for (const [key, value] of Object.entries(record(args.folds, 'folds'))) {
    const fold = selected(key, foldNames, 'folds');
    if (typeof value !== 'boolean') throw toolError('INVALID_ARGUMENT', `${fold} 需要布尔值。`);
    folds[fold] = value;
  }
  return {paneSizes,folds};
}

function layoutReceipt(snapshot:WorkspaceLayoutSnapshot,requested?:WorkspaceLayoutPatch,raw?:Record<string,unknown>) {
  const fields:Array<{field:string;requested?:number|boolean;accepted?:number|boolean;stored?:number|boolean;actual?:number|boolean;status:'applied'|'fitted'|'stored'|'pending'}>=[];
  for(const [key,value]of Object.entries(requested?.paneSizes??snapshot.paneSizes)){
    const name=key as keyof WorkbenchPaneSizes,stored=snapshot.paneSizes[name],actual=snapshot.actualPaneSizes[name],visible=snapshot.visiblePaneSizes.includes(name);
    const original=requested?(raw?.paneSizes as Record<string,number>|undefined)?.[key]??value:value;
    const width=snapshot.containerWidth;
    const tolerance=name==='leftWidth'?(typeof width==='number'&&Number.isFinite(width)&&width>0?100/width:0):1;
    const equal=(a:unknown,b:unknown)=>typeof a==='number'&&typeof b==='number'&&Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=tolerance;
    const fitted=equal(actual,snapshot.expectedPaneSizes?.[name])||(equal(actual,value)&&original!==value);
    const status=requested&&!equal(stored,value)?'pending':!visible?'stored':!Number.isFinite(actual)?'pending':equal(actual,original)?'applied':fitted?'fitted':'pending';
    fields.push({field:`paneSizes.${key}`,...(requested?{requested:original,accepted:value}:{}),stored,actual,status});
  }
  for(const [key,value]of Object.entries(requested?.folds??snapshot.folds)){
    const stored=snapshot.folds[key],actual=snapshot.actualFolds[key],visible=snapshot.visibleFolds.includes(key);
    const status=requested&&stored!==value?'pending':!visible?'stored':actual===undefined?'pending':actual===value?'applied':'pending';
    fields.push({field:`folds.${key}`,...(requested?{requested:value}:{}),stored,actual,status});
  }
  const statuses=new Set(fields.map(field=>field.status));
  const status=!fields.length?'unavailable':statuses.has('pending')?'pending':statuses.has('fitted')?'fitted':statuses.has('stored')?(statuses.has('applied')?'partial':'stored'):'applied';
  return {scope:'workspace',owner:snapshot.owner,id:snapshot.id,paneSizes:snapshot.paneSizes,folds:snapshot.folds,
    actual:{paneSizes:snapshot.actualPaneSizes,folds:snapshot.actualFolds},visible:{paneSizes:snapshot.visiblePaneSizes,folds:snapshot.visibleFolds},fields,status};
}

function interfaceSettings(action: typeof settingsActions[number], args: Record<string, unknown>) {
  if (action === 'restore') {
    setInterfaceTheme(DEFAULT_INTERFACE_THEME);
    setInterfaceFontSize('standard');
  } else if (action === 'write') {
    const theme: InterfaceTheme | undefined = args.theme === undefined ? undefined : selected(args.theme, themes, 'theme');
    const fontSize: FontSize | undefined = args.fontSize === undefined ? undefined : selected(args.fontSize, fontSizes, 'fontSize');
    if (theme !== undefined) setInterfaceTheme(theme);
    if (fontSize !== undefined) setInterfaceFontSize(fontSize);
  }
  return { theme: readInterfaceTheme(), fontSize: readInterfaceFontSize(), scope: 'interface-preferences' };
}

function layoutSettings(context:AuxiliaryToolContext,action:typeof settingsActions[number],args:Record<string,unknown>) {
  const live=context.layout;
  const fallback=():WorkspaceLayoutSnapshot=>({owner:'workbench',...context.workbench.layout,visiblePaneSizes:[],visibleFolds:[],actualPaneSizes:{},actualFolds:{}});
  const before=live?.read()??fallback();
  if(action==='read')return layoutReceipt(before);
  const patch=action==='write'?layoutPatch(args):undefined;
  if(patch&&!Object.keys(patch.paneSizes).length&&!Object.keys(patch.folds).length)return layoutReceipt(before);
  const requestedOwner=before.owner;
  flushSync(()=>{
    if(live){if(patch)live.write(patch);else live.restore();return;}
    if(!patch){context.workbench.restoreBuiltin();return;}
    context.workbench.updateLayout(current=>fixedWorkbenchToolLayout({...current,paneSizes:{...current.paneSizes,...patch.paneSizes},folds:{...current.folds,...patch.folds}}));
  });
  const after=context.layout?.read()??fallback();
  if(after.owner!==requestedOwner)return {...layoutReceipt(after),status:'superseded',requestedOwner};
  return layoutReceipt(after,patch,args);
}

async function shortcutSettings(action: typeof settingsActions[number], args: Record<string, unknown>, signal?: AbortSignal) {
  const bridge = desktopBridge();
  if (!bridge?.readModelHoldKeyPreferences) throw toolError('CAPABILITY_UNAVAILABLE', '当前宿主无法读取模型快捷键。');
  const current = await bridge.readModelHoldKeyPreferences();
  if (action === 'read') return current;
  signal?.throwIfAborted();
  const version = optionalText(args.baseVersion, 'baseVersion');
  if (version !== undefined && version !== current.version) {
    throw toolError('SETTINGS_CHANGED', '快捷键已变化，请读取当前设置后重试。', { current });
  }
  if (action === 'restore') {
    if (!bridge.restoreModelHoldKeyPreferences) throw toolError('CAPABILITY_UNAVAILABLE', '当前宿主无法恢复模型快捷键。');
    const restored = await bridge.restoreModelHoldKeyPreferences(current.version);
    window.dispatchEvent(new CustomEvent('sciyue-model-hold-keys-changed', { detail: restored }));
    return restored;
  }
  if (!bridge.writeModelHoldKeyPreferences) throw toolError('CAPABILITY_UNAVAILABLE', '当前宿主无法保存模型快捷键。');
  const supplied = record(args.bindings, 'bindings');
  if (Object.keys(supplied).some(key => key !== 'select' && key !== 'freeze')) throw toolError('INVALID_ARGUMENT', '当前可设置选择与冻结快捷键。');
  const bindings = validateHoldKeys({
    select: optionalText(supplied.select, 'select') ?? current.bindings.select,
    freeze: optionalText(supplied.freeze, 'freeze') ?? current.bindings.freeze,
  });
  const saved = await bridge.writeModelHoldKeyPreferences({ baseVersion: current.version, bindings });
  window.dispatchEvent(new CustomEvent('sciyue-model-hold-keys-changed', { detail: saved }));
  return saved;
}

export function createAuxiliaryTools(context: AuxiliaryToolContext): McTool[] {
  return [
    {
      name: 'settings_access',
      description: 'Read, adjust or restore interface preferences, current workspace layout, or model hold keys. Layout writes use the active native divider owner. Inspect fields/status: applied is measured in the visible UI, fitted reports container-limited size, stored is a setting for a currently hidden control, and pending is not yet confirmed. paneSizes.leftWidth is percent; other pane sizes are CSS px. Hidden input previews are never reported as already displayed.',
      inputSchema: objectSchema({
        area: enumSchema(settingsAreas), action: enumSchema(settingsActions), theme: enumSchema(themes), fontSize: enumSchema(fontSizes),
        paneSizes: objectSchema(Object.fromEntries(paneNames.map(name => [name, { type: 'number' }]))),
        folds: objectSchema(Object.fromEntries(foldNames.map(name => [name, { type: 'boolean' }]))),
        bindings: objectSchema({ select: stringSchema, freeze: stringSchema }), baseVersion: stringSchema,
      }, ['area']),
      call(args, call) {
        const area = selected(args.area, settingsAreas, 'area');
        const action = selected(args.action ?? 'read', settingsActions, 'action');
        call?.signal.throwIfAborted();
        if (area === 'interface') return interfaceSettings(action, args);
        if (area === 'layout') return layoutSettings(context, action, args);
        return shortcutSettings(action, args, call?.signal);
      },
    },
    {
      name: 'settings_show',
      description: 'Open a native global settings page in the attached ES window, preserving the current workspace tab. This only opens the settings UI.',
      inputSchema: objectSchema({ page: enumSchema(settingsPages) }, ['page']),
      call(args, call) {
        const page = selected(args.page, settingsPages, 'page');
        if (Object.keys(args).some(key => key !== 'page'))
          throw toolError('INVALID_ARGUMENT', '打开设置只接受 page 参数。');
        call?.signal.throwIfAborted();
        if (!context.showSettings) throw toolError('CAPABILITY_UNAVAILABLE', '当前窗口无法打开全局设置。');
        return context.showSettings({ page }, call);
      },
    },
    {
      name: 'citation_export',
      description: 'Collect manuscript citations from the current project or specified retained document using actual scientific sources and usage evidence. Return the normalized export or write it to an explicit CSV, BibTeX or RIS destination.',
      inputSchema: objectSchema({
        scope: enumSchema(citationScopes), documentId: stringSchema, format: enumSchema(citationFormats),
        destination: stringSchema, onExists: enumSchema(dispositions),
      }),
      async call(args, call) {
        const documentId = optionalText(args.documentId, 'documentId');
        const scope = selected(args.scope ?? (documentId ? 'document' : 'project'), citationScopes, 'scope');
        if (documentId && scope === 'project') throw toolError('INVALID_ARGUMENT', '指定文档时请选择文档范围。');
        const format: WorkspaceCitationFormat = selected(args.format ?? 'csv', citationFormats, 'format');
        const destination = optionalText(args.destination, 'destination');
        if (destination !== undefined && !destination.toLowerCase().endsWith(`.${format}`)) {
          throw toolError('INVALID_ARGUMENT', `保存文件须使用 .${format} 扩展名。`);
        }
        if (args.onExists !== undefined) selected(args.onExists, dispositions, 'onExists');
        call?.signal.throwIfAborted();
        const snapshot = await context.captureCitations(documentId);
        const scopedDocument = scope === 'document' ? documentId ?? snapshot.documentId : undefined;
        if (scope === 'document' && (!scopedDocument || !snapshot.retainedDocumentIds.includes(scopedDocument))) {
          throw toolError('TARGET_UNAVAILABLE', '当前没有可导出引用的文档。');
        }
        const collection = collectWorkspaceExportCitations({
          ...snapshot, registry: citationRegistry as CitationRegistry,
          version: applicationVersion.displayVersion, documentId: scopedDocument,
        });
        const text = serializeWorkspaceCitations(collection, format);
        const summary = {
          scope, ...(scopedDocument ? { documentId: scopedDocument } : {}), format,
          counts: {
            verified: collection.verified.length, candidates: collection.candidates.length,
            unknown: collection.unknown.length, excluded: collection.excluded.length, issues: collection.issues.length,
          },
          warnings: snapshot.warnings,
        };
        call?.signal.throwIfAborted();
        snapshot.assertCurrent?.();
        if (!destination) return { ...summary, text, rows: citationExportRows(collection) };
        const bridge = mcpBridge();
        if (!bridge || !call) throw toolError('CAPABILITY_UNAVAILABLE', '当前宿主无法写入指定的引用文件。');
        const receipt = await bridge.file({ requestId: call.requestId, batchIndex:call.batchIndex, action: 'write', bytes: new TextEncoder().encode(text) });
        return { ...summary, receipt };
      },
    },
  ];
}
