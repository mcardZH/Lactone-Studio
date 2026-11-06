/** Uncommitted structure-import resources survive failed asynchronous close. */
export function createImportResourceClosures() {
  const entries = new Map<string, { close(): Promise<void>; pending?: Promise<void>; failed: boolean }>();
  function close(id: string): Promise<void> {
    const entry = entries.get(id);
    if (!entry) return Promise.resolve();
    if (entry.pending) return entry.pending;
    const pending = Promise.resolve().then(entry.close).then(() => {
      if (entries.get(id) === entry) entries.delete(id);
    }, error => {
      entry.failed = true;
      throw error;
    }).finally(() => { if (entry.pending === pending) entry.pending = undefined; });
    entry.pending = pending;
    return pending;
  }
  return {
    register(id: string, release: () => Promise<void>) {
      if (entries.has(id)) throw Error('结构来源读取owner重复。');
      entries.set(id, { close: release, failed: false });
    },
    close,
    async retry() {
      const results = await Promise.allSettled([...entries.keys()].map(close));
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (errors.length) throw new AggregateError(errors.map(result => result.reason), '结构来源的读取资源仍待实际关闭。');
    },
    get pendingCount() { return entries.size; },
    get failedCount() { return [...entries.values()].filter(entry => entry.failed).length; },
  };
}
