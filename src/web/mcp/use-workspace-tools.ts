import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {atomicNumber} from '../../core/elements';
import {createAuxiliaryTools} from './auxiliary-tools';
import {useMcpBridge} from './bridge';
import {recommendCalculationMethod} from './calculation-config';
import {frameTools,type FrameAccess} from './frame-tools';
import {inputTools,type InputToolsContext} from './input-tools';
import {modelTools,type ModelToolContext} from './model-tools';
import {resultTools,type ResultToolsContext} from './result-tools';
import {scienceTools,type ScienceToolsContext} from './science-tools';
import {workspaceTools,type CoreToolContext} from './workspace-tools';
import {checkToolArguments} from './tool-arguments';
import {objectSchema,toolError,type McpPresentationOrigin,type McTool} from './types';
import {vibrationTools} from './vibration-tools';

const RECOMMEND_ENGINES = ['gaussian','orca','both'] as const;
const RECOMMEND_TASKS = ['sp','opt','freq','optfreq','scan','constrained','ts','irc','td','tdopt','t1opt','nmr','stable','bsse','neb','esd','md'] as const;

export function createRecommendMethodTool(getCore: () => Omit<CoreToolContext,'tools'>): McTool {
  return {
    name: 'ester_recommend_method',
    description:
      'Recommend verified quantum chemistry methods, dispersion corrections, basis sets, and built-in solvent entries for a molecular document based on its elemental composition, charge/multiplicity parity, periodicity, and target calculation task (Gaussian and/or ORCA). Automatically checks heavy-element ECP requirements and basis element coverage.',
    inputSchema: objectSchema({
      modelRef: { type: 'string', minLength: 1, description: 'Target model document ID or label (alias of documentId). Defaults to the active document.' },
      documentId: { type: 'string', minLength: 1, description: 'Target document ID or label. Defaults to the currently active document.' },
      engine: { type: 'string', enum: [...RECOMMEND_ENGINES], description: 'Target quantum chemistry engine ("gaussian", "orca", or "both"). Defaults to "gaussian".' },
      task: { type: 'string', enum: [...RECOMMEND_TASKS], description: 'Target calculation task (default: "optfreq").' },
      solvent: { type: 'string', description: 'Optional solvent name or alias (e.g. "water", "acetonitrile", "dmso", "thf", "dichloromethane", "水").' },
    }),
    call(args) {
      const registry = getCore().registry;
      const snapshot = registry.getSnapshot();
      const targetRaw = typeof args.modelRef === 'string' ? args.modelRef.trim()
        : typeof args.documentId === 'string' ? args.documentId.trim()
          : '';
      const activeView = snapshot.views.find(view => view.id === snapshot.activeViewId);
      let entry = targetRaw
        ? snapshot.documents.find(doc => doc.id === targetRaw)
        : snapshot.documents.find(doc => doc.id === (activeView?.documentId ?? '')) ?? snapshot.documents[0];
      if (!entry && targetRaw) {
        const byLabel = snapshot.documents.filter(doc => doc.label === targetRaw);
        if (byLabel.length > 1) {
          throw toolError('AMBIGUOUS_DOCUMENT', `多个文档使用了名称 "${targetRaw}"，请改用具体 documentId / modelRef。`);
        }
        entry = byLabel[0];
      }
      if (!entry) {
        throw toolError('MCP_DOCUMENT_NOT_FOUND', `未找到目标文档：${targetRaw || '(当前无打开文档)'}`);
      }
      const modelDoc = entry.store.getSnapshot();
      const structure = modelDoc.draft.structure.atoms.length > 0
        ? modelDoc.draft.structure
        : (entry.result?.initialStructure ?? modelDoc.draft.structure);
      if (!structure.atoms.length) {
        throw toolError('EMPTY_STRUCTURE', `目标文档 "${entry.label}" 为空结构，请先构建或导入分子结构后再推荐方法。`);
      }
      for (const atom of structure.atoms) {
        if (!atomicNumber(atom.element)) {
          throw toolError('UNSUPPORTED_ELEMENT', `目标结构包含未识别元素 "${atom.element}"。`);
        }
      }
      const engine = (args.engine ?? 'gaussian') as 'gaussian' | 'orca' | 'both';
      const task = typeof args.task === 'string' && args.task.trim() ? args.task.trim() : 'optfreq';
      const solvent = typeof args.solvent === 'string' && args.solvent.trim() ? args.solvent.trim() : undefined;
      return {
        ok: true,
        ...recommendCalculationMethod({
          documentId: entry.id,
          label: entry.label,
          structure,
          electronicStateConfirmed: Boolean(entry.electronicStateConfirmed || modelDoc.electronicStateConfirmed),
          engine,
          task,
          solvent,
        }),
      };
    },
  };
}

