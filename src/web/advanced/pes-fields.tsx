import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Structure,Vector3 } from '../../core/types';
import { XTB_METHOD_LABELS } from '../../core/xtb-capabilities';
import { confirmCoordinateSelection } from '../../modeling/application/coordinate-selection';
import type { PesExpressionDraft, PesMethod, PesMethodDraft, PesParameters, PesRun } from '../../modeling/pes/contracts';
import {isPesNetMethod as isNetMethod} from '../../modeling/pes/contracts';
import {periodicPesMethods} from '../../modeling/pes/periodic-capabilities';
import { parameterVisible, pesId, type PesParameterSection } from '../../modeling/pes/defaults';
import { compilePesExpression, nextCoordinateName, renameCoordinate } from '../../modeling/pes/expressions';
import { parameterValue } from '../../modeling/pes/request';
import { DismissibleNotice } from '../DismissibleNotice';
import { InputSettingsField, InputSettingsRow, InputSettingsStack } from '../InputSettingsFields';
import { InputSettingsCheckbox, InputSettingsSection } from '../InputSettingsLayout';
import ConformerSolventField from './ConformerSolventField';
import { samplingRemainingLabel } from './sampling-time-estimate';
import InteractiveSelectionField,{SelectionAddButton,SelectionGroupHeader,SelectionRemoveButton} from '../InteractiveSelectionField';
import type {AnalysisSelectionHandle,AnalysisSelectionIntent,AnalysisSelectionOwner} from '../analysis-selection-intent';
import type {AnalysisCaptureTarget} from '../results/useAnalysisAtomCapture';
import {isNetGpuFailure} from '../modeling/tool-session';

export interface PesSelectionScope {
  target:AnalysisCaptureTarget;
  owner:AnalysisSelectionOwner;
  request(intent:AnalysisSelectionIntent,target:AnalysisCaptureTarget):AnalysisSelectionHandle;
  highlight?(target:AnalysisCaptureTarget,ids:readonly string[]):void;
}
export const pesMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
export function pesCoordinateDescription(structure:Structure,ids:readonly string[],images?:readonly Vector3[]):string{
  const row=confirmCoordinateSelection(structure,ids,images);
  const label={B:'键长',A:'键角',D:'二面角'}[row.type];
  return `${label} · ${row.value.toPrecision(6)} ${row.unit}`;
}

export function PesSelectionField({scope,rowId,label,kind='atoms',ids,images,autoPick,disabled,onClear,onConfirm,onEnd,headerVariant,numberText,onNumberTextChange,preserveNumberDraftOnCancel,renderHeader,renderContainer,renderSelectionRow,onDraftChange}:{
  scope:PesSelectionScope;rowId:string;label:string;kind?:'atoms'|'coordinate';ids:readonly string[];autoPick?:boolean;disabled?:boolean;
  images?:readonly Vector3[];onConfirm(ids:string[],images?:Vector3[]):void;onClear?():void;onEnd?(result:'confirmed'|'cancelled'):void;
  headerVariant?:'subcard';
  numberText?:string;onNumberTextChange?(text:string):void;preserveNumberDraftOnCancel?:boolean;
  onDraftChange?(ids:string[]):void;
  renderHeader?(actions:ReactNode):ReactNode;renderContainer?(field:ReactNode,clearAction:ReactNode):ReactNode;
  renderSelectionRow?(numberControl:ReactNode,actionButtons:ReactNode):ReactNode;
}){
  const {target,owner}=scope,structure=target.structure;
  const validIds=structure.atoms.flatMap(atom=>atom.id?[atom.id]:[]);
  const remaining=kind==='atoms'?validIds.filter(id=>!ids.includes(id)):undefined;
  const elements=new Map<string,string[]>();
  if(kind==='atoms')for(const atom of structure.atoms)if(atom.id){const group=elements.get(atom.element)??[];group.push(atom.id);elements.set(atom.element,group);}
  return <InteractiveSelectionField structure={structure} captureOwner={owner} contextKey={target.contextKey} analysisPurpose="advanced-region" kind={kind}
    rowId={rowId} label={label} atomIds={ids} coordinateImages={images} autoPick={autoPick} disabled={disabled} liveNumberDraft wrapActions headerVariant={headerVariant}
    numberText={numberText} onNumberTextChange={onNumberTextChange} preserveNumberDraftOnCancel={preserveNumberDraftOnCancel}
    renderHeader={renderHeader} renderContainer={renderContainer} renderSelectionRow={renderSelectionRow} onDraftChange={onDraftChange}
    remainingAtomIds={remaining} draftChoices={kind==='atoms'?[...elements].map(([label,atomIds])=>({label:`元素 ${label}`,atomIds})):undefined}
    onRequestAnalysisSelection={intent=>scope.request(intent,target)}
    onConfirm={(ids,guard,_overwrite,images)=>{guard();target.assertCurrent();onConfirm(ids,images);}} onClear={onClear} clearDisabled={!ids.length} onEnd={onEnd}
    renderDraft={kind==='coordinate'?(ids,images)=>{
      if(ids.length<2)return <output>依次选择 2、3 或 4 个原子</output>;
      try{return <output data-testid="pes-coordinate-draft-value">当前值 {pesCoordinateDescription(structure,ids,images)}</output>;}
      catch(cause){return <output>{pesMessage(cause)}</output>;}
    }:undefined}/>;
}

