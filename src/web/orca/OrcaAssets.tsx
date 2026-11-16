import {DismissibleNotice} from '../DismissibleNotice';
import NumericInput from '../NumericInput';
import { useEffect, useRef, useState } from 'react';
import type { OrcaAsset, OrcaJobRequest } from '../../core/orca';
import { InputSettingsField, InputSettingsRow } from '../InputSettingsFields';
import './source-assets.css';
import { InputSettingsAction, InputSettingsCheckbox } from '../InputSettingsLayout';
import { InputSettingsCard } from '../InputSettingsFields';

export function orcaAssetUploadKind(filename: string, task: OrcaJobRequest['settings']['task']): OrcaAsset['kind'] {
  if (/\.(?:chk|fchk|fch)$/i.test(filename)) throw new Error('Gaussian CHK/FCHK 不能作为 ORCA 依赖；请提供实际 GBW 或 ORCA Hessian。');
  if (/\.xyz$/i.test(filename)) throw new Error('XYZ 是结构来源，请通过“导入结构”读取。');
  if (/\.gbw$/i.test(filename)) return 'gbw';
  if (/\.hess$/i.test(filename)) {
    if (task === 'sp') throw new Error('单点能不读取 Hessian；初猜请提供实际 GBW。已有 Hessian 保留在来源记录中。');
    return 'hessian';
  }
  if (/\.mdrestart$/i.test(filename) && task === 'md') return 'restart';
  throw new Error(task === 'md' ? '请提供实际 .gbw、.hess 或 .mdrestart 文件。' : task === 'sp' ? '单点能初猜请提供实际 .gbw 文件。' : '请提供实际 .gbw 或 .hess 文件。');
}

/** Check the complete batch before reading bytes, so a rejected drop adds no partial assets. */
export async function readOrcaUploadFiles(files: File[], task: OrcaJobRequest['settings']['task']): Promise<OrcaAsset[]> {
  const kinds = files.map(file => orcaAssetUploadKind(file.name, task));
  return Promise.all(files.map((file, i) => readOrcaAsset(file, kinds[i])));
}

export async function readOrcaAsset(file: File, kind: OrcaAsset['kind']): Promise<OrcaAsset> {
  const bytes = await file.arrayBuffer();
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  const asset: OrcaAsset = { id: crypto.randomUUID(), name: file.name, kind, sha256: hash };
  if (kind !== 'gbw') {
    asset.text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (asset.text.includes('\0')) throw new Error(`${file.name} 含 NUL，不能作为文本依赖读取。`);
    // UTF-8 BOM is part of original file identity and must not be silently lost.
    if (new Uint8Array(bytes).slice(0, 3).every((value, i) => value === [239, 187, 191][i]) && bytes.byteLength >= 3) asset.text = '\uFEFF' + asset.text;
  }
  return asset;
}
export interface OrcaAssetsProps { request: OrcaJobRequest; onChange: (request: OrcaJobRequest) => void; onBinary: (id: string, file: File) => void; onReset?:()=>void }

const referenceSetting = { gbw: 'initialOrbitalsId', hessian: 'ircHessianId' } as const;
type ReferenceKind = keyof typeof referenceSetting;

function referenceDraft(request: OrcaJobRequest, kind: ReferenceKind) {
  const id = request.settings[referenceSetting[kind]];
  return request.assets.find(asset => asset.kind === kind && asset.id === id) ?? request.assets.find(asset => asset.kind === kind);
}

export function updateOrcaFileReference(request: OrcaJobRequest, kind: ReferenceKind, enabled: boolean, name?: string): OrcaJobRequest {
  const key = referenceSetting[kind];
  if (!enabled) return request.settings[key] === undefined ? request : { ...request, settings: { ...request.settings, [key]: undefined } };
  const previous = referenceDraft(request, kind);
  // A new name gets a new reference identity. Binary files are keyed by ID,
  // and neither their bytes nor the old reference evidence follows a rename.
  const next = previous && (name === undefined || name === previous.name)
    ? previous : { id: crypto.randomUUID(), kind, name: name ?? '' };
  if (next === previous && request.settings[key] === next.id) return request;
  const assets = next === previous ? request.assets
    : previous ? request.assets.map(asset => asset === previous ? next : asset) : [...request.assets, next];
  return { ...request, assets, settings: { ...request.settings, [key]: next.id } };
}

