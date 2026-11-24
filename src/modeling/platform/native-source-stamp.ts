import type { DocumentStamp } from '../../core/modeling/contracts';
import { sha256Utf8 } from '../../core/file-identity';

const prefix = 'es-stamp-sha256-v1:';
const tagged = /^es-stamp-sha256-v1:[a-f0-9]{64}$/;
const fields = ['graphFingerprint', 'coordinatesFingerprint', 'constraintsFingerprint'] as const;
type Stamp = DocumentStamp & { activationEpoch?: number };

/** Transport identity for one captured source. Persisted stamps stay exactly as captured. */
export function bindNativeSourceStamp<S extends Stamp>(stamp: S) {
  const source = Object.freeze(structuredClone(stamp));
  const wire = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)) as S;
  const encoded = fields.every(field => tagged.test(source[field]));
  if (!encoded) for (const field of fields) wire[field] = prefix + sha256Utf8(source[field]);
  Object.freeze(wire);

  return {
    wire,
    restore(received: Stamp | undefined): Readonly<S> | undefined {
      if (!received || received.documentId !== wire.documentId || received.revision !== wire.revision
          || received.activationEpoch !== wire.activationEpoch
          || Object.keys(received).length !== Object.keys(wire).length
          || JSON.stringify(received.nativeMDPolicy) !== JSON.stringify(wire.nativeMDPolicy)
          || fields.some(field => received[field] !== wire[field])) return undefined;
      return source;
    },
  };
}
