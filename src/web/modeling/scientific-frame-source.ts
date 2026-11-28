import type { ModelDocument, ModelSelection } from '../../modeling/contracts';
import type { AnalysisCanvas } from '../results/analysis-canvas';
import type { Structure } from '../../core/types';
import {captureStructureExportDocument} from '../../modeling/application/structure-export-snapshot';
import type {TrajectoryResult} from '../../results/contracts';
import {getPreparedTrajectoryFrame,type PreparedFrame} from '../../results/prepared-trajectory';
import {inferBuilderBonds} from '../../core/builder-geometry';

/** A scientific consumer borrows the prepared raw frame, or reads the same
 * source directly. Display preparation is neither a dependency nor a fallback. */
export async function readScientificTrajectoryFrame(result:TrajectoryResult,index:number,signal?:AbortSignal):Promise<Structure>{
  signal?.throwIfAborted();
  return getPreparedTrajectoryFrame(result,index)?.raw??result.getFrame(index,signal??new AbortController().signal);
}

/** A calculation uses the publisher's exact raw structure rather than the
 * display document, which may own per-frame edits, inference or alignment. */
export function scientificCanvasStructure(canvas?:AnalysisCanvas|null,submittedOnly=false):Structure|undefined{
  if(!canvas||canvas.displayOnlySourcePreview)return;
  if(submittedOnly&&canvas.readSubmittedScientificFrame)return canvas.readSubmittedScientificFrame()?.structure;
  if(canvas.scientificFrameReady===false)return;
  if(canvas.scientificDocument)return canvas.scientificDocument.draft.structure;
  if(canvas.result)return canvas.frameIndex===undefined?undefined:getPreparedTrajectoryFrame(canvas.result,canvas.frameIndex)?.raw;
  return canvas.staticDocument?.draft.structure;
}

/** Prepare the editable copy from its own coordinates when the source has no
 * graph. An explicit empty graph remains authoritative. */
export function scientificFrameForModel(structure:Structure,prepared?:PreparedFrame):Structure{
  if(structure.bonds!==undefined||structure.periodicSource?.completeness==='partial')return structure;
  const raw=prepared?.raw,display=prepared?.structure;
  if(raw&&display?.bonds&&(raw===structure||(
    raw.atoms.length===structure.atoms.length&&raw.atoms.every((atom,index)=>{
      const source=structure.atoms[index];
      return atom.id===source.id&&atom.element===source.element&&atom.x===source.x&&atom.y===source.y&&atom.z===source.z;
    })&&JSON.stringify(raw.cell)===JSON.stringify(structure.cell)
      &&JSON.stringify(raw.periodicSource)===JSON.stringify(structure.periodicSource)))){
    return {...structure,bonds:display.bonds,bondSource:display.bondSource??'inferred'};
  }
  return inferBuilderBonds(structure);
}

export function scientificFrameForCanvasModel(structure:Structure,canvas?:AnalysisCanvas|null):Structure{
  const submitted=canvas?.readSubmittedScientificFrame?.();
  return scientificFrameForModel(structure,submitted&&getPreparedTrajectoryFrame(submitted.result,submitted.index));
}

/** Seal the geometry already supplied to a visible canvas. This is an export
 * copy, so animation, preparation of another frame, and native progress do not
 * change it. Camera/alignment transforms and overlay objects are not inputs. */
export function captureDisplayedStructureDocument(owner:ModelDocument,input?:{document?:ModelDocument;structure?:Structure;displayAtoms?:Structure['atoms']}):ModelDocument {
  const geometry=input?.structure??input?.document?.draft.structure??owner.draft.structure;
  const atoms=input?.displayAtoms??geometry.atoms,expected=owner.draft.structure.atoms;
  if(!atoms.length||atoms.some(atom=>!atom.id||![atom.x,atom.y,atom.z].every(Number.isFinite)))throw new Error('当前画布缺少完整原子坐标。');
  if(atoms.length!==expected.length||atoms.some((atom,index)=>atom.id!==expected[index].id||atom.element!==expected[index].element))throw new Error('当前画布原子身份或顺序与所属文档不一致。');
  return captureStructureExportDocument(owner,geometry,atoms);
}

