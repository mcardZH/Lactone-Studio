import NumericInput from './NumericInput';
import { defaultAdvanced, SCF_OPTIONS } from '../core/advanced';
import { effectiveGaussianIntegral, isSemiempirical } from '../core/gaussian';
import { isEnergyTask,isZindo } from '../core/tasks';
import { isXtb } from '../core/xtb';
import type { AdvancedSettings, FileSettings, GaussianSettings } from '../core/types';
import type { DefaultSection } from '../core/section-defaults';
import { excitedOptimizationFrequency } from '../core/excited-state';
import { InputSettingsRow } from './InputSettingsFields';
import { InputSettingsAction, InputSettingsCheckbox, InputSettingsEnableCard } from './InputSettingsLayout';
import './iteration-seven.css';
import './iteration-eight.css';
import './task-core-controls.css';
type UpdateSettings=<K extends keyof GaussianSettings>(key:K,value:GaussianSettings[K])=>void;
type UpdateFiles=<K extends keyof FileSettings>(key:K,value:FileSettings[K])=>void;
export function scfConver6Disabled(settings:GaussianSettings,files:FileSettings):boolean {
  return settings.task==='freq'&&files.hessian==='readfc'||!isEnergyTask(settings.task)&&settings.scf!=='conver6';
}
export default function AdvancedOptions({settings,files,update,onResetSection}:{settings:GaussianSettings;files:FileSettings;update:UpdateSettings;updateFile:UpdateFiles;onResetSection?:(section:DefaultSection)=>void}){
  const advanced=settings.advanced??defaultAdvanced(settings.task,excitedOptimizationFrequency(settings));
  const reuse=settings.task==='freq'&&files.hessian==='readfc',external=isXtb(settings.method),zindo=isZindo(settings);
  const memory=settings.parameterDrafts??{},integral=effectiveGaussianIntegral(settings);
  const gridSupported=!external&&!zindo&&!isSemiempirical(settings.method);
  const scfEnabled=memory.scf?.enabled===true||settings.scf!=='default'||advanced.scfAlgorithm!=='default'||SCF_OPTIONS.some(item=>advanced[item.key])||advanced.vshift!==null||advanced.scfMaxCycle!==null||advanced.maxConventional!==null;
  const integrationEnabled=memory.integration?.enabled===true||integral.grid!==undefined||integral.acc2e!==undefined||settings.nosymm;
  function toggleScf(enabled:boolean){
    const retained=memory.scf;
    update('parameterDrafts',{...memory,scf:enabled?{enabled:true,advanced:retained?.advanced??advanced,scf:retained?.scf??settings.scf}:{enabled:false,advanced:{...advanced},scf:settings.scf}});
    if(enabled){if(retained){update('advanced',{...advanced,...Object.fromEntries(['scfAlgorithm','noVarAcc','noIncFock','fermi','noDIIS','vshift','scfMaxCycle','maxConventional'].map(key=>[key,retained.advanced[key as keyof AdvancedSettings]]))});update('scf',retained.scf);}}
    else{update('advanced',{...advanced,scfAlgorithm:'default',noVarAcc:false,noIncFock:false,fermi:false,noDIIS:false,vshift:null,scfMaxCycle:null,maxConventional:null});update('scf','default');}
  }
  function toggleIntegration(enabled:boolean){
    const retained=memory.integration;
    update('parameterDrafts',{...memory,integration:{...retained,enabled,grid:settings.grid,nosymm:enabled?retained?.nosymm??settings.nosymm:settings.nosymm,integral:enabled?retained?.integral??integral:integral}});
    update('integral',enabled?retained?.integral??integral:{});update('nosymm',enabled?retained?.nosymm??settings.nosymm:false);
  }
  function changeIntegral(key:'grid'|'acc2e',value:NonNullable<GaussianSettings['integral']>[typeof key]){
    const retained=memory.integration;
    update('parameterDrafts',{...memory,integration:{...retained,enabled:true,grid:settings.grid,nosymm:settings.nosymm,gridDraft:integral.grid??retained?.gridDraft??'fine',acc2eDraft:integral.acc2e??retained?.acc2eDraft??10}});
    update('integral',{...integral,[key]:value});
  }
  function change<K extends keyof AdvancedSettings>(key:K,value:AdvancedSettings[K]){update('advanced',{...advanced,[key]:value});}
  function optionalNumber(key:'vshift'|'scfMaxCycle',label:string){
    const checked=advanced[key]!==null,value=advanced[key]??memory[key]??(key==='vshift'?400:256);
    return <div className="input-option-group"><InputSettingsCheckbox label={label} checked={checked} disabled={reuse} onChange={enabled=>{update('parameterDrafts',{...memory,[key]:advanced[key]??memory[key]??value,[key+'Enabled']:enabled});change(key,enabled?value:null);}}/><NumericInput aria-label={key==='vshift'?'VShift':'MaxCycle'} stepper={false} min="1" step="1" required disabled={reuse||!checked} value={value} onChange={event=>change(key,event.target.value===''?Number.NaN:Number(event.target.value))}/></div>;
  }
  return <div className="advanced-options-stack">
    {!external&&!zindo&&<InputSettingsEnableCard enabled={scfEnabled} onEnabledChange={toggleScf} disabled={reuse} switchLabel="启用SCF收敛帮助" title="SCF 收敛帮助" sectionKey="scf" testId="scf-help" actions={onResetSection&&<InputSettingsAction reset ariaLabel="恢复SCF默认" onClick={()=>onResetSection('scf')}>恢复默认</InputSettingsAction>}>
      <InputSettingsRow className="input-control-flow">
        {optionalNumber('vshift','VShift / mHartree')}{optionalNumber('scfMaxCycle','MaxCycle')}
        <InputSettingsCheckbox label="Conver=6" ariaLabel="SCF收敛设置" disabled={scfConver6Disabled(settings,files)} checked={settings.scf==='conver6'} onChange={checked=>update('scf',checked?'conver6':'default')}/>
        {SCF_OPTIONS.map(item=><span key={item.key} title={item.description}><InputSettingsCheckbox label={item.name} checked={advanced[item.key]} disabled={reuse} onChange={checked=>change(item.key,checked)}/></span>)}
        <InputSettingsCheckbox label="XQC" checked={advanced.scfAlgorithm!=='default'} disabled={reuse} onChange={checked=>change('scfAlgorithm',checked?'xqc':'default')}/>
        {advanced.scfAlgorithm!=='default'&&<label className="input-option-group">常规轮数<NumericInput aria-label="MaxConventionalCycles" stepper={false} min="1" step="1" placeholder="默认" disabled={reuse} value={advanced.maxConventional??''} onChange={event=>change('maxConventional',event.target.value===''?null:Number(event.target.value))}/></label>}
      </InputSettingsRow>
    </InputSettingsEnableCard>}
    <InputSettingsEnableCard enabled={integrationEnabled} onEnabledChange={toggleIntegration} switchLabel="启用积分与对称性设置" title={external||zindo?'对称性设置':'积分与对称性'} sectionKey="integration" testId="integration-help" actions={onResetSection&&<InputSettingsAction reset ariaLabel="恢复积分/对称性默认" onClick={()=>onResetSection('integration')}>恢复默认</InputSettingsAction>}>
      <InputSettingsRow className="input-control-flow">{!external&&!zindo&&<>
        <div className="input-option-group"><InputSettingsCheckbox label="网格" checked={integral.grid!==undefined} disabled={reuse||!gridSupported} onChange={enabled=>changeIntegral('grid',enabled?memory.integration?.gridDraft??'fine':undefined)}/><select aria-label="Gaussian积分网格" disabled={reuse||!gridSupported||integral.grid===undefined} value={integral.grid??memory.integration?.gridDraft??'fine'} onChange={event=>changeIntegral('grid',event.target.value as NonNullable<GaussianSettings['integral']>['grid'])}><option value="fine">Fine</option><option value="ultrafine">UltraFine</option><option value="superfinegrid">SuperFineGrid</option></select></div>
        <div className="input-option-group" title="Acc2E=N：双电子积分精度为10的负N次方量级"><InputSettingsCheckbox label="积分屏蔽阈值" checked={integral.acc2e!==undefined} disabled={reuse||!gridSupported} onChange={enabled=>changeIntegral('acc2e',enabled?memory.integration?.acc2eDraft??10:undefined)}/><NumericInput aria-label="Acc2E" stepper={false} min="1" step="1" disabled={reuse||!gridSupported||integral.acc2e===undefined} value={integral.acc2e??memory.integration?.acc2eDraft??10} onChange={event=>changeIntegral('acc2e',event.target.value===''?Number.NaN:Number(event.target.value))}/></div>
      </>}<InputSettingsCheckbox label="NoSymm" checked={settings.nosymm} onChange={checked=>update('nosymm',checked)}/></InputSettingsRow>
    </InputSettingsEnableCard>
  </div>;
}