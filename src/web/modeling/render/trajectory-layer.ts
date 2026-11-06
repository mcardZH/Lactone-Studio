import type { Atom, Bond, PeriodicCell, Structure, Vector3 } from '../../../core/types';
import type { DisplaySettings } from '../../../modeling/contracts';
import { structureShellFinish } from '../../../modeling/appearance-presets';
import { validateMultiframeDisplayPlan, type MultiframeDisplayPlan } from '../../../modeling/view-multiframe';
import { structureAtomStyle, bondDisplayRadius, structureBondRadius, displayScale } from '../structure-display';
import { elementColor } from './element-colors';
import { cellEdgeStrokes,cellEdgeStrokesWork } from './display-settings';
import { attachLocalMeshFinish, attachStructureShapeFinish, attachStructureModelFinish } from './mesh-finish';
import { applyResolvedAtomStyles } from './atom-style-batch';
import type { SceneShapeMethod } from './scene-sequence';
import { transformAtoms, transformPoint, rotate, composeTransforms, type RigidTransform } from './alignment';
import { bondConnectionOnly, bondPathSections,bondPathSectionsWork, dashedBondSections,dashedBondSectionsWork, cellSegments, coordinates, point } from './geometry';
import { periodicGlyphRequired, type createPeriodicBondGlyphExporter, type periodicBondGlyphContext } from './periodic-bond-glyph';
import { clippedCellCylinder, cellRenderPlanes, needsObliqueCellCap } from './cell-cylinder';
import { createShapeLayer } from './shape-layer';
import { includeRenderPoint, unionRenderBounds, type RenderBounds } from './depth-envelope';
import { periodicDisplayConnectionsWork, periodicDisplayInstancesWork, periodicDisplaySettings, preparePeriodicDisplayConnectionsWork, type PeriodicDisplayInstance, type PeriodicDisplayConnectionContext } from './periodic-display';
import {finishRenderWork,type RenderWork} from './render-work';
import { fractionalToCartesian } from '../../../core/periodic';
import { add } from './geometry';
export function displayHiddenAtomIds(ids:readonly string[]|undefined,structure?:Structure):Set<string> {
  if(ids===undefined)return new Set();
  const inventory=structure?new Set(structure.atoms.map(atom=>atom.id)):undefined;
  if(!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id)
    ||inventory&&ids.some(id=>!inventory.has(id)))throw new Error('隐藏原子必须对应当前完整显示结构的稳定ID。');
  return new Set(ids);
}

/** Same native adjacency for the primary model and display-only frame models. */
export function frameModelAtoms(structure: Structure, positions: readonly Atom[],hidden:ReadonlySet<string>=new Set(),showBonds=true,display?:DisplaySettings) {
  const links = positions.map(() => ({ bonds: [] as number[], bondOrder: [] as number[],bondStyles:[] as {radius:number}[] }));
  for (const bond of showBonds?structure.bonds ?? []:[]) {
    if (hidden.has(positions[bond.a]?.id!)||hidden.has(positions[bond.b]?.id!)||bond.order === .5 || bondConnectionOnly(bond) || bond.image?.some(Boolean) || periodicGlyphRequired(structure, bond) || !links[bond.a] || !links[bond.b]) continue;
    const order = !bond.fractional && (bond.aromatic || bond.order === 1.5) ? 4 : bond.order;
    links[bond.a].bonds.push(bond.b); links[bond.a].bondOrder.push(order); links[bond.b].bonds.push(bond.a); links[bond.b].bondOrder.push(order);
    if(display?.structureLighting?.startsWith('pymol-')){
      const radius=structureBondRadius(display,positions[bond.a].element,positions[bond.b].element);
      links[bond.a].bondStyles.push({radius});links[bond.b].bondStyles.push({radius});
    }
  }
  return positions.map((atom, index) => {const {bondStyles,...link}=links[index];return { elem: atom.element, x: atom.x, y: atom.y, z: atom.z, serial: index + 1, index, ...link,...(bondStyles.length?{bondStyles}:{})};});
}
const displayedCell = (cell: PeriodicCell, transform: RigidTransform): PeriodicCell => ({ ...cell,
  vectors: cell.vectors.map(v => rotate(transform.rotation, v)) as [Vector3, Vector3, Vector3], origin: transformPoint(transform, cell.origin ?? [0, 0, 0]) });

/** Existing capped/colored rod and native periodic glyph painting shared with
 * the base adapter. This is geometry presentation, without proxies or selection. */
