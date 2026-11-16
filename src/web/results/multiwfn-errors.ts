import type { OrbitalBackendInfo } from '../../results/orbital-contracts';

export const isMultiwfnBackendFailure = (message: string) => /\b[A-Z]+_(?:BACKEND_(?:MISSING|CONFIGURATION_INVALID|PROGRAM_UNAVAILABLE|CHANGED)|WORK_DIRECTORY_UNAVAILABLE)\b/.test(message);

const backendCode = {
  unconfigured: 'BACKEND_MISSING',
  'configuration-invalid': 'BACKEND_CONFIGURATION_INVALID',
  'program-unavailable': 'BACKEND_PROGRAM_UNAVAILABLE',
  'work-directory-unavailable': 'WORK_DIRECTORY_UNAVAILABLE',
} as const;

export function multiwfnBackendFailure(info: OrbitalBackendInfo, domain: string): string {
  const status = info.status && info.status !== 'ready' ? info.status : 'unconfigured';
  return `${domain}_${backendCode[status]}: ${info.details ?? info.message ?? ''}`;
}
