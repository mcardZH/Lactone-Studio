export type AdvancedOutputRequest = { directoryName: string; files: readonly { name: string; text: string }[] }
  | { mode:'existing-directory'; files:readonly {name:string;text:string}[]; reservedNames?:readonly string[] };
export interface AdvancedOutputManifest {
  schema: 'sciyue-advanced-output'; version: 1;
  files: readonly { name: string; bytes: number; sha256: string }[]; totalBytes: number;
}
export interface AdvancedOutputPartial {
  directory: string; directoryCreated: boolean;
  written: readonly { name: string; bytes: number; sha256: string }[];
  partialFile?: { name: string; bytes?: number }; tokenConsumed: boolean;
}
export type AdvancedOutputSelection = { status: 'cancelled' } | {
  status: 'selected'; token: string; directory: string; manifest: AdvancedOutputManifest; expiresAt: number;
};
export type AdvancedOutputWriteResult = { status: 'saved'; directory: string; manifest: AdvancedOutputManifest } | {
  status: 'failed'; error: { code: string; message: string; advancedOutput?: AdvancedOutputPartial };
};
export interface AdvancedOutputBridge {
  chooseAdvancedOutput(request: AdvancedOutputRequest): Promise<AdvancedOutputSelection>;
  writeAdvancedOutput(token: string): Promise<AdvancedOutputWriteResult>;
  abandonAdvancedOutput(token: string): Promise<{ released: boolean }>;
}
