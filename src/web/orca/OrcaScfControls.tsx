import type { ReactNode } from 'react';
import type { OrcaSettings } from '../../core/orca/types';
import { orcaScfGridCapabilities } from '../../core/orca/header';
import { InputSettingsRow } from '../InputSettingsFields';
import { InputSettingsAction, InputSettingsCheckbox, InputSettingsEnableCard } from '../InputSettingsLayout';
import NumericInput from '../NumericInput';

export interface OrcaScfControlsProps { settings:OrcaSettings; onChange(patch:Partial<OrcaSettings>):void; onResetScf?:()=>void; onResetGrid?:()=>void }
export default function OrcaScfControls({settings,onChange,onResetScf,onResetGrid}:OrcaScfControlsProps){
  const scf=settings.scf??{},memory=settings.parameterDrafts??{},retained=memory.scf?.values??{};
  const capabilities=orcaScfGridCapabilities(settings);
  const active=(key:keyof typeof scf)=>key==='convergence'?!!scf.convergence&&scf.convergence!=='default':key==='strategy'?!!scf.strategy&&scf.strategy!=='default':key==='algorithm'?!!scf.algorithm&&scf.algorithm!=='auto':scf.maxIterations!==undefined;
  const enabled=memory.scf?.enabled===true||(['convergence','strategy','algorithm','maxIterations'] as const).some(active);
  const gridEnabled=memory.grid?.enabled===true||!!settings.grid&&settings.grid!=='auto';
  const save=(patch:Partial<typeof scf>)=>onChange({scf:{...scf,...patch},parameterDrafts:{...memory,scf:{enabled:true,values:{...retained,...Object.fromEntries(Object.entries(scf).filter(([name])=>active(name as keyof typeof scf))),...patch}}}});
  function toggle(key:keyof typeof scf,checked:boolean){
    const defaults={convergence:'normal',strategy:'SlowConv',algorithm:'KDIIS',maxIterations:125} as const;
    const value=checked?retained[key]??defaults[key]:key==='maxIterations'?undefined:key==='algorithm'?'auto':'default';
    const values={...retained,...Object.fromEntries(Object.entries(scf).filter(([name])=>active(name as keyof typeof scf)))};
    onChange({scf:{...scf,[key]:value},parameterDrafts:{...memory,scf:{enabled:true,values}}});
  }
  function group(key:keyof typeof scf,label:string,control:ReactNode){return <div className="input-option-group"><InputSettingsCheckbox label={label} checked={active(key)} disabled={!capabilities.scf} onChange={checked=>toggle(key,checked)}/>{control}</div>;}
  return <>
    <InputSettingsEnableCard title="SCF 收敛帮助" enabled={enabled} disabled={!capabilities.scf} switchLabel="启用ORCA SCF收敛帮助" sectionKey="scf" className={!capabilities.scf?'input-card-unavailable':''} onEnabledChange={checked=>onChange({scf:checked?retained:{},parameterDrafts:{...memory,scf:{enabled:checked,values:checked?retained:{...retained,...scf}}}})} actions={onResetScf&&<InputSettingsAction reset ariaLabel="恢复SCF默认" disabled={!capabilities.scf} onClick={onResetScf}>恢复默认</InputSettingsAction>}>
      <InputSettingsRow className="input-control-flow">
        {group('convergence','收敛标准',<select disabled={!capabilities.scf||!active('convergence')} aria-label="ORCA SCF收敛标准" value={active('convergence')?scf.convergence:retained.convergence??'normal'} onChange={event=>save({convergence:event.target.value as typeof scf.convergence})}>{(['loose','normal','strong','tight','verytight'] as const).map(value=><option value={value} key={value}>{{loose:'Loose',normal:'Normal',strong:'Strong',tight:'Tight',verytight:'VeryTight'}[value]}</option>)}</select>)}
        {group('strategy','收敛策略',<select disabled={!capabilities.scf||!active('strategy')} aria-label="ORCA SCF收敛策略" value={active('strategy')?scf.strategy:retained.strategy??'SlowConv'} onChange={event=>save({strategy:event.target.value as typeof scf.strategy})}><option value="SlowConv">SlowConv</option><option value="VerySlowConv">VerySlowConv</option></select>)}
        {group('maxIterations','最大迭代次数',<NumericInput disabled={!capabilities.scf||!active('maxIterations')} aria-label="ORCA SCF MaxIter" stepper={false} min="1" step="1" value={scf.maxIterations??retained.maxIterations??125} onChange={event=>save({maxIterations:event.target.value===''?Number.NaN:Number(event.target.value)})}/>)}
        {group('algorithm','算法',<select disabled={!capabilities.scf||!active('algorithm')} aria-label="ORCA SCF算法" value={active('algorithm')?scf.algorithm:retained.algorithm??'KDIIS'} onChange={event=>save({algorithm:event.target.value as typeof scf.algorithm})}>{['KDIIS','SOSCF','TRAH'].map(value=><option value={value} key={value}>{value}</option>)}</select>)}
      </InputSettingsRow>
    </InputSettingsEnableCard>
    <InputSettingsEnableCard title="积分网格" enabled={gridEnabled} disabled={!capabilities.grid} switchLabel="启用ORCA积分网格" sectionKey="integration" className={!capabilities.grid?'input-card-unavailable':''} onEnabledChange={checked=>onChange({grid:checked?memory.grid?.value??'auto':'auto',parameterDrafts:{...memory,grid:{enabled:checked,value:checked?memory.grid?.value??'auto':settings.grid??'auto'}}})} actions={onResetGrid&&<InputSettingsAction reset ariaLabel="恢复网格默认" disabled={!capabilities.grid} onClick={onResetGrid}>恢复默认</InputSettingsAction>}><div className="input-option-group"><InputSettingsCheckbox label="网格" checked={!!settings.grid&&settings.grid!=='auto'} disabled={!capabilities.grid} onChange={checked=>onChange({grid:checked?memory.grid?.value&&memory.grid.value!=='auto'?memory.grid.value:'DefGrid2':'auto',parameterDrafts:{...memory,grid:{enabled:true,value:settings.grid&&settings.grid!=='auto'?settings.grid:memory.grid?.value??'DefGrid2'}}})}/><select disabled={!capabilities.grid||!settings.grid||settings.grid==='auto'} aria-label="ORCA积分网格" value={settings.grid&&settings.grid!=='auto'?settings.grid:memory.grid?.value??'DefGrid2'} onChange={event=>onChange({grid:event.target.value as OrcaSettings['grid']})}>{['DefGrid1','DefGrid2','DefGrid3'].map(value=><option key={value} value={value}>{value}</option>)}</select></div></InputSettingsEnableCard>
  </>;
}