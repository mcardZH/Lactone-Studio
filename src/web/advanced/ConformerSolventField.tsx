import CardDropdown,{type CardOption} from '../CardDropdown';
import {DismissibleNotice} from '../DismissibleNotice';
import {CONFORMER_ALPB_PRESETS,conformerAlpbPresets} from '../../modeling/advanced/conformer-solvation';
import {conformerSolvationDraftIssue,type ConformerSolvationDraft} from './conformer-solvation-draft';

export default function ConformerSolventField(p:{method:string;value:ConformerSolvationDraft;onChange(value:ConformerSolvationDraft):void;ariaLabel:string;disabled?:boolean}){
  const current=p.value.solvationModel==='none'?'none':`${p.value.solvationModel}:${p.value.solvent}`;
  const options:CardOption[]=[{value:'none',label:'气相',body:null},...conformerAlpbPresets(p.method).map(row=>({value:`alpb:${row.id}`,label:`${row.label}(ALPB) ε=${row.dielectric}`,body:null}))];
  const retained=CONFORMER_ALPB_PRESETS.find(row=>row.id===p.value.solvent),issue=conformerSolvationDraftIssue(p.method,p.value);
  if(!options.some(row=>row.value===current))options.push({value:current,label:`${retained?.label??p.value.solvent}(${p.value.solvationModel.toUpperCase()}) · ${p.value.solvationModel==='gbsa'?'历史设置':'当前方法不支持'}`,body:null,disabled:true});
  return <div className="conformer-solvent-field" data-invalid={!!issue||undefined}>
    <CardDropdown label={p.ariaLabel} displayLabel="溶剂" value={current} options={options} disabled={p.disabled}
      onChange={value=>p.onChange(value==='none'?{...p.value,solvationModel:'none'}:{solvationModel:'alpb',solvent:value.slice(5)})}
      footer={<span>ε 为 298 K 溶剂物性参考；计算采用 xTB 内置 ALPB 参数。</span>}/>
    {issue&&<DismissibleNotice identity={`${p.method}:${current}`}>{issue}</DismissibleNotice>}
  </div>;
}
