import { createHeldUndoRepeater } from './use-model-shortcuts';

/** Remote messages are already individual user intents. The owner must never
 * infer another held key from the delayed arrival of their release packet. */
export function dispatchWorkspaceUndoPress(input: { remote: boolean; repeat: boolean; structureLocked: boolean; selectionUndo: boolean }, actions: { undo(): void; startLocalRepeat(): void }) {
  if (input.remote) {
    if (!input.structureLocked || input.selectionUndo) actions.undo();
  } else if (!input.repeat) {
    if (input.structureLocked && input.selectionUndo) actions.undo();
    else actions.startLocalRepeat();
  }
}

/** Same 1 s / 100 ms user cadence as the local canvas, owned by the actual
 * input window. Slow transport keeps one in-flight intent and no repeat queue. */
export function createRemoteHeldUndo() {
  const repeater = createHeldUndoRepeater();
  let held = false, inFlight = false;
  return {
    get active() { return repeater.active; },
    get pending() { return inFlight; },
    stop() { held = false; repeater.stop(); },
    start(send: () => Promise<unknown>, allowed: () => boolean, onError: (error: unknown) => void) {
      if (repeater.active) return;
      held = true;
      repeater.start(() => {
        if (inFlight) return;
        inFlight = true;
        try {
          void Promise.resolve(send()).catch(onError).finally(() => { inFlight = false; });
        } catch (error) { inFlight = false; onError(error); }
      }, () => held && allowed());
    },
  };
}
