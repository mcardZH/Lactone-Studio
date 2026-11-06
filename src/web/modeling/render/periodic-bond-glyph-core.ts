import type { Atom, Bond, Structure, Vector3, PeriodicCell } from '../../../core/types';
import { fractionalToCartesian } from '../../../core/periodic';
import { add, cellPathSections, coordinates } from './geometry';

export interface NativeBondPrimitive {kind:'cylinder'|'line';start:{x:number;y:number;z:number};end:{x:number;y:number;z:number};radius:number;color:number;fromCap:number;toCap:number}
export interface BondGlyphPrimitive extends Omit<NativeBondPrimitive,'start'|'end'> {start:Vector3;end:Vector3;cellClip?:{start:Vector3;end:Vector3;cell:PeriodicCell}}
const ZERO:Vector3=[0,0,0];
export const periodicGlyphRequired=(structure:Structure,bond:Bond):boolean=>!!structure.cell?.pbc.some(Boolean)&&bond.orderKnown!==false&&bond.kind!=='coordination'&&(bond.order>1||!!bond.aromatic);
const nativeOrder=(bond:Bond)=>!bond.fractional&&(bond.aromatic||bond.order===1.5||bond.order===4)?4:bond.order;
const key=(index:number,image:Vector3)=>JSON.stringify([index,image]);

/** Real lattice endpoint identities only. Four hops from both target ends
 * contain every physical ring of <=8 members used by locked 3Dmol, plus the
 * immediate neighbours used to choose the multi-bond direction. Winding
 * cycles never become invented molecular rings by collapsing base IDs. */
export function periodicBondGlyphTopology(structure:Structure) {
  const adjacency=structure.atoms.map(()=>[] as {index:number;image:Vector3;order:number}[]);
  for(const edge of structure.bonds??[]){
    if(edge.orderKnown===false||edge.kind==='coordination'||edge.order===.5)continue;
    if(!adjacency[edge.a]||!adjacency[edge.b])throw new Error('周期键glyph原子身份无效。');
    const image=edge.image??ZERO;
    adjacency[edge.a].push({index:edge.b,image,order:nativeOrder(edge)});
    adjacency[edge.b].push({index:edge.a,image:image.map(n=>-n) as Vector3,order:nativeOrder(edge)});
  }
  return adjacency;
}
export function periodicBondGlyphContext(structure:Structure,bond:Bond,positions:readonly Atom[]=structure.atoms,adjacency=periodicBondGlyphTopology(structure)) {
  const cell=structure.cell;if(!cell)throw new Error('周期键glyph需要真实晶胞。');
  const endpoints:{index:number;image:Vector3;depth:number}[]=[],indices=new Map<string,number>();
  const addEndpoint=(index:number,image:Vector3,depth:number)=>{const identity=key(index,image);if(indices.has(identity))return indices.get(identity)!;
    if(!positions[index]?.id||image.some((n,axis)=>!Number.isSafeInteger(n)||n!==0&&!cell.pbc[axis]))throw new Error('周期键glyph需要真实atomId-image端点。');
    const result=endpoints.length;indices.set(identity,result);endpoints.push({index,image:[...image],depth});return result;};
  // Native glyph direction/dash phase uses index order. Preserve the real
  // source endpoint order even when a stored bond is oriented b -> a.
  let first:number,second:number;
  if(bond.a<=bond.b){first=addEndpoint(bond.a,ZERO,0);second=addEndpoint(bond.b,bond.image??ZERO,0);}
  else{second=addEndpoint(bond.b,bond.image??ZERO,0);first=addEndpoint(bond.a,ZERO,0);}
  if(first===second)throw new Error('周期键glyph端点重复。');
  for(let cursor=0;cursor<endpoints.length;cursor++){const endpoint=endpoints[cursor];if(endpoint.depth>=4)continue;
    for(const neighbour of adjacency[endpoint.index])addEndpoint(neighbour.index,add(endpoint.image,neighbour.image),endpoint.depth+1);
  }
  let edges=0;
  const atoms=endpoints.map(endpoint=>{
    const position=add(coordinates(positions[endpoint.index]),fractionalToCartesian(cell,endpoint.image,false)),bonds:number[]=[],bondOrder:number[]=[];
    for(const neighbour of adjacency[endpoint.index]){const other=indices.get(key(neighbour.index,add(endpoint.image,neighbour.image)));if(other===undefined)continue;
      if(!Number.isSafeInteger(++edges))throw new Error('周期键glyph连接数超出可精确表示范围。');bonds.push(other);bondOrder.push(neighbour.order);}
    return {index:indices.get(key(endpoint.index,endpoint.image))!,elem:positions[endpoint.index].element,x:position[0],y:position[1],z:position[2],bonds,bondOrder,
      // Provenance is renderer-only, never part of a Structure or selection.
      sourceAtomId:positions[endpoint.index].id!,sourceImage:[...endpoint.image] as Vector3,sourceIndex:endpoint.index};
  });
  return {atoms,target:[first,second] as [number,number]};
}

