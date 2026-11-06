import SettingsPanel,{type SettingsPanelProps} from './modeling/SettingsPanel';
/** Menu and viewport share this non-modal controlled settings surface. */
export default function EnvironmentSettings(props:SettingsPanelProps){return <SettingsPanel {...props}/>;}