export function PesSelect({ label, value, options, onChange, disabledOption }: { label: string; value: string; options: Readonly<Record<string, string>>; onChange(value: string): void; disabledOption?:string }) {
  return <InputSettingsField label={label} controlWidth="select"><select aria-label={label} title={options[value]} value={value} onChange={event => onChange(event.target.value)}>
    {Object.entries(options).map(([key, name]) => <option key={key} value={key} disabled={key===disabledOption}>{name}</option>)}
  </select></InputSettingsField>;
}

export function PesText({ label, value, unit, invalid, placeholder, onChange, onBlur, long, disabled }: { label: string; value: string; unit?: string; invalid?: boolean;
  placeholder?: string; onChange(value: string): void; onBlur?():void; long?: boolean; disabled?: boolean }) {
  return <InputSettingsField label={label} controlWidth={long ? 'long-number' : 'number'}><input aria-label={label} type="text" inputMode="decimal" aria-invalid={invalid || undefined}
    value={value} placeholder={placeholder} disabled={disabled} onChange={event => onChange(event.target.value)} onBlur={onBlur} />{unit && <span>{unit}</span>}</InputSettingsField>;
}

export const isPesNetMethod = isNetMethod;
export const pesMethodHasScc = (method: string) => method === 'gfn1' || method === 'gfn2';

export function PesMethodFields({ value, onChange, periodic=false }: { value: PesMethodDraft; onChange(value: Partial<PesMethodDraft>): void; periodic?:boolean }) {
  const xtb=Object.fromEntries((['gfn0', 'gfn1', 'gfn2', 'gfnff'] as const).map(method => [method, XTB_METHOD_LABELS[method]]));
  const available=periodic?Object.fromEntries(periodicPesMethods().filter(method=>Object.hasOwn(xtb,method)).map(method=>[method,xtb[method]])):xtb;
  const method = value.method, net = isPesNetMethod(method);
  const selected=Object.hasOwn(available,method);
  const options=selected?available:{[method]:method==='gxtb'?'g-xTB · 当前入口不可用':method+' · 当前入口不可用',...available};
  const gasOnly=periodic||method==='gfn0'||method==='gxtb';
  return <InputSettingsRow>
    <PesSelect label="计算级别" value={method} options={options} disabledOption={selected?undefined:method} onChange={method => {
      if(Object.hasOwn(available,method))onChange({ method: method as PesMethod, device:undefined });
    }}/>
    {periodic&&<span className="pes-method-fact">晶胞 固定</span>}
    {selected&&(gasOnly?<span className="pes-method-fact">气相</span>:<ConformerSolventField ariaLabel="溶剂" method={method} value={value} onChange={onChange}/>)}
    {!selected&&<small className="pes-method-fact">{net?'此版本提供 xTB 计算，请选择本次计算级别。':'本工程计算级别暂不可用于当前势能面入口。'}</small>}
  </InputSettingsRow>;
}

export function PesDetails({ title, children, level = 'subcard',actions,defaultOpen,sectionKey }: { title: ReactNode; children: ReactNode; level?: 'subcard' | 'card';actions?:ReactNode;defaultOpen?:boolean;sectionKey?:string }) {
  return <InputSettingsSection title={title} actions={actions&&<span onClick={event=>{event.preventDefault();event.stopPropagation();}} onKeyDown={event=>event.stopPropagation()}>{actions}</span>}
    sectionKey={sectionKey} defaultOpen={defaultOpen} level={level} collapsible stack>{children}</InputSettingsSection>;
}

