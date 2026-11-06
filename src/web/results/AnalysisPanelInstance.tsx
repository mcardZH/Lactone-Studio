import {DismissibleNotice} from '../DismissibleNotice';
import {useEffect,useMemo,useState,type ReactNode} from 'react';
import type {OrbitalField,WavefunctionMetadata} from '../../results/orbital-contracts';
import type {PostprocessDocument} from '../../results/postprocess-document';
import {postprocessDipole,projectPostprocessFrame,postprocessWavefunctionFrame} from '../../results/postprocess-document';
import type {Structure} from '../../core/types';
import PostprocessDisplayPanel,{generatedXtbAnalysisReason,type AnalysisPage} from './PostprocessDisplayPanel';
import OrbitalControls,{type OrbitalLayerSettings} from './OrbitalControls';
import {DEFAULT_ORBITAL_LAYER} from './orbital-display';
import {analysisBondLength,type AnalysisDisplaySettings} from './analysis-viewport';
import type {ChargeAnalysis,BondAnalysis} from './AnalysisControls';
import type {PostprocessPlotSnapshot} from './PostprocessPresentation';
import type {VibrationAnalysisProjection,VibrationGifRequest} from './VibrationControls';
import {professionalSourceIdentity,type ProfessionalSourceContext,type ProfessionalChargeDisplay} from './analysis-comparison';
import {DEFAULT_RESULT_DECIMALS} from '../../results/numeric-format';
import type {AnalysisColorbarLayout} from './analysis-colorbar-layout';
import {generatedXtbMethodAllowed} from '../../results/generated-xtb-policy';
import {useAnalysisProjectSnapshot} from '../../projects/analysis-state';
export interface AnalysisProjection {
 id:string;kind:AnalysisPage;sessionId:string|null;selectedKey:string|null;field:OrbitalField|null;frameIndex:number|null;
 /** Compatibility alias for orbital-list precision only; other tables publish
  * their actual precision in their own display/highlight projection. */
 decimals:number;
 layer:OrbitalLayerSettings;dipoleVisible:boolean;
 charge:{result:ChargeAnalysis|null;display:AnalysisDisplaySettings;comparisons?:readonly ChargeAnalysis[]};bond:{result:BondAnalysis|null;display:AnalysisDisplaySettings;comparisons?:readonly BondAnalysis[]};
 highlights:{ids:string[];values?:{atomId:string;value:number;label?:string}[]};pairs:[string,string][];
 printedHighlights?:{sourceId:string;frameIndex:number;ids:string[];values?:{atomId:string;value:number;label?:string}[]};
 vibration?:VibrationAnalysisProjection|null;
 sourceChargeDisplay?:ProfessionalChargeDisplay|null;
}
export function AnalysisPanelInstance(p:{id:string;kind:AnalysisPage;document:PostprocessDocument;structure:Structure;currentIndex?:number;trajectoryControls?:ReactNode;surfaceControls?:ReactNode;interactionControls?:ReactNode;excitationControls?:(decimals:number,onDecimalsChange:(value:number)=>void)=>ReactNode;reactivityControls?:ReactNode;active:boolean;available?:boolean;onProjection(value:AnalysisProjection):void;onDispose(id:string):void;onError(message:string):void;onOpenPlot(value:PostprocessPlotSnapshot):void;onExport():void;onExtractStructure?(structure:Structure):void;onExportGif?(request:VibrationGifRequest):void|Promise<void>;onColorbarLayoutReady?(setter:((layout:AnalysisColorbarLayout)=>void)|null):void}){
 const metadata=p.document.wavefunction?.source.metadata??null,parent=p.document.wavefunction?.nativeSessionId;
 const generated=p.document.wavefunction?.source.generatedXtb;
 const derivedAllowed=(kind:string,method:string)=>!!metadata&&generatedXtbMethodAllowed(metadata.analysisPolicy,metadata.sourceRevision,kind,method);
 const currentIndex=p.currentIndex??0,projection=useMemo(()=>projectPostprocessFrame(p.document,currentIndex),[p.document,currentIndex]);
 const waveFrame=postprocessWavefunctionFrame(p.document);
 const [session,setSession]=useState<{id:string;metadata:WavefunctionMetadata}|null>(null),[error,setError]=useState('');
 const [selectedKey,setSelectedKey]=useState<string|null>(null),[field,setField]=useState<OrbitalField|null>(null),[layer,setLayer]=useState<OrbitalLayerSettings>(()=>({...DEFAULT_ORBITAL_LAYER}));
 const [dipoleVisible,setDipoleVisible]=useState(false),[charge,setCharge]=useState<AnalysisProjection['charge']>({result:null,display:{color:false,labels:false,spin:false}}),[bond,setBond]=useState<AnalysisProjection['bond']>({result:null,display:{color:false,labels:false,spin:false}});
 const [highlights,setHighlights]=useState<AnalysisProjection['highlights']>({ids:[]}),[pairs,setPairs]=useState<[string,string][]>([]);
 const [printedHighlights,setPrintedHighlights]=useState<AnalysisProjection['printedHighlights']>();
 const [vibration,setVibration]=useState<VibrationAnalysisProjection|null>(null);
 const [sourceChargeDisplay,setSourceChargeDisplay]=useState<ProfessionalChargeDisplay|null>(null);
 const [orbitalDecimals,setOrbitalDecimals]=useState(DEFAULT_RESULT_DECIMALS);
 const [excitationDecimals,setExcitationDecimals]=useState(DEFAULT_RESULT_DECIMALS);
 useAnalysisProjectSnapshot(`analysis-panel:${JSON.stringify([p.document.id,p.id,p.kind,p.document.result.source.id,metadata?.sourceRevision])}`,
  ()=>({selectedKey,layer,dipoleVisible,charge,bond,orbitalDecimals,excitationDecimals,sourceChargeDisplay}),
  saved=>{setSelectedKey(saved.selectedKey);setLayer(saved.layer);setDipoleVisible(saved.dipoleVisible);setCharge(saved.charge);setBond(saved.bond);setOrbitalDecimals(saved.orbitalDecimals);setExcitationDecimals(saved.excitationDecimals);setSourceChargeDisplay(saved.sourceChargeDisplay);},p.onError,()=>({charge,bond}));
 const sourceContext=useMemo<ProfessionalSourceContext>(()=>({result:projection.result,structure:p.structure,frameIndex:currentIndex,wavefunctionAvailable:projection.wavefunctionAvailable&&(!generated||derivedAllowed('charges','mulliken')),generatedXtb:!!generated,nativeAtomIds:session?.metadata.structure.atoms.map(atom=>atom.id!)}),[projection,p.structure,currentIndex,session?.metadata,generated,metadata?.analysisPolicy]);
 useEffect(()=>{let alive=true,owned:string|null=null;const bridge=window.sciyueDesktop;setSession(null);setError('');
  const close=(id:string)=>{void bridge?.closeOrbitalSession?.(id).catch(()=>{});};
  // Effect replays must not share a native session that an older cleanup can close.
  if((generated?p.kind==='orbitals'&&!generatedXtbAnalysisReason(generated,p.kind)||p.kind==='charges'&&derivedAllowed('charges','mulliken')||p.kind==='bonds'&&['mayer','laplacian'].some(method=>derivedAllowed('bond-orders',method)):['charges','bonds','orbitals'].includes(p.kind))&&metadata){
   void (async()=>{
    if(parent){if(!bridge?.forkOrbitalSession)throw new Error('当前环境缺少独立分析会话接口。');const value=await bridge.forkOrbitalSession(parent,`analysis-lifetime-${crypto.randomUUID()}`);owned=value.sessionId;return value;}
    const attachment=p.document.wavefunction;
    if(!attachment?.readSourceText||!bridge?.openOrbitalSession)throw new Error('项目波函数缺少原始素材或只读解析入口。');
    const raw=await attachment.readSourceText();if(!alive)return null;
    if(raw.sourceId!==metadata.sourceId||raw.sourceRevision!==metadata.sourceRevision)throw new Error('项目波函数原始素材与分析来源身份不一致。');
    owned=`analysis-project-${crypto.randomUUID()}`;
    try{const parsed=await bridge.openOrbitalSession({sessionId:owned,sourceId:raw.sourceId,name:raw.name,text:raw.text,sourceToken:raw.sourceToken});
     if(parsed.sourceRevision!==metadata.sourceRevision||parsed.sourceId!==metadata.sourceId)throw new Error('项目波函数只读解析后的内容身份不一致。');
     return{sessionId:owned,metadata:{...parsed,structure:metadata.structure,...(metadata.analysisPolicy?{analysisPolicy:metadata.analysisPolicy}:{})}};
    }catch(reason){close(owned);owned=null;throw reason;}
   })().then(value=>{if(value){if(alive)setSession({id:value.sessionId,metadata:value.metadata});else close(value.sessionId);}}).catch(reason=>{if(alive)setError(String(reason instanceof Error?reason.message:reason));});
  }
  return()=>{alive=false;if(owned)close(owned);};
 },[p.id,p.kind,parent,metadata?.sourceRevision,metadata?.format,metadata?.analysisPolicy,generated]);
 const snapshot=useMemo<AnalysisProjection>(()=>({id:p.id,kind:p.kind,sessionId:session?.id??null,frameIndex:waveFrame,decimals:orbitalDecimals,selectedKey,field,layer,dipoleVisible,charge,bond,highlights,pairs,printedHighlights,vibration,sourceChargeDisplay:sourceChargeDisplay?.identity===professionalSourceIdentity(sourceContext)?sourceChargeDisplay:null}),[p.id,p.kind,session?.id,waveFrame,orbitalDecimals,selectedKey,field,layer,dipoleVisible,charge,bond,highlights,pairs,printedHighlights,vibration,sourceChargeDisplay,sourceContext]);
 useEffect(()=>p.onProjection(snapshot),[snapshot,p.onProjection]);
 useEffect(()=>()=>p.onDispose(p.id),[p.id,p.onDispose]);
 const analysis=useMemo(()=>session?{sessionId:session.id,sourceId:session.metadata.sourceId,sourceRevision:session.metadata.sourceRevision,sourceName:session.metadata.name,format:metadata?.format===session.metadata.format?session.metadata.format:undefined,generatedXtb:!!generated,
  analysisPolicy:generated?(metadata?.sourceRevision===session.metadata.sourceRevision&&JSON.stringify(metadata.analysisPolicy)===JSON.stringify(session.metadata.analysisPolicy)?session.metadata.analysisPolicy:undefined):session.metadata.analysisPolicy}:undefined,[session,generated,metadata?.sourceRevision,metadata?.format,metadata?.analysisPolicy]);
 return <>{p.available===false&&<p className="postprocess-note">当前结构已修改，撤销后可恢复此分析。</p>}<div className="analysis-instance-body" hidden={p.available===false}>{error&&<DismissibleNotice role="alert">{error}</DismissibleNotice>}
  <PostprocessDisplayPanel result={projection.result} structure={p.structure} currentIndex={currentIndex} analysisPage={p.kind} hideEntries active={p.active&&p.available!==false} cancelOnInactive={p.available===false} wavefunctionAvailable={projection.wavefunctionAvailable} trajectoryControls={p.trajectoryControls} surfaceControls={p.surfaceControls} interactionControls={p.interactionControls} excitationControls={p.excitationControls?.(excitationDecimals,setExcitationDecimals)} reactivityControls={p.reactivityControls} sourceContext={sourceContext} onProfessionalCharges={setSourceChargeDisplay}
   unavailableReason={page=>generatedXtbAnalysisReason(generated,page)} atomicDisplay={{property:null,color:false,labels:false}} onAtomicDisplay={()=>{}}
   vibrationControls={{onProjection:setVibration,onExtractStructure:p.onExtractStructure,onExportGif:p.onExportGif,onError:p.onError}}
   analysis={analysis} analysisOwnerId={p.id} onColorbarLayoutReady={p.onColorbarLayoutReady} onChargeAnalysis={(result,display,comparisons)=>setCharge({result,display,comparisons})} onBondAnalysis={(result,display,comparisons)=>setBond({result,display,comparisons})}
   onAtomHighlight={(ids,values)=>setHighlights({ids,values})} onBondsHighlight={setPairs}
   onPrintedAtomHighlight={(ids,values)=>setPrintedHighlights({sourceId:p.document.result.source.id,frameIndex:currentIndex,ids,values})}
   getBondLength={ids=>metadata&&projection.wavefunctionAvailable?analysisBondLength(ids,metadata,p.structure):undefined}
   dipoleAvailable={!!postprocessDipole(projection.scientific,currentIndex)} dipoleVisible={dipoleVisible} onDipoleVisible={setDipoleVisible}
   onOpenPlot={p.onOpenPlot} orbitalControls={<OrbitalControls metadata={session?.metadata??null} nativeSessionId={session?.id??null} sourceResult={projection.result} sourceFrameIndex={currentIndex} sourcePair={p.document.pair} wavefunctionAvailable={projection.wavefunctionAvailable} onDecimalsChange={setOrbitalDecimals} selectedKey={selectedKey} onSelectedKey={setSelectedKey} onField={setField} onLayerSettings={setLayer} active={p.active&&p.available!==false} cancelOnInactive={p.available===false} analysis={analysis} onAtomHighlight={(ids,values)=>setHighlights({ids,values})} onError={p.onError} onExportImage={p.active&&p.available!==false&&projection.wavefunctionAvailable?p.onExport:undefined}/>}/>
 </div></>;
}