/** One detached, CPU-only native glyph sampler per adapter. It creates no GL
 * objects, labels, pick targets, atom counts or scientific model mutations. */
export function createPeriodicBondGlyphCore(mol:any) {
  let model:any=null,disposed=false;
  return {
    export(structure:Structure,bond:Bond,positions:readonly Atom[],styles:readonly any[],representation:'stick'|'line'='stick',prepared?:ReturnType<typeof periodicBondGlyphContext>,unclipped=false):BondGlyphPrimitive[]{
      if(disposed)throw new Error('周期键glyph导出器已关闭。');
      const glyphCell={...structure.cell!,pbc:structure.cell!.pbc.map((enabled,axis)=>enabled&&!!bond.image?.[axis]) as [boolean,boolean,boolean]};
      const physicalStart=coordinates(positions[bond.a]),physicalEnd=add(coordinates(positions[bond.b]),fractionalToCartesian(structure.cell!,bond.image??ZERO,false));
      // Reject excessive images before native aromatic dash generation or
      // neighbourhood enumeration, not after consuming unbounded resources.
      cellPathSections(physicalStart,physicalEnd,glyphCell);
      if(nativeOrder(bond)%1!==0||nativeOrder(bond)===4){
        const style=styles[bond.a]?.stick,dash=style?.dashedBondConfig?.dashLength||.1,gap=style?.dashedBondConfig?.gapLength||.25;
        if(!Number.isFinite(dash+gap)||dash+gap<=0||!Number.isSafeInteger(4*(1+Math.ceil(Math.hypot(...physicalEnd.map((n,i)=>n-physicalStart[i]))/(dash+gap)))))throw new Error('周期芳香/分数键显示段数超出可精确表示范围。');
      }
      if(!model){if(typeof mol.GLModel!=='function'||typeof mol.GLModel.prototype?.exportBondPrimitives!=='function')throw new Error('缺少锁定3Dmol周期键glyph公共接口；请先运行runtime assets准备，未回退为单杆。');model=new mol.GLModel(-1);}
      const context=prepared?{target:prepared.target,atoms:prepared.atoms.map(atom=>{const p=add(coordinates(positions[atom.sourceIndex]),fractionalToCartesian(structure.cell!,atom.sourceImage,false));return{...atom,x:p[0],y:p[1],z:p[2]};})}:periodicBondGlyphContext(structure,bond,positions);
      model.removeAtoms(model.selectedAtoms({}));model.addAtoms(context.atoms);
      for(const atom of context.atoms){const style=styles[atom.sourceIndex]?.[representation];if(!style)throw new Error('周期键glyph缺少公共显示样式。');model.setStyle({index:atom.index},{[representation]:{...style}});}
      const result=model.exportBondPrimitives(...context.target,representation);
      if(result?.schema!==1||!Array.isArray(result.primitives))throw new Error('周期键glyph接口版本无效。');
      const output:BondGlyphPrimitive[]=[];
      // Clip the physical relation's crossed cell faces. A glyph offset or
      // sphere radius is allowed to protrude past an untouched face, just as
      // for ordinary atoms/sticks lying on that face. Clipping all axes would
      // wrongly erase one stroke of a double bond on (say) the z=0 face.
      const seen=new Set<string>();
      for(const primitive of result.primitives as NativeBondPrimitive[]){
        if(!['line','cylinder'].includes(primitive.kind)||![primitive.start.x,primitive.start.y,primitive.start.z,primitive.end.x,primitive.end.y,primitive.end.z,primitive.radius,primitive.color].every(Number.isFinite))throw new Error('周期键glyph包含无效绘制段。');
        if(unclipped){output.push({...primitive,start:[primitive.start.x,primitive.start.y,primitive.start.z],end:[primitive.end.x,primitive.end.y,primitive.end.z]});continue;}
        for(const section of cellPathSections([primitive.start.x,primitive.start.y,primitive.start.z],[primitive.end.x,primitive.end.y,primitive.end.z],glyphCell)){
          const translation=fractionalToCartesian(glyphCell,section.shift,false),cut=section.t0>1e-9||section.t1<1-1e-9;
          const row={...primitive,start:section.start,end:section.end,fromCap:section.t0>1e-9?0:primitive.fromCap,toCap:section.t1<1-1e-9?0:primitive.toCap,...(cut?{cellClip:{start:add([primitive.start.x,primitive.start.y,primitive.start.z],translation),end:add([primitive.end.x,primitive.end.y,primitive.end.z],translation),cell:glyphCell}}:{})};
          const identity=JSON.stringify([row.kind,row.start.map(n=>Math.round(n*1e10)),row.end.map(n=>Math.round(n*1e10)),row.radius,row.color]);if(!seen.has(identity)){seen.add(identity);output.push(row);}
        }
      }
      return output;
    },
    dispose(){if(disposed)return;disposed=true;if(model){model.removeAtoms(model.selectedAtoms({}));model=null;}},
  };
}
