import { Snowflake } from 'lucide-react';
import GeometryControls, { type GeometryControlsProps } from './GeometryControls';
import { InputSettingsAction, InputSettingsEnableCard } from './InputSettingsLayout';

/** Independent task card. Shared model freeze records remain owned by the model store. */
export default function GaussianFreezeControls({onInherit:_onInherit,inheritDisabled:_inheritDisabled,freezeEnabled=true,onFreezeEnabledChange,...props}: Omit<GeometryControlsProps, 'mode'> & {onInherit?:()=>void;inheritDisabled?:boolean;freezeEnabled?:boolean;onFreezeEnabledChange?:(enabled:boolean)=>void}) {
  return <InputSettingsEnableCard enabled={props.settings.task!=='sp'&&freezeEnabled} onEnabledChange={enabled=>onFreezeEnabledChange?.(enabled)} disabled={!onFreezeEnabledChange||props.settings.task==='sp'} switchLabel="启用模型冻结" title={<><Snowflake size={15}/>冻结</>} actions={onFreezeEnabledChange&&<InputSettingsAction reset ariaLabel="停用冻结，保留冻结定义" disabled={props.settings.task==='sp'} onClick={()=>onFreezeEnabledChange(false)}>恢复默认</InputSettingsAction>} sectionKey="freeze" className={'task-specific input-freeze-card'+(props.settings.task==='sp'?' input-card-unavailable':'')} field="freeze-controls" testId="gaussian-freeze-controls" tabIndex={-1}>
    <GeometryControls {...props} mode="freeze"/>
  </InputSettingsEnableCard>;
}
