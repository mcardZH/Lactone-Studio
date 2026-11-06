import { atomEdges, cloneGraph, opposite, type EditGraph } from './editing-graph';

/** Edges in actual cycles; bridges to substituents cannot become conjugated
 * merely because both endpoint atoms happen to have a double bond. */
export function cyclicBondIds(graph:EditGraph):Set<string> {
  const adjacency=new Map(graph.atoms.map(a=>[a.id,atomEdges(graph,a.id)]));
  const time=new Map<string,number>(),low=new Map<string,number>(),bridges=new Set<string>();let clock=0;
  const visit=(id:string,parent?:string)=>{time.set(id,++clock);low.set(id,clock);
    for(const edge of adjacency.get(id)??[]){if(edge.id===parent)continue;const next=opposite(edge,id);
      if(!time.has(next)){visit(next,edge.id);low.set(id,Math.min(low.get(id)!,low.get(next)!));if(low.get(next)!>time.get(id)!)bridges.add(edge.id);}
      else low.set(id,Math.min(low.get(id)!,time.get(next)!));
    }};
  for(const atom of graph.atoms)if(!time.has(atom.id))visit(atom.id);
  return new Set(graph.bonds.filter(b=>!bridges.has(b.id)).map(b=>b.id));
}

/** Edmonds' augmenting-path matching for a general graph (odd fused rings are
 * allowed). This solves the entire selected pi graph, not each ring separately. */
function perfectMatching(adjacency:number[][]):number[]|null {
  const n=adjacency.length,match=Array<number>(n).fill(-1),p=Array<number>(n),base=Array<number>(n);
  let used:boolean[],blossom:boolean[];
  const lca=(aa:number,bb:number)=>{const path=Array<boolean>(n).fill(false);let a=aa,b=bb;
    while(true){a=base[a];path[a]=true;if(match[a]===-1)break;a=p[match[a]];}
    while(true){b=base[b];if(path[b])return b;b=p[match[b]];}
  };
  const mark=(vv:number,b:number,child:number)=>{let v=vv;while(base[v]!==b){blossom[base[v]]=blossom[base[match[v]]]=true;p[v]=child;child=match[v];v=p[match[v]];}};
  const find=(root:number)=>{used=Array<boolean>(n).fill(false);p.fill(-1);for(let i=0;i<n;i++)base[i]=i;
    const queue=[root];used[root]=true;
    for(let head=0;head<queue.length;head++){const v=queue[head];for(const u of adjacency[v]){
      if(base[v]===base[u]||match[v]===u)continue;
      if(u===root||match[u]!==-1&&p[match[u]]!==-1){const b=lca(v,u);blossom=Array<boolean>(n).fill(false);mark(v,b,u);mark(u,b,v);
        for(let i=0;i<n;i++)if(blossom[base[i]]){base[i]=b;if(!used[i]){used[i]=true;queue.push(i);}}
      }else if(p[u]===-1){p[u]=v;if(match[u]===-1)return u;const next=match[u];used[next]=true;queue.push(next);}
    }}return -1;
  };
  for(let i=0;i<n;i++)if(match[i]===-1){let v=find(i);if(v===-1)continue;while(v!==-1){const pv=p[v],next=pv===-1?-1:match[pv];match[v]=pv;if(pv!==-1)match[pv]=v;v=next;}}
  return match.every(v=>v!==-1)?match:null;
}

export type KekuleResult={ok:true;graph:EditGraph;affectedAtomIds:string[]}|{ok:false;reason:string};
/** seed atoms identify only this edit's conjugated neighbourhood. Aromatic KET
 * bonds can be converted without a new ring by seeding their endpoints. Source
 * properties/document are retained; no source H, charge or stereo is edited. */