export function createFrameBondPainter(viewer: any, keep: <T>(shape: T) => T, glyphs: ReturnType<typeof createPeriodicBondGlyphExporter>,finish?:()=>DisplaySettings['structureFinish'],construct?:(method:SceneShapeMethod,spec:any)=>any,lighting?:()=>DisplaySettings['structureLighting']) {
  const finished=(handle:any)=>attachStructureShapeFinish(handle,finish?.(),lighting?.());
  const create=(method:SceneShapeMethod,spec:any)=>construct?construct(method,spec):viewer[method](spec);
  const shape = (method: SceneShapeMethod, spec: any) => keep(method==='addLine'?create(method,spec):finished(create(method,spec)));
  const drawCappedRod = (start: Vector3, end: Vector3, radius: number, color: any, fromCap = 1, toCap = 1,
    clip?: { start: Vector3; end: Vector3; cell: PeriodicCell }, opacity = 1) => {
    const planes = clip ? cellRenderPlanes(clip.cell) : [];
    if (clip && needsObliqueCellCap(start, end, clip.start, clip.end, planes)) {
      const mesh = clippedCellCylinder(clip.start, clip.end, radius, planes);
      if (mesh.faces.length) keep(finished(create('addCustom',{ vertexArr: mesh.vertices.map(point), normalArr: mesh.normals.map(point), faceArr: mesh.faces, color, opacity })));
    } else shape('addCylinder', { start: point(start), end: point(end), radius, color, opacity,
      fromCap: clip && Math.hypot(...start.map((value, axis) => value - clip.start[axis])) > 1e-8 ? 1 : fromCap,
      toCap: clip && Math.hypot(...end.map((value, axis) => value - clip.end[axis])) > 1e-8 ? 1 : toCap });
  };
  const drawColoredRod = (start: Vector3, end: Vector3, t0: number, t1: number, colors: [string, string], radius: number,
    cap = 1, cell?: PeriodicCell, sourceT0 = 0, sourceT1 = 1, opacity = 1) => {
    const at = (t: number) => start.map((v, i) => v + (end[i] - v) * (t - t0) / (t1 - t0)) as Vector3;
    const paint = (lo: number, hi: number, color: string, sourceLo: number, sourceHi: number) => drawCappedRod(at(lo), at(hi), radius, color, cap, cap, cell ? { start: at(sourceLo), end: at(sourceHi), cell } : undefined, opacity);
    if (colors[0] === colors[1]) { paint(t0, t1, colors[0], sourceT0, sourceT1); return; }
    if (t0 < .5 - 1e-10 && t1 > .5 + 1e-10) { paint(t0, .5, colors[0], sourceT0, Math.min(.5, sourceT1)); paint(.5, t1, colors[1], Math.max(.5, sourceT0), sourceT1); }
    else if (t1 <= .5 + 1e-10) paint(t0, t1, colors[0], sourceT0, Math.min(.5, sourceT1)); else paint(t0, t1, colors[0], Math.max(.5, sourceT0), sourceT1);
  };
  function* paintSpecialBondWork(input: { structure: Structure; bond: Bond; rawPositions: Atom[]; transform: RigidTransform; settings: DisplaySettings;
    atomStyles: readonly any[]; atomColor(index: number): string; preview?: boolean; finiteGlyph?: boolean; prepared?: ReturnType<typeof periodicBondGlyphContext>; instances?: readonly PeriodicDisplayInstance[]; connectionContext?: PeriodicDisplayConnectionContext;
    cooperative?:boolean;onGeometry?(geometry:{start:Vector3;end:Vector3;radius:number;colors:[any,any];base:boolean}):void }):RenderWork<void> {
    const { structure, bond, rawPositions, transform, settings, atomStyles, atomColor } = input;
    if (settings.representation === 'vdw'||settings.showBonds===false||bond.image?.some(Boolean)&&!periodicDisplaySettings(settings).showCrossBoxBonds) return;
    const native = periodicGlyphRequired(structure, bond);
    const expanded=!!structure.cell?.pbc.some(Boolean)&&(bond.image?.some(Boolean)||periodicDisplaySettings(settings).images);
    if(structure.cell?.pbc.some(Boolean)&&(bond.image?.some(Boolean)||periodicDisplaySettings(settings).images)){
      const instances=input.instances??(yield* periodicDisplayInstancesWork(structure,rawPositions,settings)),look=periodicDisplaySettings(settings);
      let primitives:ReturnType<typeof glyphs.export>|undefined;
      for(const connection of yield* periodicDisplayConnectionsWork(structure,bond,rawPositions,instances,settings,input.connectionContext)){
        yield;
        if(connection.full){
          // The native base model already draws ordinary in-cell relations.
          if(connection.base&&!bond.image?.some(Boolean)&&!native&&!input.preview&&bond.order!==.5&&!bondConnectionOnly(bond)){input.onGeometry?.({start:transformPoint(transform,connection.start),end:transformPoint(transform,connection.end),radius:bondDisplayRadius(settings),colors:[atomColor(bond.a),atomColor(bond.b)],base:true});continue;}
          if(native){
            primitives??=glyphs.export(structure,bond,rawPositions,atomStyles,'stick',input.prepared,true);
            const translation=fractionalToCartesian(structure.cell,connection.shift,false);
            for(const primitive of primitives){yield;const start=transformPoint(transform,add(primitive.start,translation)),end=transformPoint(transform,add(primitive.end,translation));
              input.onGeometry?.({start,end,radius:primitive.kind==='line'?.035:primitive.radius,colors:[primitive.color,primitive.color],base:connection.base});
              if(primitive.kind==='line')shape('addLine',{start:point(start),end:point(end),color:primitive.color,linewidth:2});else drawCappedRod(start,end,primitive.radius,primitive.color,primitive.fromCap,primitive.toCap);}
          }else{
            const sections=bond.order===.5?(yield* dashedBondSectionsWork({start:connection.start,end:connection.end,t0:0,t1:1,shift:[0,0,0]},Math.hypot(...connection.end.map((v,i)=>v-connection.start[i])),displayScale(settings.bondScale))):[{start:connection.start,end:connection.end,t0:0,t1:1}];
            for(const section of sections){yield;const start=transformPoint(transform,section.start),end=transformPoint(transform,section.end),radius=bondDisplayRadius(settings),colors:[string,string]=[atomColor(bond.a),atomColor(bond.b)];input.onGeometry?.({start,end,radius,colors,base:connection.base});drawColoredRod(start,end,section.t0,section.t1,colors,radius);}
          }
        }else{
          const radius=(look.boundaryStyle==='thin'?.035:bondDisplayRadius(settings))*displayScale(look.boundaryStyle==='thin'?settings.bondScale:1);
          const color=atomColor(connection.sourceIndex);
          const start=transformPoint(transform,connection.start),end=transformPoint(transform,connection.end);input.onGeometry?.({start,end,radius,colors:[color,color],base:connection.base});drawCappedRod(start,end,radius,color,1,1);
        }
      }
      return;
    }
    if (native) for (const primitive of glyphs.export(structure, bond, rawPositions, atomStyles, 'stick', input.prepared)) {
      yield;
      const start = transformPoint(transform, primitive.start), end = transformPoint(transform, primitive.end);
      if (primitive.kind === 'line') shape('addLine', { start: point(start), end: point(end), color: primitive.color, linewidth: 2 });
      else drawCappedRod(start, end, primitive.radius, primitive.color, primitive.fromCap, primitive.toCap,
        primitive.cellClip ? { start: transformPoint(transform, primitive.cellClip.start), end: transformPoint(transform, primitive.cellClip.end), cell: displayedCell(primitive.cellClip.cell, transform) } : undefined);
    }
    if (native || input.finiteGlyph || !(input.preview || bond.order === .5 || bondConnectionOnly(bond) || bond.image?.some(Boolean))) return;
    const sections = yield* bondPathSectionsWork(rawPositions, bond, structure.cell), length = sections.reduce((sum, section) => sum + Math.hypot(...section.end.map((v, i) => v - section.start[i])), 0);
    const visible = [];for(const section of sections)if(bond.order===.5)for(const dash of yield* dashedBondSectionsWork(section,length,displayScale(settings.bondScale)))visible.push(dash);else visible.push(section);
    const cell = structure.cell && bond.image?.some(Boolean) ? displayedCell({ ...structure.cell, pbc: structure.cell.pbc.map((enabled, axis) => enabled && !!bond.image?.[axis]) as [boolean, boolean, boolean] }, transform) : undefined;
    for (const section of visible){yield;drawColoredRod(transformPoint(transform, section.start), transformPoint(transform, section.end), section.t0, section.t1,
      [atomColor(section.t0 >= .5 - 1e-10 ? bond.b : bond.a), atomColor(section.t1 <= .5 + 1e-10 ? bond.a : bond.b)], bondDisplayRadius(settings), 1, cell, section.sourceT0, section.sourceT1);}
  }
  const paintSpecialBond=(input:Parameters<typeof paintSpecialBondWork>[0])=>finishRenderWork(paintSpecialBondWork(input));
  return { drawCappedRod, drawColoredRod, paintSpecialBond,paintSpecialBondWork };
}

