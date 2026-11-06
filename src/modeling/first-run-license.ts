import { needsComputeResourceConfirmation, type ComputeResourceSnapshot } from './resource-preferences';
/** A reading receipt only; this does not add license terms or record legal acceptance. */
export interface FirstRunLicenseSnapshot {
  text: string;
  sha256: string;
  acknowledged: boolean;
  /** Only the primary workbench owns startup dialogs; detached windows do not. */
  prompt: boolean;
}
export interface FirstRunLicenseBridge {
  readFirstRunLicense(): Promise<FirstRunLicenseSnapshot>;
  acknowledgeFirstRunLicense(request: { licenseSha256: string }): Promise<FirstRunLicenseSnapshot>;
}
export function shouldOpenInitialResourceSetup(license: { ready: boolean; setupOwner: boolean }, resources: ComputeResourceSnapshot | null): boolean {
  return license.ready && license.setupOwner && resources !== null && needsComputeResourceConfirmation(resources);
}
