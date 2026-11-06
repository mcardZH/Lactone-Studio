import {DismissibleNotice} from './DismissibleNotice';
import NumericInput from './NumericInput';
import {useEffect,useState,type ReactNode} from 'react';
import type {CenterProgress} from '../results/trajectory-center';
import {InputSettingsField,InputSettingsRow} from './InputSettingsFields';
import {InputSettingsAction} from './InputSettingsLayout';

export type MultiframeDisplayMode='raw'|'proper'|'core';
export interface MultiframeDisplayRange {start:number;end:number;total:number}
export interface MultiframeDisplayControlsProps {
 enabled:boolean;busy?:boolean;disabled?:boolean;
 mode:MultiframeDisplayMode;coreAvailable?:boolean;
 onModeChange(mode:MultiframeDisplayMode):void;onToggle():void;
 range?:MultiframeDisplayRange;onRangeChange?(range:MultiframeDisplayRange):void;
 displayedFrameCount?:number;atomInstances?:number;error?:string;
 children?:ReactNode;
}
export interface PlaybackOverlayControlsProps {
 enabled:boolean;busy?:boolean;disabled?:boolean;total:number;fitAtoms:'heavy'|'all';referenceKind:string;referenceIndex:number;
 initialAvailable:boolean;centerAvailable:boolean;centerReason?:string;centerBusy?:boolean;centerProgress?:CenterProgress;centerError?:string;meanRmsd?:number;
 error?:string;onToggle():void;onFitAtoms(value:'heavy'|'all'):void;onReference(kind:string):void;onReferenceIndex(index:number):void;onCurrentReference():void;onCancelCenter():void;
}
/** The only overlay editor for discrete playback. Range/stride and table
 * selections deliberately do not enter this interface. */
export function PlaybackOverlayControls(p:PlaybackOverlayControlsProps){
 const [draft,setDraft]=useState(String(p.referenceIndex+1)),[invalid,setInvalid]=useState(false);
 useEffect(()=>{setDraft(String(p.referenceIndex+1));setInvalid(false);},[p.referenceIndex,p.referenceKind]);
 return <div className="playback-overlay-controls" data-testid="playback-overlay-controls"><label><input type="checkbox" checked={p.enabled} disabled={p.disabled||p.busy} onChange={p.onToggle}/>叠合显示</label>{p.enabled&&<><span>全部{p.total}帧</span><label>拟合原子<select aria-label="叠合拟合原子" value={p.fitAtoms} disabled={p.disabled||p.centerBusy} onChange={event=>p.onFitAtoms(event.target.value as 'heavy'|'all')}><option value="heavy">重原子</option><option value="all">全部原子</option></select></label><label>参考<select aria-label="叠合参考" value={p.referenceKind} disabled={p.disabled||p.centerBusy} onChange={event=>p.onReference(event.target.value)}><option value="first">集合首帧</option><option value="initial" disabled={!p.initialAvailable}>本次初始结构</option><option value="specified">指定帧</option><option value="center" disabled={!p.centerAvailable}>自动中心帧</option></select></label>{p.referenceKind==='specified'&&<label>参考帧<NumericInput aria-label="叠合参考帧" value={draft} aria-invalid={invalid||undefined} disabled={p.disabled} onChange={event=>setDraft(event.target.value)} onBlur={()=>{const index=Number(draft)-1;if(!Number.isSafeInteger(index)||index<0||index>=p.total){setInvalid(true);return;}setInvalid(false);p.onReferenceIndex(index);}}/><button type="button" disabled={p.disabled} onClick={p.onCurrentReference}>取当前帧</button></label>}{invalid&&<span role="alert">请输入集合内的有效帧序号。</span>}{p.meanRmsd!==undefined&&<span>中心帧 {p.referenceIndex+1} · 平均RMSD {p.meanRmsd} Å</span>}{!p.centerAvailable&&p.centerReason&&<small>{p.centerReason}</small>}</>}{p.busy&&<span role="status">正在准备全部叠合帧…</span>}{p.centerBusy&&<div role="status">正在寻找参考{p.centerProgress&&<><progress max={p.centerProgress.totalPairs} value={p.centerProgress.completedPairs}/><span>{p.centerProgress.completedPairs} / {p.centerProgress.totalPairs} 对</span></>}<button type="button" onClick={p.onCancelCenter}>取消</button></div>}{(p.error||p.centerError)&&<DismissibleNotice role="alert">{p.error??p.centerError}</DismissibleNotice>}</div>;
}
/** Shared presentation only: consumers own scientific collections, pin leases,
 * immutable reference snapshots, limits and explicit activation. */
export default function MultiframeDisplayControls(p:MultiframeDisplayControlsProps){
 return <div data-testid="multiframe-display-controls"><InputSettingsRow className="shared-input-row-compact"><InputSettingsField label="叠合方式"><select aria-label="多帧叠合方式" value={p.mode} disabled={p.enabled||p.busy||p.disabled} onChange={event=>p.onModeChange(event.target.value as MultiframeDisplayMode)}><option value="raw">原始坐标</option><option value="proper">固定参考帧拟合</option><option value="core" disabled={!p.coreAvailable}>启动核心快照拟合</option></select></InputSettingsField>{p.range&&(['start','end'] as const).map(key=><InputSettingsField key={key} label={key==='start'?'起始帧':'结束帧'}><NumericInput aria-label={`多帧叠合${key==='start'?'起始帧':'结束帧'}`} stepper min="1" max={p.range!.total} value={p.range![key]+1} disabled={p.enabled||p.busy||p.disabled||!p.onRangeChange} onChange={event=>p.onRangeChange?.({...p.range!,[key]:Number(event.target.value)-1})}/></InputSettingsField>)}</InputSettingsRow>{p.children}<InputSettingsAction variant="surface" disabled={!p.enabled&&(p.busy||p.disabled)} onClick={p.onToggle}>{p.enabled?'关闭叠合':p.busy?'读取完整帧…':'叠合所选帧'}</InputSettingsAction>{p.enabled&&<p role="status" className="muted-note">显示 {p.displayedFrameCount??0} 帧 · {p.atomInstances??0} 原子实例</p>}{p.error&&<DismissibleNotice role="alert">{p.error}</DismissibleNotice>}</div>;
}