export function PesParameterSections({ sections, values, onChange, method }: { sections: readonly PesParameterSection[]; values: PesParameters; method?: PesMethodDraft['method'];
  onChange(key: string, value: string | boolean): void }) {
  return <>{sections.map(({ title, fields }, index) => {
    const visibleFields = fields.filter(field => parameterVisible(field.key, values) &&
      !['accuracy', 'electronicTemperatureK'].includes(field.key) &&
      (field.key !== 'maxSccIterations' || !method || pesMethodHasScc(method)));
    if (!visibleFields.length) return null;
    const row = <InputSettingsRow>{visibleFields.map(field => {
      const value = values[field.key] ?? field.initial;
      if (field.options) return <PesSelect key={field.key} label={field.label} value={String(value)} options={field.options} onChange={next => onChange(field.key, next)}/>;
      if (typeof field.initial === 'boolean') return <InputSettingsCheckbox key={field.key} label={field.label} checked={value === true}
        onChange={checked => onChange(field.key, checked)}/>;
      let invalid = false;
      try { parameterValue(field, value); } catch { invalid = true; }
      const control=<PesText key={field.key} label={field.label} value={String(value)} unit={field.unit} invalid={invalid}
        long={field.unit === '原生单位' || String(field.initial).length > 8} onChange={next => onChange(field.key, next)}/>;
      return field.key==='recordInterval'?<div key={field.key} className="pes-record-interval">{control}</div>:control;
    })}</InputSettingsRow>;
    return title ? <PesDetails key={title} title={title}>{row}</PesDetails> : <div key={index}>{row}</div>;
  })}</>;
}

export function pesAtomLabels(structure: Structure, ids: readonly string[]): string {
  const indices = new Map(structure.atoms.map((atom, index) => [atom.id, `${atom.element}${index + 1}`]));
  return ids.map(id => indices.get(id) ?? '缺失原子').join(' — ');
}

