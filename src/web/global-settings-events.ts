export const GLOBAL_SETTINGS_OPEN = 'sciyue-global-settings-open';
export const MULTIWFN_CONFIGURATION_CHANGED = 'sciyue-multiwfn-configuration-changed';
export function openGlobalSettings() { window.dispatchEvent(new Event(GLOBAL_SETTINGS_OPEN)); }
/** One owned shell forwards native publication to every local analysis consumer. */
export function subscribeGlobalSettings(bridge: Pick<import('../modeling/contracts').DesktopBridge, 'onGlobalSettingsOpen'|'onMultiwfnConfigurationChanged'> | null | undefined, open: () => void) {
  let alive=true;
  const requested=()=>{if(alive)open();};
  window.addEventListener(GLOBAL_SETTINGS_OPEN,requested);
  const offOpen=bridge?.onGlobalSettingsOpen?.(requested);
  const offMultiwfn=bridge?.onMultiwfnConfigurationChanged?.(()=>{if(alive)window.dispatchEvent(new Event(MULTIWFN_CONFIGURATION_CHANGED));});
  return()=>{alive=false;window.removeEventListener(GLOBAL_SETTINGS_OPEN,requested);offOpen?.();offMultiwfn?.();};
}
