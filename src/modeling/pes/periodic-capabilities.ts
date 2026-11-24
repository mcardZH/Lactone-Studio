import capabilities from '../../../desktop/pes-periodic-capabilities.json';
import type { PesOperation } from './contracts';

const methods: Readonly<Record<string, Partial<Record<PesOperation, readonly string[]>>>> = capabilities;

/** The same tested routes are exposed in the renderer and accepted by the desktop host. */
export function periodicPesOperationAvailable(method: string, operation: PesOperation, algorithm?: string): boolean {
  if (!Object.hasOwn(methods, method)) return false;
  const algorithms = methods[method][operation];
  return algorithms !== undefined && (algorithm === undefined || algorithms.includes(algorithm));
}
export function periodicPesMethods(): string[] {
  return Object.keys(methods).filter(method => Object.keys(methods[method]).some(operation => operation !== 'opt'));
}