export default function OrcaAssets({request,onChange,onReset}:OrcaAssetsProps){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const input=useRef<HTMLInputElement>(null),current=useRef(request),active=useRef(true),reading=useRef(false);
  current.current=request;
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const update=(id:string,name:string)=>onChange({...request,assets:request.assets.map(asset=>asset.id===id?{...asset,name}:asset)});
  function reference(kind:ReferenceKind,label:string){
    const id=request.settings[referenceSetting[kind]],asset=referenceDraft(request,kind);
    const supported=kind==='gbw'||['irc','ts'].includes(request.settings.task);
    const set=(enabled:boolean,name?:string)=>{
      const next=updateOrcaFileReference(request,kind,enabled,name);
      if(next!==request)onChange(next);
    };
    return <div className="checkpoint-file-row" title={!supported?'当前任务不支持读取初始Hessian':undefined}><InputSettingsCheckbox label={label} checked={!!id} disabled={!supported} onChange={checked=>set(checked)}/><input aria-label={kind+'文件名'} placeholder={kind==='gbw'?'source.gbw':'source.hess'} disabled={!id||!supported} value={asset?.name??''} onChange={event=>set(true,event.target.value)}/></div>;
  }
  async function uploadRestart(files:File[]){
    if(!files.length||reading.current)return;
    const owner=current.current;
    reading.current=true;setBusy(true);setError('');
    try{
      if(files.some(file=>orcaAssetUploadKind(file.name,'md')!=='restart'))throw new Error('MD重启请提供实际 .mdrestart 文件。');
      const assets=await readOrcaUploadFiles(files,'md');
      // A late read cannot attach a dependency to a different document/task.
      if(!active.current||current.current.structure?.id!==owner.structure?.id||current.current.settings.md.taskIdentity!==owner.settings.md.taskIdentity||current.current.settings.task!=='md')return;
      onChange({...current.current,assets:[...current.current.assets,...assets]});
    }catch(cause){if(active.current)setError(cause instanceof Error?cause.message:String(cause));}
    finally{reading.current=false;if(active.current)setBusy(false);if(input.current)input.current.value='';}
  }
  return <InputSettingsCard title="GBW/HESS文件读取" sectionKey="sources" className="orca-source-assets checkpoint-options" testId="orca-assets" actions={<InputSettingsAction reset ariaLabel="恢复GBW/HESS读取默认" onClick={()=>onReset?onReset():onChange({...request,settings:{...request.settings,initialOrbitalsId:undefined,ircHessianId:undefined}})}>恢复默认</InputSettingsAction>}>
    <div className="checkpoint-file-rows">{reference('gbw','读取初猜')}{request.settings.task!=='sp'&&reference('hessian','读取Hessian')}</div>
    {request.assets.filter(asset=>asset.kind!=='gbw'&&asset.kind!=='hessian').map(asset=><div key={asset.id}><InputSettingsRow><InputSettingsField label={asset.kind==='restart'?'MD重启文件':'参数文件'}><input aria-label={asset.kind+'文件名'} placeholder="文件名" value={asset.name} onChange={event=>update(asset.id,event.target.value)}/></InputSettingsField><button type="button" onClick={()=>onChange({...request,assets:request.assets.filter(row=>row.id!==asset.id)})}>移除</button></InputSettingsRow>
      {asset.kind==='restart'&&request.settings.task==='md'&&<><p className="orca-note">{asset.text!==undefined?`已读取实际重启文件 · ${asset.text.length} 字符`:'尚未读取实际重启文件，请重新选择实际文件。'}</p>{asset.sha256&&<p className="orca-hash">SHA256 {asset.sha256}</p>}<RestartEvidence asset={asset} request={request} onChange={restartEvidence=>onChange({...request,assets:request.assets.map(row=>row.id===asset.id?{...row,restartEvidence}:row)})}/></>}
    </div>)}
    {request.settings.task==='md'&&<InputSettingsRow><button type="button" disabled={busy} onClick={()=>input.current?.click()}>{busy?'读取重启文件…':'选择实际MD重启文件'}</button><input ref={input} hidden multiple type="file" accept=".mdrestart" aria-label="ORCA MD重启文件" onChange={event=>void uploadRestart(Array.from(event.target.files??[]))}/></InputSettingsRow>}
    {error&&<DismissibleNotice className="orca-error" role="alert">{error}</DismissibleNotice>}
  </InputSettingsCard>;
}

const number = (text: string) => text === '' ? Number.NaN : Number(text);
function Numeric({ label, value, onChange }: { label: string; value: number | undefined; onChange: (value: number) => void }) { return <InputSettingsField label={label}><NumericInput aria-label={label} stepper={false} value={Number.isFinite(value) ? value : ''} onChange={event => onChange(number(event.target.value))} /></InputSettingsField>; }
function RestartEvidence({ asset, request, onChange }: { asset: OrcaAsset; request: OrcaJobRequest; onChange: (value: NonNullable<OrcaAsset['restartEvidence']>) => void }) {
  const e = asset.restartEvidence ?? { taskIdentity: '', atomIds: [], conditionsConfirmed: false };
  return <div className="orca-evidence"><label className="orca-field">来源任务身份<input aria-label={`${asset.name}来源任务身份`} value={e.taskIdentity} onChange={event => onChange({ ...e, taskIdentity: event.target.value, conditionsConfirmed: false })} /></label><label className="orca-field">来源稳定原子 ID（文件顺序，每行一个）<textarea aria-label={`${asset.name}重启原子身份`} value={e.atomIds.join('\n')} onChange={event => onChange({ ...e, atomIds: event.target.value.split(/[\r\n]+/).filter(Boolean), conditionsConfirmed: false })} /></label><button type="button" disabled={!request.structure} onClick={() => onChange({ ...e, atomIds: request.structure!.atoms.map(atom => atom.id!), conditionsConfirmed: false })}>以当前身份填写，仍需核对原文件顺序</button><label className="orca-check"><input type="checkbox" checked={e.conditionsConfirmed} onChange={event => onChange({ ...e, conditionsConfirmed: event.target.checked })} />确认重启文件属于该任务，原子顺序与模拟条件一致</label></div>;
}
