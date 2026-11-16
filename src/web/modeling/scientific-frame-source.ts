import type { ModelDocument, ModelSelection } from '../../modeling/contracts';
import type { AnalysisCanvas } from '../results/analysis-canvas';
import type { Structure } from '../../core/types';
import {captureStructureExportDocument} from '../../modeling/application/structure-export-snapshot';

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
  if(calculationSource&&!canvas?.onOptimize)throw new Error('当前视图未提供派生计算入口。');
  if(!canvas)return structuredClone(owner);
  if(canvas.scientificFrameReady===false||!canvas.staticDocument)throw new Error('当前科学帧尚未准备完整，请等待载入完成。');
  if(calculationSource&&canvas.displayOnlySourcePreview)throw new Error('当前显示为来源预览，请先返回已准备完整的科学帧。');
  const pausedCalculationSource=calculationSource&&canvas.scientificFrameReady===true&&canvas.bondEditingBlocked===false;
  if(calculationSource&&canvas.bondEditingBlocked===true||
    (calculationSource||!options?.allowAnimation)&&canvas.modelEditingBlocked&&!pausedCalculationSource)throw new Error('请先暂停播放或振动，再使用当前科学帧。');
  const structure=canvas.staticDocument.draft.structure;
  if(!structure.atoms.length||structure.atoms.some(atom=>!atom.id||![atom.x,atom.y,atom.z].every(Number.isFinite)))throw new Error('当前科学帧缺少完整原子坐标。');
  if(JSON.stringify(structure.atoms.map(atom=>[atom.id,atom.element]))!==JSON.stringify(owner.draft.structure.atoms.map(atom=>[atom.id,atom.element])))throw new Error('当前科学帧原子身份或顺序与模型不一致。');
  const source=structuredClone(owner);source.draft.structure=structuredClone(structure);
  if(options?.selection)source.selection=structuredClone(options.selection);
  source.draft.selectedIds=[...source.selection.atomIds];
  return source;
}
