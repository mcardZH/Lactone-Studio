import { parseTwoDStereoLabel } from '../../modeling/two-d/stereo-groups';
import { toolError } from './types';

export interface SketchStereoAtomRef { nodeId:string; atomIndex:number }
export interface SketchStereoGroup { type:'ABS'|'AND'|'OR'; id?:number }

function moleculeAtoms(ket:string){
  const document=JSON.parse(ket) as Record<string,unknown>;
  const root=document.root as {nodes?:{$ref?:string}[]}|undefined;
  if(!root||!Array.isArray(root.nodes))throw toolError('invalid-sketch-graph','二维草稿缺少 KET 根节点。');
  const nodes=root.nodes.flatMap(ref=>{
    const key=ref.$ref,node=(key?document[key]:undefined) as {type?:string;atoms?:Record<string,unknown>[]} | undefined;
    return key&&node?.type==='molecule'&&Array.isArray(node.atoms)?[{nodeId:key,atoms:node.atoms}]:[];
  });
  return {document,nodes};
}

export function sketchStereoGroups(ket:string){
  const {nodes}=moleculeAtoms(ket);
  return nodes.flatMap(node=>node.atoms.map((atom,atomIndex)=>({
    atomRef:{nodeId:node.nodeId,atomIndex},element:atom.label,
    group:parseTwoDStereoLabel(atom.stereoLabel)??null,
  })));
}

/** Patch only explicitly selected KET atom labels. The editor applies this
 * graph through its existing versioned, undoable replacement operation. */
export function patchSketchStereoGroup(ket:string,refs:SketchStereoAtomRef[],group:SketchStereoGroup){
  if(!refs.length)throw toolError('invalid-sketch-stereo','请指定要修改立体组的原子。');
  if(!['ABS','AND','OR'].includes(group.type)||group.type!=='ABS'&&(!Number.isSafeInteger(group.id)||group.id!<1)){
    throw toolError('invalid-sketch-stereo','AND 和 OR 立体组需要大于零的整数 id。');
  }
  const {document,nodes}=moleculeAtoms(ket),known=new Map(nodes.map(node=>[node.nodeId,node.atoms]));
  const label=group.type==='ABS'?'abs':`${group.type==='AND'?'&':'or'}${group.id}`;
  for(const ref of refs){
    const atoms=known.get(ref.nodeId);
    if(!Number.isSafeInteger(ref.atomIndex)||ref.atomIndex<0||!atoms?.[ref.atomIndex])throw toolError('sketch-atom-conflict','二维原子引用已失效，请重新读取。',{atomRef:ref});
    atoms[ref.atomIndex].stereoLabel=label;
  }
  return JSON.stringify(document);
}
