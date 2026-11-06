import type { ChemistryPort, DesktopBridge } from '../contracts';
import { createDesktopChemistryPort, desktopBridge } from '../platform/desktop';
import { WasmChemistryPort } from './wasm';

/** Explicit local legacy-browser entry; excluded from the desktop source snapshot. */
export function createChemistryPort(bridge: DesktopBridge | null = desktopBridge()): ChemistryPort {
  return createDesktopChemistryPort(bridge) ?? new WasmChemistryPort();
}
