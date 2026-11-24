import type {ModelDocument} from '../../modeling/contracts';

/** A click owns one complete molecular geometry, independent of later playback. */
export interface CapturedStructureExportSource {
  document:ModelDocument;
  name?:string;
  assertCurrent():void;
}
/** The view that owns the visible file/job/frame supplies its own export source. */
export interface StructureExportSource {
  available:boolean;
  capture():CapturedStructureExportSource;
}
export interface StructureExportPort {
  available:boolean;
  busy:boolean;
  save():Promise<void>;
  capture?():CapturedStructureExportSource;
  exportImage?():void;
}
