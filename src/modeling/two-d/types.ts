import type { Atom, Bond, Structure } from '../../core/types';

export type TwoDFormat = 'cdx' | 'cdxml' | 'mol' | 'ket';
export interface TwoDSourceInput { id: string; name?: string; format?: TwoDFormat; data: string | Uint8Array }
export interface TwoDIssue {
  code: string; message: string; severity: 'warning' | 'blocking'; atomIds?: string[];
  /** Missing correspondence stays a document risk rather than inventing an affected molecule. */
  scope?: 'document' | 'component'; sourceFragmentKey?: string; componentIds?: string[];
  resolution?: {
    kind: 'explicit-editor-change'; originalSeverity: 'blocking'; originalMessage: string;
    baselineComponentId: string; currentComponentId: string;
  };
}
export interface TwoDAtom extends Atom {
  id: string;
  /** Original KET node/atom or source-format identity, never a document row number. */
  sourceAtomKey: string;
  implicitHydrogens?: number;
  sourceProperties: Record<string, unknown>;
}
export interface TwoDComponent {
  id: string; label: string; sourceId: string; sourceNodeKey: string;
  atoms: TwoDAtom[]; bonds: Bond[]; issues: TwoDIssue[];
  /** A standalone editable KET with just this selected connected component. */
  ket: string;
}
export interface TwoDDraft {
  source: { id: string; name?: string; format: TwoDFormat };
  /** Original input remains outside Structure; binary assets are owned by the import caller. */
  raw: string | Uint8Array;
  ket: string; components: TwoDComponent[]; issues: TwoDIssue[];
}
export interface TwoDIndigoConverter {
  convert(input: string | Uint8Array, options: { inputFormat: TwoDFormat; outputFormat: 'ket'; signal?: AbortSignal }): Promise<string>;
}
export interface ParseTwoDOptions { sourceId: string; filename?: string; indigo?: TwoDIndigoConverter; signal?: AbortSignal }
export interface ParseKetDraftOptions {
  sourceId: string; filename?: string;
  /** Only an already-owned editor draft may be empty; external imports never enable this. */
  allowEmpty?: boolean;
}
export interface TwoDConversionAssessment { allowed: boolean; issues: TwoDIssue[] }
export interface RemainingTwoDSourceIssuesInput {
  sourceDraft: TwoDDraft | null | undefined;
  /** The first getKet after load, before user edits; never the current edited graph. */
  editorBaselineDraft: TwoDDraft | null | undefined;
  currentComponent: TwoDComponent; edited: boolean;
}
export interface TwoDCommitData {
  source: TwoDDraft['source']; selectedComponentId: string;
  originalKet: string; finalKet: string;
  finalGraph: Pick<Structure, 'atoms' | 'bonds' | 'layout2D'>;
  issues: TwoDIssue[]; edited: boolean;
}
