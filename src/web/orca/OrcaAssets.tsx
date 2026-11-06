import {DismissibleNotice} from '../DismissibleNotice';
import NumericInput from '../NumericInput';
import { useEffect, useRef, useState } from 'react';
import type { OrcaAsset, OrcaJobRequest, OrcaVersion } from '../../core/orca';
import { invalidateHessianPathEvidence } from '../../core/orca/hessian-path';
import OrcaHessianPathEvidence from './OrcaHessianPathEvidence';
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
export default function OrcaAssets({request,onChange,onReset}:OrcaAssetsProps){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const input=useRef<HTMLInputElement>(null),current=useRef(request),active=useRef(true),reading=useRef(false);
  current.current=request;
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  const update=(id:string,name:string)=>onChange({...request,assets:request.assets.map(asset=>asset.id===id?{...asset,name}:asset)});
  function add(kind:OrcaAsset['kind']){onChange({...request,assets:[...request.assets,{id:crypto.randomUUID(),kind,name:''}]});}
  function reference(kind:'gbw'|'hessian',label:string,key:'initialOrbitalsId'|'ircHessianId'){
    const id=request.settings[key],asset=request.assets.find(row=>row.id===id)??request.assets.find(row=>row.kind===kind);
    const supported=kind==='gbw'||['irc','ts'].includes(request.settings.task);
    const set=(enabled:boolean,name?:string)=>{
      const next=asset?{...asset,...(name!==undefined?{name}:{})}:{id:crypto.randomUUID(),kind,name:name??''};
      onChange({...request,assets:asset?request.assets.map(row=>row.id===next.id?next:row):[...request.assets,next],settings:{...request.settings,[key]:enabled?next.id:undefined}});
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
    <div className="checkpoint-file-rows">{reference('gbw','读取初猜','initialOrbitalsId')}{request.settings.task!=='sp'&&reference('hessian','读取Hessian','ircHessianId')}</div>
    {request.assets.filter(asset=>asset.kind!=='gbw'&&asset.kind!=='hessian').map(asset=><div key={asset.id}><InputSettingsRow><InputSettingsField label={asset.kind==='restart'?'MD重启文件':'参数文件'}><input aria-label={asset.kind+'文件名'} placeholder="文件名" value={asset.name} onChange={event=>update(asset.id,event.target.value)}/></InputSettingsField><button type="button" onClick={()=>onChange({...request,assets:request.assets.filter(row=>row.id!==asset.id)})}>移除</button></InputSettingsRow>
      {asset.kind==='restart'&&request.settings.task==='md'&&<><p className="orca-note">{asset.text!==undefined?`已读取实际重启文件 · ${asset.text.length} 字符`:'尚未读取实际重启文件，请重新选择实际文件。'}</p>{asset.sha256&&<p className="orca-hash">SHA256 {asset.sha256}</p>}<RestartEvidence asset={asset} request={request} onChange={restartEvidence=>onChange({...request,assets:request.assets.map(row=>row.id===asset.id?{...row,restartEvidence}:row)})}/></>}
    </div>)}
    {request.settings.task==='md'&&<InputSettingsRow><button type="button" disabled={busy} onClick={()=>input.current?.click()}>{busy?'读取重启文件…':'选择实际MD重启文件'}</button><input ref={input} hidden multiple type="file" accept=".mdrestart" aria-label="ORCA MD重启文件" onChange={event=>void uploadRestart(Array.from(event.target.files??[]))}/></InputSettingsRow>}
    {error&&<DismissibleNotice className="orca-error" role="alert">{error}</DismissibleNotice>}
  </InputSettingsCard>;
}

const number = (text: string) => text === '' ? Number.NaN : Number(text);
function Numeric({ label, value, onChange }: { label: string; value: number | undefined; onChange: (value: number) => void }) { return <InputSettingsField label={label}><NumericInput aria-label={label} stepper={false} value={Number.isFinite(value) ? value : ''} onChange={event => onChange(number(event.target.value))} /></InputSettingsField>; }
function HessianEvidence({ asset, request, onChange }: { asset: OrcaAsset; request: OrcaJobRequest; onChange: (value: NonNullable<OrcaAsset['hessianEvidence']>) => void }) {
  const e = asset.hessianEvidence ?? { state: '', charge: Number.NaN, multiplicity: Number.NaN, geometryUnits: 'bohr', source: '', minimumConfirmed: false, atomOrderConfirmed: false };
  const patch = (value: Partial<typeof e>) => {
    const scientific = ['version', 'state', 'charge', 'multiplicity', 'referenceMultiplicity', 'stateSource', 'source', 'method', 'basis', 'solvent'].some(key => key in value);
    onChange({ ...invalidateHessianPathEvidence(e)!, ...(scientific ? { minimumConfirmed: false, atomOrderConfirmed: false } : {}), ...value });
  };
  return <div className="orca-evidence"><div className="orca-grid"><label className="orca-field">物理态<input aria-label={`${asset.name}物理态`} placeholder="S0 / S1 / T1" value={e.state} onChange={event => patch({ state: event.target.value, minimumConfirmed: false })} /></label><Numeric label={`${asset.name}来源电荷`} value={e.charge} onChange={charge => patch({ charge, atomOrderConfirmed: false })} /><Numeric label={`${asset.name}物理态多重度`} value={e.multiplicity} onChange={multiplicity => patch({ multiplicity, minimumConfirmed: false })} /><Numeric label={`${asset.name}参考态多重度`} value={e.referenceMultiplicity} onChange={referenceMultiplicity => patch({ referenceMultiplicity })} /></div>
    <label className="orca-field">态来源<select aria-label={`${asset.name}态来源`} value={e.stateSource ?? ''} onChange={event => patch({ stateSource: event.target.value ? event.target.value as 'udft' | 'td' : undefined })}><option value="">明确选择</option><option value="udft">态特定 UDFT</option><option value="td">TD 响应态</option></select></label>
    <label className="orca-field">ORCA 来源版本（如已知）<select aria-label={`${asset.name}Hessian来源版本`} value={e.version ?? ''} onChange={event => patch({ version: event.target.value ? event.target.value as OrcaVersion : undefined })}><option value="">未声明 / 外部转换来源</option><option value="5">5.x</option><option>6.0</option><option>6.1</option></select></label>
    {(['source', 'method', 'basis', 'solvent'] as const).map(key => <label className="orca-field" key={key}>{{ source: '实际来源 / 任务记录', method: ['ts', 'irc'].includes(request.settings.task) ? '来源方法' : '来源方法 ID（可选）', basis: ['ts', 'irc'].includes(request.settings.task) ? '来源有效基组（3c/XTB留空）' : '来源基组（可选）', solvent: '来源溶剂名称（如已声明）' }[key]}<input aria-label={`${asset.name}${key}`} value={e[key] ?? ''} onChange={event => patch({ [key]: key === 'source' ? event.target.value : event.target.value || undefined })} /></label>)}
    <label className="orca-check"><input aria-label={`${asset.name}确认Hessian顺序`} type="checkbox" checked={e.geometryUnits === 'bohr' && e.atomOrderConfirmed} onChange={event => patch({ geometryUnits: 'bohr', atomOrderConfirmed: event.target.checked })} />确认 Hessian 使用 Bohr 坐标且原子顺序与该物理态对应</label>
    {['ts', 'irc'].includes(request.settings.task) ? <OrcaHessianPathEvidence asset={asset} request={request} onChange={onChange} /> :
      <label className="orca-check"><input type="checkbox" checked={e.minimumConfirmed} onChange={event => patch({ minimumConfirmed: event.target.checked })} />已检查来源优化、频率与模式，确认是真实极小点</label>}
  </div>;
}
function OrbitalEvidence({ asset, request, onChange }: { asset: OrcaAsset; request: OrcaJobRequest; onChange: (value: NonNullable<OrcaAsset['orbitalEvidence']>) => void }) {
  const e = asset.orbitalEvidence ?? { source: '', version: '6.1' as OrcaVersion, method: '', basis: '', charge: Number.NaN, multiplicity: Number.NaN, atomIds: [], compatibilityConfirmed: false };
  const patch = (value: Partial<typeof e>) => onChange({ ...e, ...value, compatibilityConfirmed: value.compatibilityConfirmed ?? false });
  return <div className="orca-evidence">{(['source', 'method', 'basis'] as const).map(key => <label className="orca-field" key={key}>{{ source: '实际轨道来源', method: '来源方法 ID', basis: '来源基组' }[key]}<input aria-label={`${asset.name}${key}`} value={e[key]} onChange={event => patch({ [key]: event.target.value })} /></label>)}<div className="orca-grid"><label className="orca-field">来源版本<select aria-label={`${asset.name}来源版本`} value={e.version} onChange={event => patch({ version: event.target.value as OrcaVersion })}><option value="5">5.x</option><option>6.0</option><option>6.1</option></select></label><Numeric label={`${asset.name}来源电荷`} value={e.charge} onChange={charge => patch({ charge })} /><Numeric label={`${asset.name}来源多重度`} value={e.multiplicity} onChange={multiplicity => patch({ multiplicity })} /></div>
    <label className="orca-field">来源稳定原子 ID（按文件顺序，每行一个）<textarea aria-label={`${asset.name}原子身份`} value={e.atomIds.join('\n')} onChange={event => patch({ atomIds: event.target.value.split(/[\r\n]+/).filter(Boolean) })} /></label><button type="button" disabled={!request.structure} onClick={() => patch({ atomIds: request.structure!.atoms.map(atom => atom.id!) })}>以当前身份填写，仍需核对 GBW 顺序</button><label className="orca-check"><input aria-label={`${asset.name}确认轨道兼容`} type="checkbox" checked={e.compatibilityConfirmed} onChange={event => patch({ compatibilityConfirmed: event.target.checked })} />确认实际 GBW 来源、版本、基组、全部原子身份和电子态与本任务相容</label>
  </div>;
}
function MmEvidence({ asset, request, onChange }: { asset: OrcaAsset; request: OrcaJobRequest; onChange: (value: NonNullable<OrcaAsset['mmEvidence']>) => void }) {
  const e = asset.mmEvidence ?? { atomIds: [], atomCount: Number.NaN, atomOrderConfirmed: false, bondedParametersConfirmed: false, source: '' };
  const patch = (value: Partial<typeof e>) => onChange({ ...e, ...value });
  return <div className="orca-evidence"><label className="orca-field">实际 ORCAFF 参数来源<input aria-label={`${asset.name}参数来源`} value={e.source} onChange={event => patch({ source: event.target.value, bondedParametersConfirmed: false })} /></label><Numeric label={`${asset.name}参数原子数`} value={e.atomCount} onChange={atomCount => patch({ atomCount, atomOrderConfirmed: false })} /><label className="orca-field">参数对应稳定原子 ID（文件顺序，每行一个）<textarea aria-label={`${asset.name}参数原子身份`} value={e.atomIds.join('\n')} onChange={event => patch({ atomIds: event.target.value.split(/[\r\n]+/).filter(Boolean), atomOrderConfirmed: false })} /></label><button type="button" disabled={!request.structure} onClick={() => patch({ atomIds: request.structure!.atoms.map(atom => atom.id!), atomCount: request.structure!.atoms.length, atomOrderConfirmed: false })}>以当前身份填写，仍需逐序核对参数文件</button><label className="orca-check"><input aria-label={`${asset.name}确认参数顺序`} type="checkbox" checked={e.atomOrderConfirmed} onChange={event => patch({ atomOrderConfirmed: event.target.checked })} />已核对参数文件的全部原子数量与顺序</label><label className="orca-check"><input aria-label={`${asset.name}确认完整成键参数`} type="checkbox" checked={e.bondedParametersConfirmed} onChange={event => patch({ bondedParametersConfirmed: event.target.checked })} />已核对实际键、角、二面角等完整参数及来源适用性</label></div>;
}
function RestartEvidence({ asset, request, onChange }: { asset: OrcaAsset; request: OrcaJobRequest; onChange: (value: NonNullable<OrcaAsset['restartEvidence']>) => void }) {
  const e = asset.restartEvidence ?? { taskIdentity: '', atomIds: [], conditionsConfirmed: false };
  return <div className="orca-evidence"><label className="orca-field">来源任务身份<input aria-label={`${asset.name}来源任务身份`} value={e.taskIdentity} onChange={event => onChange({ ...e, taskIdentity: event.target.value, conditionsConfirmed: false })} /></label><label className="orca-field">来源稳定原子 ID（文件顺序，每行一个）<textarea aria-label={`${asset.name}重启原子身份`} value={e.atomIds.join('\n')} onChange={event => onChange({ ...e, atomIds: event.target.value.split(/[\r\n]+/).filter(Boolean), conditionsConfirmed: false })} /></label><button type="button" disabled={!request.structure} onClick={() => onChange({ ...e, atomIds: request.structure!.atoms.map(atom => atom.id!), conditionsConfirmed: false })}>以当前身份填写，仍需核对原文件顺序</button><label className="orca-check"><input type="checkbox" checked={e.conditionsConfirmed} onChange={event => onChange({ ...e, conditionsConfirmed: event.target.checked })} />确认重启文件属于该任务，原子顺序与模拟条件一致</label></div>;
}
