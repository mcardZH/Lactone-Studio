import type { ReactNode } from 'react';
import OrcaMethodChooser, { type OrcaMethodChooserProps } from './OrcaMethodChooser';
import { InputSettingsCard } from '../InputSettingsFields';
import { InputSettingsAction } from '../InputSettingsLayout';

export interface OrcaLevelProps extends OrcaMethodChooserProps { onRecommend?:()=>void; onInherit?:()=>void; inheritDisabled?:boolean; children?:ReactNode }
export default function OrcaLevel({ onRecommend, onInherit, inheritDisabled=false, children, ...props }: OrcaLevelProps) {
  return <InputSettingsCard title="方法与基组" sectionKey="level" className="input-level-card" actions={<>
    {onInherit&&<InputSettingsAction disabled={inheritDisabled} onClick={onInherit}>继承级别</InputSettingsAction>}
    {onRecommend&&<InputSettingsAction reset ariaLabel="恢复方法/基组" onClick={onRecommend}>恢复默认</InputSettingsAction>}
  </>}><OrcaMethodChooser {...props}/>{children}</InputSettingsCard>;
}
