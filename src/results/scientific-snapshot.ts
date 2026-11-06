import type { ScientificJob, ScientificLine, ScientificParserSnapshot } from './scientific-contracts';

const OMIT = Symbol('unclosed-scientific-block');
function sameShallow(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key]);
}
interface SnapshotOptions {
  /** First unclosed source line. Facts at/after it remain unpublished. */
  beforeLine?: number;
  /** The currently open table may already have an older complete projection. */
  withheld?: readonly object[];
  mutableSubtrees?: readonly object[];
  mutableSpines?: readonly object[];
}
/** Engine-independent immutable copy cache. Source objects are never frozen or
 * modified. Closed leaves are copied once; only explicit live boundaries change. */
export class ScientificSnapshotCache {
  private cache = new WeakMap<object, unknown>();
  private previousWithheld: readonly object[] = [];
  readonly counts = { copiedObjects: 0, reusedObjects: 0 };
  invalidateSpine(value: object): void { this.cache.delete(value); }
  invalidate(value: object): void {
    const visited = new WeakSet<object>();
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object' || visited.has(node)) return;
      visited.add(node); this.cache.delete(node);
      for (const child of Object.values(node)) visit(child);
    };
    visit(value);
  }
  project<T>(value: T, options: SnapshotOptions = {}): T {
    const withheld = new Set(options.withheld ?? []), mutable = new Set(options.mutableSpines ?? []), deep = new Set(options.mutableSubtrees ?? []);
    for (const node of this.previousWithheld) if (!withheld.has(node)) this.invalidate(node);
    this.previousWithheld = [...withheld];
    const copied = new WeakMap<object, unknown>();
    const copy = (node: unknown, forceDeep = false): unknown => {
      if (!node || typeof node !== 'object') return node;
      const line = (node as { sourceLine?: unknown }).sourceLine;
      if (options.beforeLine !== undefined && typeof line === 'number' && line >= options.beforeLine) return OMIT;
      const found = this.cache.get(node);
      if (withheld.has(node)) return found ?? OMIT;
      if (copied.has(node)) return copied.get(node);
      const descend = forceDeep || deep.has(node);
      const arrayChanged = Array.isArray(node) && Array.isArray(found) && node.length !== found.length;
      if (found !== undefined && !descend && !mutable.has(node) && !arrayChanged) { this.counts.reusedObjects++; return found; }
      let result: unknown;
      if (Array.isArray(node)) {
        const values: unknown[] = [];
        for (const item of node) { const next = copy(item, descend); if (next !== OMIT) values.push(next); }
        result = Object.freeze(values);
      } else {
        const values: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(node)) { const next = copy(item, descend); if (next !== OMIT) values[key] = next; }
        result = Object.freeze(values);
      }
      // Rechecking a live tail may prove it did not change. Keep that object's
      // immutable identity, including its closed coordinate/atom blocks.
      if (found && typeof found === 'object' && result && typeof result === 'object') {
        if (sameShallow(found, result)) {
          this.counts.reusedObjects++; copied.set(node, found); return found;
        }
      }
      this.counts.copiedObjects++; this.cache.set(node, result); copied.set(node, result); return result;
    };
    return copy(value) as T;
  }
}

/** Physical-line byte index shared with both grammars; it does not interpret
 * titles, stages, errors or any scientific field. */
export class ScientificSnapshotState {
  readonly cache = new ScientificSnapshotCache();
  private starts: number[] = [0];
  private end = 0;
  private revision = 0;
  private previous: readonly ScientificJob[] = [];
  observe(line: ScientificLine): void {
    this.starts[line.number] = line.start; this.end = line.end;
  }
  endOf(line: number): number { return line < 1 ? 0 : this.starts[line + 1] ?? this.end; }
  snapshot(jobs: ScientificJob[], active: ScientificJob | null, processedLine: number, options: SnapshotOptions = {}): ScientificParserSnapshot {
    const boundary = options.beforeLine === undefined ? this.endOf(processedLine) : Math.min(this.endOf(processedLine), this.starts[options.beforeLine] ?? this.endOf(processedLine));
    const spines: object[] = [...(options.mutableSpines ?? [])];
    if (active) {
      spines.push(active, active.frames, active.data);
      for (const value of Object.values(active.data)) if (Array.isArray(value)) spines.push(value);
      if (active.data.diagnostics) { spines.push(active.data.diagnostics); for (const value of Object.values(active.data.diagnostics)) if (Array.isArray(value)) spines.push(value); }
    }
    const all = [...jobs, ...(active ? [active] : [])]; spines.push(all);
    const projected = this.cache.project(all, { ...options, mutableSpines: spines });
    // The engine constructs tiny current-job/pending-frame envelopes anew.
    // Reconcile those spines by already shared child identities, without walking
    // closed scientific trees or inventing a revision for an open partial block.
    const stable = projected.map((job, index) => {
      const old = this.previous[index];
      if (!old || old.jobIndex !== job.jobIndex || old.segmentIndex !== job.segmentIndex || old.engine !== job.engine) return job;
      const frames = job.frames.map((frame, ordinal) => {
        const prior = old.frames[ordinal]; if (!prior) return frame;
        const next = { ...frame,
          ...(sameShallow(prior.energy, frame.energy) ? { energy: prior.energy } : {}),
          ...(Object.hasOwn(frame, 'coordinate') && sameShallow(prior.coordinate, frame.coordinate) ? { coordinate: prior.coordinate } : {}),
          ...(sameShallow(prior.convergence, frame.convergence) ? { convergence: prior.convergence } : {})
        };
        return sameShallow(prior, next) ? prior : Object.freeze(next);
      });
      const data = { ...job.data };
      for (const key of Object.keys(data) as (keyof typeof data)[]) if (Array.isArray(data[key]) && sameShallow(old.data[key], data[key])) Object.assign(data, { [key]: old.data[key] });
      const next = { ...job, frames: sameShallow(old.frames, frames) ? old.frames : Object.freeze(frames) as unknown as ScientificJob['frames'],
        data: sameShallow(old.data, data) ? old.data : Object.freeze(data), messages: sameShallow(old.messages, job.messages) ? old.messages : job.messages };
      return sameShallow(old, next) ? old : Object.freeze(next);
    });
    if (!sameShallow(this.previous, stable)) { this.previous = Object.freeze(stable); this.revision++; }
    return Object.freeze({ jobs: this.previous, publishedByteEnd: boundary, version: this.revision });
  }
}