export function PesExpressionEditor({ label, value, scope, rowPrefix, addRequest, hideAdd, change }: { label: string; value: PesExpressionDraft; scope:PesSelectionScope;
  rowPrefix:string;addRequest?:number;hideAdd?:boolean;change(update: (current: PesExpressionDraft) => PesExpressionDraft): void }) {
  const structure=scope.target.structure;
  const expressionInput = useRef<HTMLInputElement>(null);
  const [issue, setIssue] = useState('');
  const [newRow,setNewRow]=useState<string|null>(null);
  const previousAdd=useRef(addRequest);
  useEffect(()=>{if(addRequest!==previousAdd.current){previousAdd.current=addRequest;setNewRow(pesId('q'));}},[addRequest]);
  let display = '', expressionIssue = '';
  if (value.expression.trim()) {
    try { const preview = compilePesExpression(value, structure); display = `${preview.value.toPrecision(6)} ${preview.unit}`; }
    catch (error) { expressionIssue = pesMessage(error); }
  }
  function confirmCoordinate(id:string,atomIds:string[],images?:Vector3[],isNew=false){
    const {type}=confirmCoordinateSelection(structure,atomIds,images);
    change(current=>{
      const existing=current.coordinates.find(row=>row.id===id);
      if(!isNew&&!existing)throw Error('内坐标定义已关闭，请重新选择。');
      const {images:_oldImages,...previous}=existing??{};
      const coordinate={...previous,id,name:existing?.name??nextCoordinateName(type,current.coordinates),type,atomIds,...(images?.some(image=>image.some(Boolean))?{images}:{})};
      const coordinates=isNew?[...current.coordinates,coordinate]:current.coordinates.map(row=>row.id===id?coordinate:row);
      return {...current,coordinates,expression:isNew&&!current.expression.trim()?coordinate.name:current.expression};
    });
    if(isNew)setNewRow(null);
  }
  function insert(token: string) {
    const input = expressionInput.current;
    const start = input?.selectionStart ?? value.expression.length, end = input?.selectionEnd ?? start;
    change(current => ({ ...current, expression: `${current.expression.slice(0, start)}${token}${current.expression.slice(end)}` }));
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + token.length, start + token.length); });
  }
  const typeLabel = { B: '键长', A: '键角', D: '二面角' };
  return <InputSettingsStack>
    <SelectionGroupHeader title={label} actions={!hideAdd&&<SelectionAddButton label="添加内坐标" onClick={()=>setNewRow(pesId('q'))}/>}/>
    {newRow&&<PesSelectionField key={newRow} scope={scope} rowId={`${rowPrefix}:${newRow}`} label="新内坐标" kind="coordinate" ids={[]} autoPick
      onConfirm={(ids,images)=>confirmCoordinate(newRow,ids,images,true)} onEnd={result=>{if(result==='cancelled')setNewRow(null);}}/>}
    {value.coordinates.map(row => {
      let measured = '';
      try { const data = confirmCoordinateSelection(structure, row.atomIds,row.images); measured = `${data.value.toPrecision(6)} ${data.unit}`; }
      catch (error) { measured = pesMessage(error); }
      return <div key={row.id} className="pes-definition" onMouseEnter={()=>scope.highlight?.(scope.target,row.atomIds)} onMouseLeave={()=>scope.highlight?.(scope.target,[])}
        onFocus={()=>scope.highlight?.(scope.target,row.atomIds)} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))scope.highlight?.(scope.target,[]);}}><InputSettingsStack>
        <SelectionGroupHeader title={`${row.name} · ${typeLabel[row.type]}`} actions={<SelectionRemoveButton label={`删除内坐标 ${row.name}`} onClick={()=>change(current=>({...current,coordinates:current.coordinates.filter(item=>item.id!==row.id)}))}/>}/>
        <InputSettingsField label="名称" controlWidth="text"><input aria-label="内坐标名称" value={row.nameDraft ?? row.name}
          aria-invalid={row.nameDraft !== undefined && row.nameDraft !== row.name || undefined}
          onChange={event => { const nameDraft = event.target.value; change(current => ({ ...current, coordinates: current.coordinates.map(item => item.id === row.id ? { ...item, nameDraft } : item) })); }}
          onBlur={() => {
            if (row.nameDraft === undefined) return;
            try { renameCoordinate(value, row.id, row.nameDraft); change(current => renameCoordinate(current, row.id, row.nameDraft!)); setIssue(''); }
            catch (error) { setIssue(pesMessage(error)); }
          }} /></InputSettingsField>
        <p>{typeLabel[row.type]} · {pesAtomLabels(structure, row.atomIds)} · {measured}</p>
        <PesSelectionField scope={scope} rowId={`${rowPrefix}:${row.id}`} label={row.name} kind="coordinate" ids={row.atomIds} images={row.images} onConfirm={(ids,images)=>confirmCoordinate(row.id,ids,images)}/>
      </InputSettingsStack></div>;
    })}
    <InputSettingsField label="表达式" controlWidth="full"><input ref={expressionInput} aria-label={`${label}表达式`} value={value.expression} aria-invalid={!!expressionIssue || undefined}
      onChange={event => { const expression = event.target.value; change(current => ({ ...current, expression })); }}/></InputSettingsField>
    {value.coordinates.length > 0 && <InputSettingsRow>
      {value.coordinates.map(row => <button type="button" className="button" key={row.id} onClick={() => insert(row.name)}
        onMouseEnter={()=>scope.highlight?.(scope.target,row.atomIds)} onMouseLeave={()=>scope.highlight?.(scope.target,[])}
        onFocus={()=>scope.highlight?.(scope.target,row.atomIds)} onBlur={()=>scope.highlight?.(scope.target,[])}>{row.name}</button>)}
      {['＋', '−', '×', '÷', '(', ')'].map(token => <button type="button" className="button" key={token} onClick={() => insert(token === '＋' ? '+' : token)}>{token}</button>)}
    </InputSettingsRow>}
    {display && <output>当前值 {display}</output>}
    <DismissibleNotice identity={`${issue}:${expressionIssue}`}>{issue || expressionIssue}</DismissibleNotice>
  </InputSettingsStack>;
}

const runStatus = { starting: '准备计算', running: '正在计算', stopping: '停止中', completed: '完成', stopped: '已停止', failed: '失败', interrupted: '项目保存时尚未结束' };
const scientificStatus: Record<string, string> = { partial: '部分结果', unconverged: '未收敛', 'not-converged': '未收敛', failed: '失败', stopped: '已停止', completed: '完成', converged: '收敛' };
const stageNames: Record<string, string> = { scan: '扫描点优化', 's-idpp': 'S-IDPP初始路径', ts: '过渡态优化', hessian: '数值 Hessian',
  'initial-hessian': '初始 Hessian', 'recalculate-hessian': '重新计算 Hessian', 'final-hessian': '最终频率分析', 'final-frequency': '最终频率分析',
  neb: '路径优化', 'climbing-neb': '爬坡路径优化', 'ci-neb-ordinary': 'NEB路径优化', 'ci-neb-climb': 'CI-NEB爬坡',
  'ci-fsm-initialization': 'FSM 初始路径',
  'de-gsm': '整弦优化', 'de-gsm-growth': '双端弦生长', 'de-gsm-optimization': '整弦优化', 'de-gsm-optimize': '整弦优化', 'de-gsm-climb': '双端弦攀爬',
  fsm: '冻结弦生长', 'fsm-growth': '冻结弦生长', 'fsm-growth-interrupted': '冻结弦生长中断', 'se-gsm': '单端弦生长', afir: '人工力路径' };
