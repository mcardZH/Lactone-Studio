import { useEffect, useState } from 'react';
import { readSurfaceDisplayPreferences, writeSurfaceDisplayPreferences, restoreSurfaceDisplayPreferences, writeNamedOrbitalAppearance, type MeshAppearanceSnapshot, type SurfaceDisplayFamily, type SurfaceAppearanceSnapshot, type SurfaceDisplayPreferencesSnapshot } from '../../results/platform/surface-display-preferences';

interface AppearanceDefaultsState {
  ready: boolean;
  snapshot: SurfaceDisplayPreferencesSnapshot | null;
  busy: boolean;
  actionFamily?: SurfaceDisplayFamily;
  status: string;
  error: string;
}
interface AppearanceDefaultsPorts {
  read(): Promise<SurfaceDisplayPreferencesSnapshot>;
  write(snapshot: SurfaceDisplayPreferencesSnapshot, family: SurfaceDisplayFamily, appearance: SurfaceAppearanceSnapshot): Promise<SurfaceDisplayPreferencesSnapshot>;
  restore(snapshot: SurfaceDisplayPreferencesSnapshot, family: SurfaceDisplayFamily): Promise<SurfaceDisplayPreferencesSnapshot>;
  saveNamed?(snapshot: SurfaceDisplayPreferencesSnapshot, name: string, appearance: MeshAppearanceSnapshot): Promise<SurfaceDisplayPreferencesSnapshot>;
}

/** Shared cache of defaults, never a store of active analysis display state. */
export function createAppearanceDefaultsController(ports: AppearanceDefaultsPorts) {
  let state: AppearanceDefaultsState = { ready: false, snapshot: null, busy: false, status: '', error: '' };
  let reading: Promise<void> | null = null, queue: Promise<void> = Promise.resolve(), pending = 0;
  let acceptedRevision = 0;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<AppearanceDefaultsState>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  const read = (force = false): Promise<void> => {
    if (reading) return reading;
    if (state.ready && !force) return Promise.resolve();
    const revision = acceptedRevision;
    reading = ports.read().then(snapshot => { if (revision === acceptedRevision) publish({ ready: true, snapshot, error: snapshot.error ?? '', status: '' }); }).catch(error => { if (revision === acceptedRevision) publish({ ready: true, error: String(error), status: '' }); }).finally(() => { reading = null; });
    return reading;
  };
  const update = (family: SurfaceDisplayFamily, mutate: (snapshot: SurfaceDisplayPreferencesSnapshot) => Promise<SurfaceDisplayPreferencesSnapshot>, status: string): Promise<void> => {
    pending++;
    publish({ busy: true, actionFamily: family, status: '', error: '' });
    const operation = queue.then(async () => {
      await read();
      if (!state.snapshot?.writable) throw new Error(state.snapshot?.error || '本机外观默认存储不可用。');
      const snapshot = await mutate(state.snapshot);
      acceptedRevision++;
      publish({ snapshot, actionFamily: family, status, error: '' });
    }).catch(error => { publish({ actionFamily: family, status: '', error: error instanceof Error ? error.message : String(error) }); throw error; }).finally(() => { pending--; publish({ busy: pending > 0 }); });
    queue = operation.catch(() => {});
    return operation;
  };
  const save = (family: SurfaceDisplayFamily, appearance: SurfaceAppearanceSnapshot): Promise<void> => {
    const requested = structuredClone(appearance);
    return update(family, snapshot => ports.write(snapshot, family, requested), '已保存本类默认');
  };
  const restore = (family: SurfaceDisplayFamily): Promise<void> => update(family, snapshot => ports.restore(snapshot, family), '已恢复本类内置默认');
  const saveNamed = (name: string, appearance: MeshAppearanceSnapshot): Promise<void> => {
    const requested = structuredClone(appearance);
    return update('orbital', snapshot => {
      if (!ports.saveNamed) throw new Error('命名轨道外观存储不可用。');
      return ports.saveNamed(snapshot, name, requested);
    }, `已保存预设“${name}”`);
  };
  return { getSnapshot: () => state, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }, read, reload: () => read(true), save, saveNamed, restore };
}

const controller = createAppearanceDefaultsController({ read: readSurfaceDisplayPreferences, write: writeSurfaceDisplayPreferences, restore: restoreSurfaceDisplayPreferences, saveNamed: writeNamedOrbitalAppearance });
export function useSurfaceAppearanceDefaults() {
  const [state, setState] = useState(controller.getSnapshot);
  useEffect(() => { const off = controller.subscribe(() => setState(controller.getSnapshot())); setState(controller.getSnapshot()); void controller.read(); return off; }, []);
  return { ...state, save: controller.save, saveNamed: controller.saveNamed, restore: controller.restore, reload: controller.reload };
}