export function assignKekule(input:EditGraph, seeds:Iterable<string>, additionalPi:Iterable<string>=[]):KekuleResult {
  const graph=cloneGraph(input),cyclic=cyclicBondIds(graph),pi=new Set(additionalPi);
  for(const edge of graph.bonds)if(cyclic.has(edge.id)&&[2,4].includes(edge.order)){pi.add(edge.begin);pi.add(edge.end);}
  const potential=graph.bonds.filter(b=>cyclic.has(b.id)&&pi.has(b.begin)&&pi.has(b.end));
  const chosen=new Set<string>(),todo=[...seeds].filter(id=>pi.has(id));
  while(todo.length){const id=todo.pop()!;if(chosen.has(id))continue;chosen.add(id);for(const edge of potential)if(edge.begin===id||edge.end===id)todo.push(opposite(edge,id));}
  if(!chosen.size)return {ok:true,graph,affectedAtomIds:[]};
  const variable=potential.filter(b=>chosen.has(b.begin)&&chosen.has(b.end)),variableIds=new Set(variable.map(b=>b.id));
  if(variable.some(b=>![1,2,4].includes(b.order)||b.stereo||b.props.topology||b.props.queryProperties||b.props.customQuery||b.props.cip))return {ok:false,reason:'受影响共轭图含查询或立体限定键，不能无损重分配单双键。'};
  const required:string[]=[];
  for(const id of chosen){
    const atom=graph.atoms.find(a=>a.id===id)!;
    if(atom.props.radical||atom.props.queryProperties||atom.props.atomList||atom.props.rglabel)return {ok:false,reason:'共轭图含未明确原子，无法给出可验证Kekulé分配。'};
    const edges=atomEdges(graph,id),outside=edges.filter(b=>!variableIds.has(b.id));
    if(outside.some(b=>![1,2,3].includes(b.order)))return {ok:false,reason:'共轭图的外接键尚未明确，原图已保留。'};
    const h=atom.props.implicitHCount??0;
    if(!Number.isSafeInteger(h)||h<0)return {ok:false,reason:'共轭原子的显式氢计数无效。'};
    // Neutral aromatic carbon / pyridine-like N need one pi bond; pyrrolic
    // [NH], O and S supply a pair. Unspecified exotic valence stays restricted.
    let target:number;
    if(atom.label==='C'&&atom.charge===0)target=1;
    else if(atom.label==='N'&&atom.charge===0)target=(h+outside.reduce((n,b)=>n+b.order,0))>0?0:1;
    else if(atom.label==='N'&&atom.charge===1)target=1;
    else if(['O','S'].includes(atom.label)&&atom.charge===0)target=0;
    else return {ok:false,reason:`${atom.label}(${atom.charge})的共轭价态不在可保真分配范围；保留原义。`};
    const externalPi=outside.reduce((n,b)=>n+Math.max(0,b.order-1),0);target-=externalPi;
    if(target<0||target>1)return {ok:false,reason:'共轭原子已有外接多重键，无法保留合法价态。'};
    if(target===1)required.push(id);
  }
  if(required.length%2)return {ok:false,reason:'受影响共轭图不存在完整的合法Kekulé配对。'};
  const index=new Map(required.map((id,i)=>[id,i]));
  const adjacency=required.map(()=>[] as number[]);
  // Keep existing doubles preferred where compatible; matching can reroute
  // across any affected ring if shared-edge fusion requires it.
  for(const edge of [...variable].sort((a,b)=>(b.order===2?1:0)-(a.order===2?1:0))){const a=index.get(edge.begin),b=index.get(edge.end);if(a!==undefined&&b!==undefined){adjacency[a].push(b);adjacency[b].push(a);}}
  const match=perfectMatching(adjacency);
  if(!match)return {ok:false,reason:'受影响共轭图不存在合法Kekulé单双键分配；原图已保留。'};
  for(const edge of variable){const a=index.get(edge.begin),b=index.get(edge.end);edge.order=a!==undefined&&b!==undefined&&match[a]===b?2:1;}
  return {ok:true,graph,affectedAtomIds:[...chosen]};
}

export function convertReliableAromaticGraph(graph:EditGraph):KekuleResult {
  const aromatic=graph.bonds.filter(b=>b.order===4);
  const cyclic=cyclicBondIds(graph);
  if(aromatic.some(b=>!cyclic.has(b.id)))return {ok:false,reason:'芳香键不属于完整环，无法可靠转换；原始键义保留。'};
  return assignKekule(graph,aromatic.flatMap(b=>[b.begin,b.end]));
}