/** A bounded presentation child of the existing viewer. No canvas, camera,
 * source mutation, model picking or global model/style operations. */
export function createTrajectoryLayer(viewer: any, owner: { keepModel<T>(model: T): T; retireModel(model: any, remove: () => unknown): void },
  glyphs: ReturnType<typeof createPeriodicBondGlyphExporter>, radius: (element: string, display: DisplaySettings) => number) {
  type Child = { model:any; shapes:ReturnType<typeof createShapeLayer>; bounds:RenderBounds|null; visible:boolean };
  const children=new Map<string,Child>(),validated=new WeakSet<object>();
  let currentPlan: MultiframeDisplayPlan | undefined, signature = '', disposed = false;
  const retire=(child:Child)=>{try{child.shapes.clear();}finally{owner.retireModel(child.model,()=>viewer.removeModel(child.model));}};
  const visible=(child:Child,value:boolean)=>{if(child.visible===value)return;child.visible=value;if(value)child.model.show?.();else child.model.hide?.();for(const shape of child.shapes.handles())shape.hidden=!value;};
  const clear = () => {
    signature = ''; currentPlan = undefined; let failure: unknown;
    for(const [key,child]of children){children.delete(key);try{retire(child);}catch(error){failure??=error;}}
    if (failure) throw failure;
  };
  return {
    sync(plan: MultiframeDisplayPlan | undefined, display: DisplaySettings, outer: RigidTransform,hiddenIds?:readonly string[]) {finishRenderWork(this.syncWork(plan,display,outer,hiddenIds));},
    *syncWork(plan: MultiframeDisplayPlan | undefined, display: DisplaySettings, outer: RigidTransform,hiddenIds?:readonly string[],cooperative=false):RenderWork<void> {
      if (disposed) throw new Error('多帧显示图层已关闭。');
      if (!plan) { if (children.size || currentPlan) clear(); return; }
      if(!validated.has(plan.frames)){validateMultiframeDisplayPlan(plan);validated.add(plan.frames);}
      const hidden=displayHiddenAtomIds(hiddenIds,plan.frames[0].structure),next = JSON.stringify([plan.key, (plan as MultiframeDisplayPlan&{generation?:number}).generation, display, outer,hiddenIds]);
      if(plan===currentPlan&&next===signature)return;
      const same=next===signature,staged=new Map<string,Child>();let committed=false;
      try {
        for (const frame of plan.frames) {
          yield;
          if (frame.key === plan.activeFrameKey) continue;
          if(same&&children.has(frame.key))continue;
          const shapes=createShapeLayer(viewer),painter=createFrameBondPainter(viewer,shape=>shapes.keep(shape),glyphs,()=>display.structureFinish,undefined,()=>display.structureLighting);
          let bounds:RenderBounds|null=null;
          const transform = composeTransforms(outer, frame.transform), positions = transformAtoms(frame.structure.atoms, transform);
          const styles = positions.map(atom => hidden.has(atom.id!)?{}:structureAtomStyle(display, atom.element, elementColor(atom.element, display.elementColors)));
          const instances=yield* periodicDisplayInstancesWork(frame.structure,frame.structure.atoms,display,hidden);
          const connectionContext=frame.structure.cell?.pbc.some(Boolean)&&(periodicDisplaySettings(display).images||frame.structure.bonds?.some(bond=>bond.image?.some(Boolean)))
            ?yield* preparePeriodicDisplayConnectionsWork(frame.structure,frame.structure.atoms,instances,display):undefined;
          const model = owner.keepModel(attachStructureModelFinish(viewer.addModel('', 'xyz'),display.structureFinish,display.structureLighting));
          const child:Child={model,shapes,bounds:null,visible:true};staged.set(frame.key,child);
          model.addAtoms(frameModelAtoms(frame.structure, positions,hidden,display.showBonds!==false,display));
          applyResolvedAtomStyles(model, styles, (index, style) => { if (typeof model.setStyle === 'function') model.setStyle({ index }, style); else viewer.setStyle({ model, index }, style); });
          if (typeof model.setClickable === 'function') model.setClickable({}, false, () => {}); else viewer.setClickable({ model }, false, () => {});
          for (const atom of positions) bounds = includeRenderPoint(bounds, coordinates(atom), radius(atom.element, display));
          for(const instance of instances)if(!instance.base){
            yield;
            const atom=positions[instance.sourceIndex],position=transformPoint(transform,instance.position),style=styles[instance.sourceIndex] as any;
            shapes.keep(attachLocalMeshFinish(viewer.addSphere({center:point(position),radius:radius(atom.element,display),color:(style.sphere??style.stick).color,clickable:false,hoverable:false}),display.structureFinish,display.structureLighting));
            bounds=includeRenderPoint(bounds,position,radius(atom.element,display));
            if(display.vdwShell)shapes.keep(attachLocalMeshFinish(viewer.addSphere({center:point(position),radius:radius(atom.element,{...display,representation:'vdw',atomScale:1,elementScales:{}}),color:display.vdwShell.color,opacity:display.vdwShell.opacity,clickable:false,hoverable:false}),structureShellFinish(display)));
          }
          if(display.vdwShell)for(const atom of positions)if(!hidden.has(atom.id!)){
            yield;
            // VDW layer radius is renderer-owned, independent of user core sizes.
            const shellRadius=radius(atom.element,{...display,representation:'vdw',atomScale:1,elementScales:{}});
            shapes.keep(attachLocalMeshFinish(viewer.addSphere({center:point(coordinates(atom)),radius:shellRadius,color:display.vdwShell.color,opacity:display.vdwShell.opacity,clickable:false,hoverable:false}),structureShellFinish(display)));
          }
          if(cooperative&&display.representation!=='vdw'&&display.showBonds!==false)yield signal=>glyphs.prepareBatchAsync(frame.structure,frame.structure.atoms,styles,periodicDisplaySettings(display).images,signal);
          for (const bond of frame.structure.bonds ?? []) if(!hidden.has(positions[bond.a]?.id!)&&!hidden.has(positions[bond.b]?.id!))yield* painter.paintSpecialBondWork({ structure: frame.structure, bond, rawPositions: frame.structure.atoms, transform, settings: display,
            atomStyles: styles, atomColor: index => (styles[index] as any)?.stick?.color??elementColor(positions[index].element, display.elementColors),instances,connectionContext,cooperative });
          if (display.cell && frame.structure.cell) for (const [rawStart, rawEnd] of cellSegments(frame.structure.cell)) {
            const start=transformPoint(transform,rawStart),end=transformPoint(transform,rawEnd);
            // Preserve the older secondary-frame cell when no custom style was
            // saved. Explicit cell settings apply to all displayed frames.
            if(!display.cellStyle)shapes.keep(viewer.addLine({start:point(start),end:point(end),color:'#899eac',linewidth:1.2}));
            else {
              const middle=start.map((value,axis)=>(value+end[axis])/2) as Vector3;
              const project=(position:Vector3)=>viewer.modelToScreen(point(position));
              const a=project(middle),pixelsPerUnit=Math.max(...[0,1,2].map(axis=>{const b=project(middle.map((value,index)=>value+Number(axis===index)) as Vector3);return Math.hypot(b.x-a.x,b.y-a.y);}));
              for(const stroke of yield* cellEdgeStrokesWork(start,end,pixelsPerUnit,display)){yield;shapes.keep(viewer.addCylinder({start:point(stroke.start),end:point(stroke.end),radius:stroke.radius,color:stroke.color,fromCap:1,toCap:1,clickable:false,hoverable:false}));}
            }
          }
          child.bounds=bounds;
        }
        if(!same){for(const child of children.values())retire(child);children.clear();}
        for(const [key,child]of staged)children.set(key,child);
        for(const [key,child]of children)visible(child,key!==plan.activeFrameKey);
        currentPlan = plan; signature = next;
        committed=true;
      } finally {if(!committed)for(const child of staged.values())retire(child);}
    },
    clear, bounds: () => unionRenderBounds(...[...children.values()].filter(child=>child.visible).flatMap(child=>[child.bounds,child.shapes.bounds()])),
    state: () => ({ modelCount: [...children.values()].filter(child=>child.visible).length, shapeCount: [...children.values()].filter(child=>child.visible).reduce((n,child)=>n+child.shapes.size,0), atomInstances: currentPlan?.atomInstances ?? 0 }),
    dispose() { if (disposed) return; try { clear(); } finally { disposed = true; } },
  };
}
