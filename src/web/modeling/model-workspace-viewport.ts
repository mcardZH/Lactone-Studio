import type { ModelDocument } from '../../modeling/contracts';
import { displayedCoordinateObjects } from './coordinate-objects';
import type { ViewportStateMarker } from './viewport-overlays';
import type { WorkspaceViewportEvent } from './workspace-viewport';

interface DispatchContext {
  current: ModelDocument;
  releasing: boolean;
  resolveMarker(marker: ViewportStateMarker): ViewportStateMarker;
}
type ViewportHandlers = {
  [K in WorkspaceViewportEvent['type']]?:
    (event: WorkspaceViewportEvent & { type: K }, context: DispatchContext) => void | Promise<void>;
};
interface ViewportDispatchOptions {
  documentId: string;
  revision: number;
  read(): { document: ModelDocument; alive: boolean; active?: boolean };
  blocked(): boolean;
  markers: readonly ViewportStateMarker[];
  handlers: ViewportHandlers;
  onError(cause: unknown): void;
}

/** Resolve IPC marker identities against the current owner, never trust atom
 * IDs or coordinate IDs received from a detached viewport as model authority. */
export function resolveModelWorkspaceMarker(marker: ViewportStateMarker, current: ModelDocument,
  markers: readonly ViewportStateMarker[]): ViewportStateMarker {
  const known = markers.find(row => row.id === marker.id);
  if (known) return known;
  if (marker.kind === 'selection') {
    if (marker.coordinateId) {
      const object = displayedCoordinateObjects(current).find(row => row.id === marker.coordinateId
        && current.selection.coordinateIds?.includes(row.id));
      if (object && marker.id === `selection-coordinate:${object.id}`) {
        return { id: marker.id, kind: 'selection', coordinateId: object.id, atomIds: object.atomIds };
      }
    } else if (marker.atomIds.length === 1 && current.selection.atomIds.includes(marker.atomIds[0])
      && marker.id === `selection:${marker.atomIds[0]}`) {
      return { id: marker.id, kind: 'selection', atomIds: [marker.atomIds[0]] };
    }
  }
  throw new Error('视口状态标记已变化，请重新选择。');
}

/** A view adapter only. Handlers retain the existing model transactions and
 * tool/runtime policies. Key release must still clear held bookkeeping after
 * revision/activation changes; it cannot bypass owner lifetime or document ID. */
export function createModelWorkspaceViewportDispatcher(options: ViewportDispatchOptions) {
  return async (event: WorkspaceViewportEvent) => {
    try {
      const { document: current, alive, active } = options.read();
      const releasing = event.type === 'key' && event.release;
      if (!alive || current.id !== options.documentId || (!releasing && (active === false || current.revision !== options.revision))) {
        throw new Error('视口所属文档或修订已变化，请重新操作。');
      }
      if (!releasing && options.blocked()) throw new Error('请先完成当前对话框或工具栏编辑，再操作视口。');
      const handler = (Object.hasOwn(options.handlers, event.type) ? options.handlers[event.type] : undefined) as
        ((event: WorkspaceViewportEvent, context: DispatchContext) => void | Promise<void>) | undefined;
      if (!handler) throw new Error('未知视口交互事件。');
      await handler(event, { current, releasing,
        resolveMarker: marker => resolveModelWorkspaceMarker(marker, current, options.markers) });
    } catch (cause) { options.onError(cause); throw cause; }
  };
}
