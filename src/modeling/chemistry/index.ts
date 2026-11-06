import type { ChemistryPort, DesktopBridge } from '../contracts';
import { createDesktopChemistryPort, desktopBridge } from '../platform/desktop';

/** Composition boundary only: domain callers do not know Electron or Worker. */
export function createChemistryPort(bridge: DesktopBridge | null = desktopBridge()): ChemistryPort {
  return createDesktopChemistryPort(bridge) ?? {
    async capabilities() {
      return { engine: 'native-desktop-unavailable', native: false, operations: [] };
    },
    start() {
      throw new Error('此操作需要桌面版原生化学引擎；请在Ester Studio桌面程序中打开。');
    },
  };
}
