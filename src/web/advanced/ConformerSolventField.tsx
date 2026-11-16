import {DismissibleNotice} from '../DismissibleNotice';
import {InputSettingsField} from '../InputSettingsFields';
import {CONFORMER_ALPB_PRESETS,conformerAlpbPresets} from '../../modeling/advanced/conformer-solvation';
import {conformerSolvationDraftIssue,type ConformerSolvationDraft} from './conformer-solvation-draft';
import {xtbSolventLabel} from '../solvent-presentation';
import './conformer-solvent-field.css';

export default function ConformerSolventField(p:{method:string;value:ConformerSolvationDraft;onChange(value:ConformerSolvationDraft):void;ariaLabel:string;disabled?:boolean;validationIssue?:string}){
  const current=p.value.solvationModel==='none'?'none':`${p.value.solvationModel}:${p.value.solvent}`;
  const options:{value:string;label:string;disabled?:boolean}[]=[{value:'none',label:'气相'},...conformerAlpbPresets(p.method).map(row=>({value:`alpb:${row.id}`,label:xtbSolventLabel(row,'ALPB')}))];
  const retained=CONFORMER_ALPB_PRESETS.find(row=>row.id===p.value.solvent),draftIssue=conformerSolvationDraftIssue(p.method,p.value);
  const issue=p.validationIssue??draftIssue;
  if(!options.some(row=>row.value===current))options.push({value:current,label:`${xtbSolventLabel(retained??{label:p.value.solvent},p.value.solvationModel)} · ${p.value.solvationModel==='gbsa'?'历史设置':'当前方法不支持'}`,disabled:true});
  return <div className="conformer-solvent-field" data-invalid={!!issue||undefined}>
    <InputSettingsField label="溶剂" controlWidth="select">
      <span className="conformer-solvent-select">
      <select aria-label={p.ariaLabel} aria-invalid={!!issue||undefined} title={options.find(row=>row.value===current)?.label}
        value={current} disabled={p.disabled} onChange={event=>{
          const value=event.currentTarget.value;
          if(p.disabled||!options.some(row=>row.value===value&&!row.disabled))return;
          p.onChange(value==='none'?{...p.value,solvationModel:'none'}:{solvationModel:'alpb',solvent:value.slice(5)});
        }}>
        {options.map(row=><option key={row.value} value={row.value} disabled={row.disabled}>{row.label}</option>)}
      </select>
      <span className="conformer-solvent-selected-label" aria-hidden="true">{options.find(row=>row.value===current)?.label}</span>
      </span>
    </InputSettingsField>
    {issue&&<DismissibleNotice identity={`${p.method}:${current}`}>{issue}</DismissibleNotice>}
  </div>;
}
