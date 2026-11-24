/** Emit the ordinary JSON spelling of scientific records without joining large
 * atom or frame arrays. Individual scalar values retain JSON.stringify's rules. */
export function* exportJsonChunks(value: unknown, indentation = 0, depth = 0): Generator<string> {
  const gap = (level: number) => indentation ? '\n' + ' '.repeat(indentation * level) : '';
  if (Array.isArray(value)) {
    yield '[';
    for (let index = 0; index < value.length; index++) {
      yield (index ? ',' : '') + gap(depth + 1);
      yield* exportJsonChunks(value[index] ?? null, indentation, depth + 1);
    }
    yield (value.length ? gap(depth) : '') + ']';
    return;
  }
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    yield '{';
    let written = false;
    for (const key of Object.keys(value)) {
      const field = (value as Record<string, unknown>)[key];
      if (field === undefined || typeof field === 'function' || typeof field === 'symbol') continue;
      yield (written ? ',' : '') + gap(depth + 1) + JSON.stringify(key) + (indentation ? ': ' : ':');
      yield* exportJsonChunks(field, indentation, depth + 1);
      written = true;
    }
    yield (written ? gap(depth) : '') + '}';
    return;
  }
  yield JSON.stringify(value) ?? 'null';
}
