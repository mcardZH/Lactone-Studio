import type { AdvancedPathBridge } from './path-contracts';
import type { AissBridge } from './docking-contracts';
import type { ConformerSamplingBridge } from './sampling-contracts';
import { bindNativeSourceStamp } from '../platform/native-source-stamp';
import { markDetachedSamplingPageFrame } from './route-data';

type Binding = ReturnType<typeof bindNativeSourceStamp>;
const terminal = new Set(['completed', 'stopped', 'error', 'search-checkpoint']);

export function bindAdvancedPathDesktopBridge(bridge: AdvancedPathBridge): AdvancedPathBridge {
  const sessions = new Map<string, Binding>();
  return {
    async startAdvancedPath(request, id) {
      const binding = bindNativeSourceStamp(request.stamp);
      sessions.set(id, binding);
      try { return await bridge.startAdvancedPath({ ...request, stamp: binding.wire }, id); }
      catch (error) { sessions.delete(id); throw error; }
    },
    async commandAdvancedPath(id, command) {
      const result = await bridge.commandAdvancedPath(id, command);
      if (result.status === 'stopped') sessions.delete(id);
      return result;
    },
    onAdvancedPathEvent(listener) {
      return bridge.onAdvancedPathEvent(event => {
        const stamp = sessions.get(event.sessionId)?.restore(event.stamp);
        if (!stamp) { listener(event); return; }
        if (terminal.has(event.event)) sessions.delete(event.sessionId);
        listener({ ...event, stamp });
      });
    },
  };
}

export function bindConformerSamplingDesktopBridge(bridge: ConformerSamplingBridge): ConformerSamplingBridge {
  const sessions = new Map<string, Binding>();
  const results = new Map<string, Binding>();
  return {
    async startConformerSampling(request, id) {
      const binding = bindNativeSourceStamp(request.stamp);
      sessions.set(id, binding);
      try { return await bridge.startConformerSampling({ ...request, stamp: binding.wire }, id); }
      catch (error) { sessions.delete(id); throw error; }
    },
    async commandConformerSampling(id, command) {
      const result = await bridge.commandConformerSampling(id, command);
      if (result.status === 'stopped') sessions.delete(id);
      return result;
    },
    onConformerSamplingEvent(listener) {
      return bridge.onConformerSamplingEvent(event => {
        const binding = sessions.get(event.sessionId);
        const stamp = binding?.restore(event.stamp);
        if (!binding || !stamp) { listener(event); return; }
        if ('resultHandle' in event && event.resultHandle) results.set(event.resultHandle.id, binding);
        if (terminal.has(event.event)) sessions.delete(event.sessionId);
        if (event.event === 'stage' && event.configuration) {
          const stamp = binding.restore(event.configuration.stamp);
          if (stamp) { listener({ ...event, stamp, configuration: { ...event.configuration, stamp } }); return; }
        }
        listener({ ...event, stamp });
      });
    },
    ...(bridge.readConformerSamplingResult ? {
      async readConformerSamplingResult(id: string, offset: number, limit: number) {
        const page = await bridge.readConformerSamplingResult!(id, offset, limit);
        const binding = results.get(id);
        if (!binding) return page;
        const frames = page.frames.map(frame => {
          const stamp = binding.restore(frame.stamp);
          if (!stamp) return frame;
          const restored = { ...frame, stamp };
          markDetachedSamplingPageFrame(restored);
          return restored;
        });
        return { ...page, frames };
      },
    } : {}),
    ...(bridge.releaseConformerSamplingResult ? {
      async releaseConformerSamplingResult(id: string) {
        const released = await bridge.releaseConformerSamplingResult!(id);
        results.delete(id);
        return released;
      },
    } : {}),
  };
}

export function bindAissDesktopBridge(bridge: AissBridge): AissBridge {
  const sessions = new Map<string, { run: Binding; first: Binding; second: Binding }>();
  return {
    async startAiss(request, id) {
      const [a, b] = request.sources;
      const run = bindNativeSourceStamp(request.stamp), first = bindNativeSourceStamp(a.stamp), second = bindNativeSourceStamp(b.stamp);
      sessions.set(id, { run, first, second });
      try {
        return await bridge.startAiss({ ...request, stamp: run.wire,
          sources: [{ ...a, stamp: first.wire }, { ...b, stamp: second.wire }] }, id);
      } catch (error) { sessions.delete(id); throw error; }
    },
    async commandAiss(id, command) {
      const result = await bridge.commandAiss(id, command);
      if (result.status === 'stopped') sessions.delete(id);
      return result;
    },
    onAissEvent(listener) {
      return bridge.onAissEvent(event => {
        const binding = sessions.get(event.sessionId);
        const stamp = binding?.run.restore(event.stamp);
        if (!binding || !stamp) { listener(event); return; }
        if ('sourceStamps' in event) {
          const a = binding.first.restore(event.sourceStamps[0]), b = binding.second.restore(event.sourceStamps[1]);
          if (!a || !b) { listener(event); return; }
          sessions.delete(event.sessionId);
          listener({ ...event, stamp, sourceStamps: [a, b] });
          return;
        }
        if (terminal.has(event.event)) sessions.delete(event.sessionId);
        listener({ ...event, stamp });
      });
    },
  };
}
