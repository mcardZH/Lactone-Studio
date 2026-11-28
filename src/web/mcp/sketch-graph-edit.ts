import { elementSymbol } from '../../core/elements';
import {
  addAtom, addBond, atomEdges, edgeBetween, graphToKet, mergeSimpleMoleculeNodes, nextNodeKey,
  readKetGraph, validateEditGraph, valenceWarnings, type EditGraph,
} from '../../modeling/two-d/editing-graph';
import { checkToolArguments } from './tool-arguments';
import { objectSchema, toolError } from './types';

const string = {type:'string',minLength:1};
const bondOrder = {type:'integer',enum:[1,2,3]};
const atomPair = {type:'array',items:string,minItems:2,maxItems:2,uniqueItems:true};
const shape = (type:string,fields:Record<string,unknown>,required=Object.keys(fields))=>
  objectSchema({type:{const:type},...fields},['type',...required]);
export const sketchGraphCommands = {
  type:'array',minItems:1,items:{oneOf:[
    shape('add-atom',{element:string,position:{type:'array',items:{type:'number'},minItems:2,maxItems:2},nodeId:string,key:string},['element','position']),
    shape('add-bond',{atomIds:atomPair,order:bondOrder}),
    shape('set-bond-order',{atomIds:atomPair,order:bondOrder}),
    shape('remove-bond',{atomIds:atomPair}),
    shape('remove-atom',{atomId:string}),
  ]},
  description:'One ordered native Undo step. Coordinates [x,y] are in KET drawing units. Use atomIds from the current sketch_read includeGraph=true result, or keys assigned by preceding add-atom commands in this batch. Reread IDs after any revision change.',
};

type AtomAddition = {type:'add-atom';element:string;position:[number,number];nodeId?:string;key?:string};
type BondChange = {type:'add-bond'|'set-bond-order';atomIds:[string,string];order:number};
type Command = AtomAddition | BondChange | {type:'remove-bond';atomIds:[string,string]} | {type:'remove-atom';atomId:string};

function ordinaryNode(graph:EditGraph,nodeId:string) {
  const node=graph.document[nodeId];
  return (!node||Object.keys(node).every(key=>['type','atoms','bonds'].includes(key)))&&
    graph.atoms.filter(atom=>atom.nodeKey===nodeId).every(atom=>
      Object.keys(atom.props).every(key=>['label','location','charge','isotope','implicitHCount','explicitValence'].includes(key)))&&
    graph.bonds.filter(bond=>bond.nodeKey===nodeId).every(bond=>
      [1,2,3].includes(bond.order)&&!bond.stereo&&Object.keys(bond.props).every(key=>['atoms','type','stereo'].includes(key)));
}

export function sketchGraphSummary(ket:string) {
  const graph=readKetGraph(ket);
  const nodeIds=[...new Set(graph.atoms.map(atom=>atom.nodeKey))];
  return {
    coordinateSpace:'KET',
    nodes:nodeIds.map(nodeId=>({nodeId,editable:ordinaryNode(graph,nodeId)})),
    atoms:graph.atoms.map(({id,nodeKey,label,x,y,charge})=>({atomId:id,nodeId:nodeKey,element:label,position:[x,y],charge})),
    bonds:graph.bonds.map(({id,nodeKey,begin,end,order,stereo})=>({bondId:id,nodeId:nodeKey,atomIds:[begin,end],order,stereo})),
    warnings:valenceWarnings(graph),
  };
}

export function patchSketchGraph(ket:string,value:unknown) {
  checkToolArguments(sketchGraphCommands,value,'arguments.commands');
  const graph=readKetGraph(ket);
  const commands=value as Command[];
  const names=new Set(graph.atoms.map(atom=>atom.id));
  const aliases=new Map<string,string>();
  const affected=new Set<string>();
  const originalNodes=new Set(graph.atoms.map(atom=>atom.nodeKey));
  const ensureEditable=(nodeId:string)=>{
    if(!ordinaryNode(graph,nodeId))throw toolError('sketch-node-protected','该分子含立体定义、查询或带索引的图纸属性，请在原生二维画板继续编辑。',{
      nodeId,committed:false,recovery:{tool:'sketch_read',arguments:{includeGraph:true}},requiresUser:true,
    });
  };
  const findAtom=(ref:string)=>{
    const id=aliases.get(ref)??(names.has(ref)?ref:undefined);
    const atom=graph.atoms.find(item=>item.id===id);
    if(!atom)throw toolError('sketch-atom-conflict','当前修订或本批操作中没有该原子。',{atomId:ref});
    ensureEditable(atom.nodeKey);
    return atom;
  };
  for(const command of commands){
    if(command.type==='add-atom'){
      const {key,nodeId,position:[x,y]}=command;
      if(key!==undefined&&(aliases.has(key)||names.has(key)))throw toolError('invalid-sketch-graph-edit','批内原子名重复或与现有身份重叠。',{key});
      if(nodeId!==undefined&&!graph.atoms.some(atom=>atom.nodeKey===nodeId))throw toolError('sketch-node-conflict','二维分子节点已变化，请重新读取。',{nodeId});
      if(nodeId!==undefined)ensureEditable(nodeId);
      const added=addAtom(graph,nodeId??nextNodeKey(graph),elementSymbol(command.element),{x,y});
      if(key!==undefined)aliases.set(key,added.id);
      affected.add(added.id);
      continue;
    }
    if(command.type==='remove-atom'){
      const atom=findAtom(command.atomId);
      for(const bond of atomEdges(graph,atom.id))affected.add(bond.begin===atom.id?bond.end:bond.begin);
      graph.atoms=graph.atoms.filter(item=>item.id!==atom.id);
      graph.bonds=graph.bonds.filter(item=>item.begin!==atom.id&&item.end!==atom.id);
      // Keep a deleted batch alias from resolving to an atom added later.
      for(const [key,id] of aliases)if(id===atom.id)aliases.set(key,'');
      continue;
    }
    const [a,b]=command.atomIds.map(findAtom);
    if(a===b)throw toolError('invalid-sketch-graph-edit','化学键需要两个不同原子。');
    const bond=edgeBetween(graph,a.id,b.id);
    affected.add(a.id);
    affected.add(b.id);
    if(command.type==='add-bond'){
      if(bond)throw toolError('sketch-bond-exists','两个原子已经成键，可用 set-bond-order 调整。');
      const problem=mergeSimpleMoleculeNodes(graph,a.nodeKey,b.nodeKey);
      if(problem)throw toolError('sketch-node-protected',problem);
      addBond(graph,a,b,command.order);
    }else{
      if(!bond)throw toolError('sketch-bond-conflict','两个原子之间没有可编辑的键，请重新读取。');
      if(command.type==='set-bond-order')bond.order=command.order;
      else graph.bonds=graph.bonds.filter(item=>item!==bond);
    }
  }
  const emptyNodes=[...originalNodes].filter(nodeId=>!graph.atoms.some(atom=>atom.nodeKey===nodeId));
  graph.mergedNodeKeys=[...new Set([...(graph.mergedNodeKeys??[]),...emptyNodes])];
  const problem=validateEditGraph(graph,affected,{allowHypervalence:true});
  if(problem)throw toolError('invalid-sketch-graph-edit',problem);
  return graphToKet(graph);
}