/** A source preview must not replace the real frame identity. An actual new
 * result remains authoritative even while its frame is still being prepared. */
export function scientificSourceCanvas(displayed:AnalysisCanvas|null|undefined,retained?:AnalysisCanvas|null):AnalysisCanvas|undefined{
  if(displayed&&!displayed.displayOnlySourcePreview)return displayed;
  return retained&&!retained.displayOnlySourcePreview?retained:undefined;
}

/** Identity of the published scientific frame, independent of camera and
 * vibration phase. A cached context must never be re-signed with a newer key. */
export function scientificCanvasKey(canvas?: AnalysisCanvas | null): string {
  if(canvas?.readSubmittedScientificFrame){
    const submitted=canvas.readSubmittedScientificFrame();
    return JSON.stringify([canvas.result?.id,canvas.sourceRevision,submitted?.result.source.id,submitted?.result.source.sha256,
      submitted?.result.jobIndex,submitted?.collection,submitted?.stageId,submitted?.frameId,submitted?.index]);
  }
  return JSON.stringify([canvas?.result?.id,canvas?.result?.source.id,canvas?.result?.source.sha256,
    canvas?.sourceRevision,canvas?.result?.jobIndex,canvas?.frameIndex,
    canvas?.result?.frames[canvas.frameIndex??-1]?.stageId,
    canvas?.result?.frames[canvas.frameIndex??-1]?.sourceFrameIndex,
    canvas?.trajectoryPlayback?.state.collectionIdentity]);
}

/** Seal one complete raw frame while keeping the real model's metadata owner.
 * Display coordinates, alignment, camera, and vibration phases are not inputs. */
export function captureScientificModelDocument(owner:ModelDocument,canvas?:AnalysisCanvas|null,options?:{allowAnimation?:boolean;selection?:ModelSelection;purpose?:'calculation-source'}):ModelDocument {
  const calculationSource=options?.purpose==='calculation-source';
  if(!canvas)return structuredClone(owner);
  if(calculationSource&&canvas.displayOnlySourcePreview)throw new Error('当前显示为来源预览，请先返回已显示的完整科学帧。');
  if(calculationSource&&!canvas.onOptimize&&(canvas.result||canvas.modelEditingBlocked))
    throw new Error('当前视图未提供派生计算入口。');
  const submitted=calculationSource?canvas.readSubmittedScientificFrame?.():undefined;
  const raw=submitted?.structure??scientificCanvasStructure(canvas,calculationSource);
  if(!raw)throw new Error('当前科学帧尚未准备完整，请等待载入完成。');
  const independentCalculation=Boolean(submitted&&canvas.onOptimize);
  const pausedCalculationSource=calculationSource&&canvas.scientificFrameReady===true&&canvas.bondEditingBlocked===false;
  if(!independentCalculation&&((calculationSource&&canvas.bondEditingBlocked===true)||
    ((calculationSource||!options?.allowAnimation)&&canvas.modelEditingBlocked&&!pausedCalculationSource)))throw new Error('请先暂停播放或振动，再使用当前科学帧。');
  const structure=raw;
  if(!structure.atoms.length||structure.atoms.some(atom=>!atom.id||![atom.x,atom.y,atom.z].every(Number.isFinite)))throw new Error('当前科学帧缺少完整原子坐标。');
  if(JSON.stringify(structure.atoms.map(atom=>[atom.id,atom.element]))!==JSON.stringify(owner.draft.structure.atoms.map(atom=>[atom.id,atom.element])))throw new Error('当前科学帧原子身份或顺序与模型不一致。');
  const source=structuredClone(owner);source.draft.structure=structuredClone(structure);
  if(canvas.pesConstraints)source.sharedConstraints=structuredClone(canvas.pesConstraints);
  if(options?.selection)source.selection=structuredClone(options.selection);
  source.draft.selectedIds=[...source.selection.atomIds];
  return source;
}