export const isPesRunLive = (run?: PesRun): boolean => !!run && ['starting', 'running', 'stopping'].includes(run.status);
export function PesRunControls({ run, stop }: { run: PesRun; stop(): void }) {
  const status = runStatus[run.status];
  const { stage, completed, total, elapsedSeconds } = run.progress ?? {};
  const determined = typeof total === 'number' && total > 0 && typeof completed === 'number' && completed >= 0 && completed <= total;
  const remainingMs = determined && elapsedSeconds !== undefined && elapsedSeconds >= 0 && completed! > 0
    ? elapsedSeconds / completed! * (total! - completed!) * 1000 : undefined;
  const live = isPesRunLive(run);
  const gpuFailure = isNetGpuFailure(run.request.method,run.request.parameters.device,run.error&&`${run.error.message} ${run.error.detail??''}`,run.error?.code);
  const warnings=Array.isArray(run.result?.provenance.warnings)?run.result.provenance.warnings.filter((value):value is string=>typeof value==='string'&&!!value):[];
  let stageLabel = stage ? stageNames[stage] ?? stage : '';
  if (run.request.operation === 'irc' && stage?.startsWith('irc-')) {
    stageLabel = ({ 'irc-forward': 'IRC 正向', 'irc-reverse': 'IRC 反向', 'irc-downhill': 'IRC 下坡' } as Record<string, string>)[stage] ?? stageLabel;
    if (determined) stageLabel += ` · ${completed}/${total} 步`;
  }
  if (stage === 'ts' && completed !== undefined) stageLabel += ` · 已接受 ${completed} 步`;
  if (stage === 'scan' && determined) stageLabel += ` · ${completed}/${total} 点`;
  if ((stage === 'ci-neb-ordinary' || stage === 'ci-neb-climb') && completed !== undefined) stageLabel += ` · 已完成 ${completed} 轮`;
  return <InputSettingsStack className="pes-run">
    {live && <><InputSettingsRow><span role="status">{status}{stageLabel ? ` · ${stageLabel}` : ''}</span>
      <button type="button" className="button" disabled={run.status === 'stopping'} onClick={stop}>停止</button></InputSettingsRow>
      {run.request.operation!=='opt'&&<InputSettingsRow className="pes-progress"><progress aria-label="势能面计算进度" max={determined ? total : 1} value={determined ? completed : undefined}/>
        {determined && <output>{Number((100 * completed! / total!).toFixed(1))}%</output>}<output>预计剩余 {remainingMs === undefined ? '估算中' : samplingRemainingLabel(remainingMs)}</output></InputSettingsRow>}</>}
    {!live && (run.status !== 'completed' || run.result?.status && run.result.status !== 'completed' && run.result.status !== 'converged') &&
      <p role="status">{run.result?.status === 'partial' && run.result.stationaryPoint === 'geometry-unconverged' ? '几何未收敛，已保留优化帧'
        : run.result?.status === 'partial' && run.result.stationaryPoint === 'frequency-incomplete' ? '几何已收敛，最终频率未完成'
        : scientificStatus[run.result?.status ?? ''] ?? status}</p>}
    {run.error && gpuFailure &&
      <details className="pes-local-failures"><summary aria-label="查看 GPU 失败原因" title="查看 GPU 失败原因"><span aria-hidden="true">!</span></summary>
        <div role="note"><p>{run.error.message}</p>{run.error.detail&&<pre>{run.error.detail}</pre>}</div></details>}
    {run.error && !gpuFailure && <DismissibleNotice identity={`${run.request.id}:${run.error.message}`}>
      {run.error.message}{run.error.detail && <details><summary>详情</summary><pre>{run.error.detail}</pre></details>}
    </DismissibleNotice>}
    {!live&&warnings.length>0&&<details className="pes-local-failures"><summary aria-label="查看优化提示" title="查看优化提示"><span aria-hidden="true">!</span></summary><div role="note">{warnings.map((warning,index)=><p key={index}>{warning}</p>)}</div></details>}
  </InputSettingsStack>;
}