interface Ports {
  ready:boolean;
  presentationOrigin?:()=>McpPresentationOrigin;
  core:Omit<CoreToolContext,'tools'>;
  frames:FrameAccess;
  input:InputToolsContext;
  model:ModelToolContext;
  results:ResultToolsContext;
  science:ScienceToolsContext;
  auxiliary:Parameters<typeof createAuxiliaryTools>[0];
}

export function dispatchMcpFrontendRequest(
  request: { requestId: string; action: string; payload?: Record<string, unknown> },
  toolCount: number
) {
  if (request.action === 'frontend.ping') {
    return { requestId: request.requestId, ok: true, result: { workbenchOnline: true, toolCount } };
  }
  return {
    requestId: request.requestId,
    ok: false,
    error: { code: 'UNSUPPORTED_FRONTEND_ACTION', message: `Unsupported MCP frontend action: ${request.action}` },
  };
}

/** A plan or frame handle belongs to the window. Its callbacks use the latest committed workspace. */
export function useWorkspaceTools(ports:Ports){
  const live=useRef(ports);
  useLayoutEffect(()=>{live.current=ports;});
  const [catalog]=useState(()=>{
    function current<K extends Exclude<keyof Ports,'ready'|'presentationOrigin'>>(key:K):Ports[K]{
      return new Proxy({} as Ports[K],{get:(_,field)=>Reflect.get(live.current[key],field)});
    }
    const inputs=inputTools(current('input'));
    const list:McTool[]=[];
    const core=new Proxy({} as CoreToolContext,{get:(_,field)=>field==='tools'?()=>list:Reflect.get(live.current.core,field)});
    list.push(...workspaceTools(core),...frameTools(ports.frames),...modelTools(current('model')),
      ...inputs,...scienceTools(current('science')),...resultTools(current('results'),(ref,call)=>core.show({
        target:{kind:'collection',ref},waitFor:'selected',
      },call)),...vibrationTools(current('results')),...createAuxiliaryTools(current('auxiliary')),createRecommendMethodTool(()=>live.current.core));
    for(let i=0;i<list.length;i++){
      const tool=list[i];
      list[i]={...tool,call:(args,call)=>{checkToolArguments(tool.argumentValidationSchema??tool.inputSchema,args);return tool.call(args,call);}};
    }
    return {list,dispose:inputs.dispose};
  });
  useMcpBridge(catalog.list,ports.ready,ports.presentationOrigin);
  useEffect(()=>{
    const desktop=window.sciyueDesktop as (typeof window.sciyueDesktop&{
      onMcpFrontendRequest?(listener:(req:{requestId:string;action:string;payload?:Record<string,unknown>})=>void):()=>void;
      replyMcpFrontendRequest?(res:{requestId:string;ok:boolean;result?:unknown;error?:{code:string;message:string}}):Promise<unknown>;
    })|undefined;
    if(!ports.ready||!desktop?.onMcpFrontendRequest||!desktop.replyMcpFrontendRequest)return;
    return desktop.onMcpFrontendRequest(request=>{
      void desktop.replyMcpFrontendRequest!(dispatchMcpFrontendRequest(request,catalog.list.length)).catch(()=>{});
    });
  },[catalog.list.length,ports.ready]);
  useLayoutEffect(()=>()=>catalog.dispose(),[catalog]);
  return catalog.list;
}
