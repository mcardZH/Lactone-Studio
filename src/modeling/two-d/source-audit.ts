import { ELEMENTS } from '../../core/elements';
import type { TwoDDraft, TwoDIssue } from './types';
import { parseTwoDStereoLabel } from './stereo-groups';

interface SourceNode { id:string; type:number|string; element:number; charge:number; nested:boolean; fragmentKey:string; attrs:Record<string,string|number>; xy?:[number,number] }
interface SourceBond { id:string; begin:string; end:string; order:number; fragmentKey:string; wedge?:{center:string;sign:1|-1} }
interface SourceFacts { nodes:SourceNode[]; bonds:SourceBond[]; issues:TwoDIssue[]; wedges:number; doubles:number; complete:boolean }
const issue=(code:string,message:string):TwoDIssue=>({code,message,severity:'blocking'});
/** Shared by source correspondence and explicit editor-resolution admission. */
export const TWO_D_SOURCE_LOCAL_CODES:Readonly<Record<string,readonly string[]>>={
  'source-isotope':['isotope'],'source-radical':['radical'],'source-enhanced-stereo':['enhanced-stereo'],
  'source-query-node':['query-atom','unknown-element','attachment'],'source-query-property':['query-atom','query-atom-constraint'],
  'source-special-bond':['query-bond','unsupported-bond'],'source-uncertain-bond':['unspecified-stereo'],
  'source-relative-stereo':['enhanced-stereo'],
};

function checkNode(node:SourceNode,issues:TwoDIssue[]) {
  const a=node.attrs,start=issues.length;
  if(a.Isotope && Number(a.Isotope)) issues.push(issue('source-isotope','原文件含同位素质量数；当前三维公共模型不支持。'));
  if(a.Radical && !['0','None'].includes(String(a.Radical))) issues.push(issue('source-radical','原文件含自由基标记；当前三维公共模型不支持。'));
  if(a.EnhancedStereoType && !['0','1','2','3','4','Absolute','None','Unspecified','Or','And'].includes(String(a.EnhancedStereoType))) issues.push(issue('source-enhanced-stereo','原文件含未识别的增强立体类型。'));
  const normal=['0','1','4','5','Unspecified','Element','Fragment','Nickname'];
  // External connection nodes inside an expanded fragment are linkage markers, not physical atoms.
  if(!normal.includes(String(node.type)) && !(node.nested&&['12','ExternalConnectionPoint'].includes(String(node.type)))) issues.push(issue('source-query-node',`原文件节点类型 ${String(node.type)} 尚未具体化。`));
  for(const key of ['ElementList','Formula','GenericList','FreeSites','RingBondCount','UnsaturatedBonds','SubstituentsExactly','SubstituentsUpTo']) if(a[key]!==undefined) issues.push(issue('source-query-property',`原文件含 ${key} 查询/可变结构约束。`));
  for(const added of issues.slice(start))added.sourceFragmentKey=node.fragmentKey;
}

/** Only node/bond/fragment attributes are read; text content never becomes chemical metadata. */
export function readCdxmlFacts(input:string):SourceFacts {
  const result:SourceFacts={nodes:[],bonds:[],issues:[],wedges:0,doubles:0,complete:true};
  let nodeDepth=0;const nodeStack:SourceNode[]=[],fragments:string[]=[];
  for(const token of input.matchAll(/<\/?(?:n|b|fragment)\b[^>]*>/g)) {
    const tag=token[0],closing=tag.startsWith('</'),selfClosing=/\/\s*>$/.test(tag),name=/^<\/?(\w+)/.exec(tag)![1];
    if(closing){if(name==='n'){if(!nodeDepth)throw new Error('CDXML节点闭合不平衡。');nodeDepth--;nodeStack.pop();}if(name==='fragment')fragments.pop();continue;}
    const attrs:Record<string,string>={}; for(const match of tag.matchAll(/([\w]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[match[1]]=match[2]??match[3];
    if(name==='n'){
      const p=attrs.p?.trim().split(/\s+/).map(Number);
      const node:SourceNode={id:attrs.id??'',type:attrs.NodeType??'Element',element:Number(attrs.Element??6),charge:Number(attrs.Charge??0),nested:nodeDepth>0,fragmentKey:fragments[0]??'document',attrs,
        ...(p?.length===2&&p.every(Number.isFinite)?{xy:[p[0],-p[1]] as [number,number]}:{})};
      checkNode(node,result.issues); result.nodes.push(node);if(!selfClosing){nodeDepth++;nodeStack.push(node);}
    }
    if(name==='fragment'){if(nodeStack.length)nodeStack.at(-1)!.attrs.HasNestedFragment=1;if(!selfClosing)fragments.push(attrs.id??`fragment-${token.index}`);}
    if(name==='b'){
      const display=attrs.Display??'',wedge=/^(?:Wedge|WedgedHash)(?:Begin|End)$/.test(display)?{center:/End$/.test(display)?attrs.E:attrs.B,sign:(display.startsWith('WedgedHash')?-1:1) as 1|-1}:undefined;
      if(attrs.B&&attrs.E)result.bonds.push({id:attrs.id??'',begin:attrs.B,end:attrs.E,order:Number(attrs.Order??1),fragmentKey:fragments[0]??'document',...(wedge?{wedge}:{})});
      if(attrs.Order && !['1','2','3','1.5'].includes(attrs.Order))result.issues.push({...issue('source-special-bond',`原文件含特殊/查询键级 ${attrs.Order}。`),sourceFragmentKey:fragments[0]??'document'});
      if(attrs.Order==='2')result.doubles++;
      if(/^(?:WedgeBegin|WedgeEnd|WedgedHashBegin|WedgedHashEnd)$/.test(attrs.Display??''))result.wedges++;
      if(/Wavy/.test(attrs.Display??''))result.issues.push({...issue('source-uncertain-bond','原文件含波浪键或未确定构型。'),sourceFragmentKey:fragments[0]??'document'});
    }
  }
  if(nodeDepth!==0 || !/<\/CDXML\s*>/i.test(input))throw new Error('CDXML文档被截断或节点不平衡。');
  return result;
}

/** CDX little-endian tagged object/property tree.
 * https://chemapps.stolaf.edu/iupac/cdx/sdk/IntroCDX.htm
 * The published SDK says 28 bytes; current ChemDraw files and Indigo 1.46
 * CDXCommons.h use 10 reserved bytes and the document object starts at byte 22.
 * Both are recognized by the first object tag, rather than scanning arbitrary payload bytes.
 * Property IDs verified against Indigo 1.46.0 CDXConstants.h, not converted output.
 */
export function readCdxFacts(input:Uint8Array):SourceFacts {
  if(input.length<30 || new TextDecoder().decode(input.subarray(0,8))!=='VjCD0100')throw new Error('CDX文件头不完整。');
  const result:SourceFacts={nodes:[],bonds:[],issues:[],wedges:0,doubles:0,complete:true}, view=new DataView(input.buffer,input.byteOffset,input.byteLength);
  const at22=view.getUint16(22,true),at28=input.length>=30?view.getUint16(28,true):0;
  const start=at22===0x8000?22:at28===0x8000?28:-1;
  if(start<0)throw new Error('CDX文档对象入口无效。');
  const stack:{type:number;id:number;node?:SourceNode;bond?:SourceBond;bondDisplay?:number}[]=[];let pos=start,objects=0,ended=false;
  const need=(n:number)=>{if(pos+n>input.length)throw new Error('CDX属性或对象被截断。');};
  while(pos<input.length){
    need(2);const tag=view.getUint16(pos,true);pos+=2;
    if(tag===0){if(stack.length){const frame=stack.pop()!;if(frame.node)checkNode(frame.node,result.issues);if(frame.bond){
      const display=frame.bondDisplay;if(display!==undefined&&[3,4,6,7].includes(display))frame.bond.wedge={center:[4,7].includes(display)?frame.bond.end:frame.bond.begin,sign:display<=4?-1:1};
      result.bonds.push(frame.bond);
    }}else{ended=true;break;}continue;}
    if(tag&0x8000){need(4);const id=view.getUint32(pos,true);pos+=4;if(++objects>100000||stack.length>256)throw new Error('CDX对象数量或嵌套超过读取限制。');
      const node=tag===0x8004?{id:String(id),type:1,element:6,charge:0,nested:stack.some(parent=>!!parent.node),fragmentKey:String(stack.find(parent=>parent.type===0x8003)?.id??'document'),attrs:{}} as SourceNode:undefined;
      if(tag===0x8003&&stack.at(-1)?.node)stack.at(-1)!.node!.attrs.HasNestedFragment=1;
      const bond=tag===0x8005?{id:String(id),begin:'',end:'',order:1,fragmentKey:String(stack.find(parent=>parent.type===0x8003)?.id??'document')}:undefined;
      if(node)result.nodes.push(node);stack.push({type:tag,id,node,bond});continue;
    }
    need(2);let length=view.getUint16(pos,true);pos+=2;if(length===0xffff){need(4);length=view.getUint32(pos,true);pos+=4;}need(length);
    const frame=stack.at(-1),node=frame?.node;
    const uint=()=>length===1?view.getUint8(pos):length===2?view.getUint16(pos,true):length===4?view.getUint32(pos,true):0;
    if(node){
      // CDXPoint2D is signed fixed point, vertical first; use Cartesian Y like KET.
      if(tag===0x0200&&length===8)node.xy=[view.getInt32(pos+4,true)/65536,-view.getInt32(pos,true)/65536];
      if(tag===0x0400)node.type=uint();if(tag===0x0402)node.element=uint();if(tag===0x0421)node.charge=length===1?view.getInt8(pos):length===2?view.getInt16(pos,true):0;
      const fields:Record<number,string>={0x0403:'ElementList',0x0404:'Formula',0x0420:'Isotope',0x0422:'Radical',0x0423:'FreeSites',0x0425:'RingBondCount',0x0426:'UnsaturatedBonds',0x0441:'GenericList',0x0446:'EnhancedStereoType',0x0447:'EnhancedStereoGroupNum'};
      if(fields[tag])node.attrs[fields[tag]]=uint();
    }
    const fragmentKey=String(stack.find(parent=>parent.type===0x8003)?.id??'document');
    if(frame?.bond){if(tag===0x0604)frame.bond.begin=String(uint());if(tag===0x0605)frame.bond.end=String(uint());if(tag===0x0600){const raw=uint();frame.bond.order=raw===4?3:raw===0x80?1.5:raw;}
      if(tag===0x0601)frame.bondDisplay=uint();}
    if(frame?.type===0x8005&&tag===0x0600){const order=uint();if(order===2)result.doubles++;if(![1,2,4,0x80].includes(order))result.issues.push({...issue('source-special-bond','CDX含特殊、查询或未确定键级。'),sourceFragmentKey:fragmentKey});}
    if(frame?.type===0x8005&&tag===0x0601){const display=uint();if([3,4,6,7].includes(display))result.wedges++;if([8,9,10,11,12].includes(display))result.issues.push({...issue('source-uncertain-bond','CDX含波浪键或尚未适配的立体显示。'),sourceFragmentKey:fragmentKey});}
    if([0x0500,0x0502].includes(tag)&&(!length||uint()))result.issues.push({...issue('source-relative-stereo','CDX原稿声明外消旋或相对立体关系。'),sourceFragmentKey:fragmentKey});
    pos+=length;
  }
  // Some writers use the document closing tag as the final pair, without another EndObject.
  if(stack.length||(!ended&&pos!==input.length))throw new Error('CDX对象树不完整。');
  if(!objects)throw new Error('CDX文件中没有完整对象。');
  return result;
}

interface StereoAuditGraph {
  atoms:{key:string;element:string;charge:number;xy?:[number,number]}[];
  bonds:{a:number;b:number;order:number;center?:number;sign?:1|-1}[];
  relativeGroups?:number[][];
}
interface PreparedStereoGraph {
  adjacency:Map<number,StereoAuditGraph['bonds'][number]>[];
  labels:string[];bucket:string;centers:number[];
}
const preparedStereoGraphs=new WeakMap<StereoAuditGraph,PreparedStereoGraph>();
const stereoMappings=new WeakMap<StereoAuditGraph,WeakMap<StereoAuditGraph,(number|undefined)[]|null>>();
function prepareStereoGraph(graph:StereoAuditGraph):PreparedStereoGraph {
  const existing=preparedStereoGraphs.get(graph);if(existing)return existing;
  const adjacency=graph.atoms.map(()=>new Map<number,StereoAuditGraph['bonds'][number]>()),centers=new Set<number>();
  for(const bond of graph.bonds){adjacency[bond.a].set(bond.b,bond);adjacency[bond.b].set(bond.a,bond);if(bond.center!==undefined)centers.add(bond.center);}
  const labels=graph.atoms.map(atom=>JSON.stringify([atom.element,atom.charge]));
  const counts=new Map<string,number>();for(const [index,label]of labels.entries()){const key=JSON.stringify([label,adjacency[index].size]);counts.set(key,(counts.get(key)??0)+1);}
  const orders=new Map<number,number>();for(const bond of graph.bonds)orders.set(bond.order,(orders.get(bond.order)??0)+1);
  const bucket=JSON.stringify([graph.atoms.length,graph.bonds.length,[...counts].sort(([a],[b])=>a.localeCompare(b)),[...orders].sort(([a],[b])=>a-b)]);
  const result={adjacency,labels,bucket,centers:[...centers]};preparedStereoGraphs.set(graph,result);return result;
}
/** Compare only independently mappable source facts. Colour ties stay unknown;
 * no row-order mapping, CIP guess or requirement for extra source metadata. */
function sourceStereoMapping(source:StereoAuditGraph,target:StereoAuditGraph):(number|undefined)[]|undefined {
  let cached=stereoMappings.get(source);if(!cached){cached=new WeakMap();stereoMappings.set(source,cached);}
  if(cached.has(target))return cached.get(target)??undefined;
  const a=prepareStereoGraph(source),b=prepareStereoGraph(target);if(a.bucket!==b.bucket){cached.set(target,null);return;}
  const n=source.atoms.length,edges=[...a.adjacency,...b.adjacency];
  let colors=[...a.labels,...b.labels],count=new Set(colors).size;
  for(let round=0;round<colors.length;round++){
    const keys=colors.map((color,index)=>JSON.stringify([color,[...edges[index]].map(([other,bond])=>JSON.stringify([bond.order,colors[(index<n?0:n)+other]])).sort()]));
    const dictionary=new Map<string,string>();for(const key of keys)if(!dictionary.has(key))dictionary.set(key,String(dictionary.size));
    colors=keys.map(key=>dictionary.get(key)!);if(dictionary.size===count)break;count=dictionary.size;
  }
  const left=colors.slice(0,n),right=colors.slice(n);
  const targetColors=new Map<string,number[]>(),balance=new Map<string,number>();
  for(const [index,color]of right.entries()){const rows=targetColors.get(color)??[];rows.push(index);targetColors.set(color,rows);balance.set(color,(balance.get(color)??0)-1);}
  for(const color of left)balance.set(color,(balance.get(color)??0)+1);
  if([...balance.values()].some(Boolean)){cached.set(target,null);return;}
  const mapping=left.map(color=>{const matches=targetColors.get(color)!;return matches.length===1?matches[0]:undefined;});cached.set(target,mapping);return mapping;
}
function sourceStereoParity(graph:StereoAuditGraph,center:number,neighbours:number[]):number {
    const origin=graph.atoms[center].xy;if(!origin||neighbours.some(index=>!graph.atoms[index].xy))return 0;
    const rows=neighbours.map(index=>{
      const xy=graph.atoms[index].xy!,bond=prepareStereoGraph(graph).adjacency[center].get(index);
      return[xy[0]-origin[0],xy[1]-origin[1],bond?.center===center?bond.sign??0:0];
    });
    // The unshown fourth ligand is at the centre's projected position. Four
    // explicit neighbours use their relative tetrahedron instead.
    const base=rows.length===4?rows.pop()!:[0,0,0];
    const [a,b,c]=rows.map(row=>row.map((value,index)=>value-base[index]));
    const volume=a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]);
    const scale=Math.max(...rows.map(row=>Math.hypot(row[0],row[1])),1e-12);
    return Math.abs(volume)>scale*scale*1e-8?Math.sign(volume):0;
}
function sourceStereoCorrespondence(source:StereoAuditGraph,target:StereoAuditGraph):'different-graph'|'compatible'|'changed' {
  const mapping=sourceStereoMapping(source,target);if(!mapping)return'different-graph';
  const prepared=prepareStereoGraph(source);
  const flips=new Map<number,boolean>();
  for(const center of prepared.centers){
    const neighbours=[...prepared.adjacency[center].keys()].sort((a,b)=>a-b);
    if(![3,4].includes(neighbours.length)||mapping[center]===undefined||neighbours.some(index=>mapping[index]===undefined))continue;
    const before=sourceStereoParity(source,center,neighbours);if(!before)continue;
    const after=sourceStereoParity(target,mapping[center]!,neighbours.map(index=>mapping[index]!));
    if(!after)return'changed';
    flips.set(center,after!==before);
  }
  for(const group of source.relativeGroups??[]){
    const defined=group.filter(index=>flips.has(index));
    if(defined.length&&defined.every(index=>flips.get(index)))for(const index of defined)flips.set(index,false);
  }
  if([...flips.values()].some(Boolean))return'changed';
  return'compatible';
}
function hasCompleteMatching(rows:readonly number[][]):boolean {
  const owner=new Map<number,number>();
  const assign=(row:number,seen:Set<number>):boolean=>{for(const column of rows[row]){if(seen.has(column))continue;seen.add(column);const prior=owner.get(column);if(prior===undefined||assign(prior,seen)){owner.set(column,row);return true;}}return false;};
  return rows.every((_,row)=>assign(row,new Set()));
}
function componentStereoGraph(component:TwoDDraft['components'][number]):StereoAuditGraph {
  const atoms=component.atoms.filter(atom=>!atom.sourceProperties.generatedFromImplicitH),indices=new Map(atoms.map((atom,index)=>[atom.id,index]));
  const relativeGroups=new Map<string,number[]>();
  atoms.forEach((atom,index)=>{const label=parseTwoDStereoLabel(atom.sourceProperties.stereoLabel);if(label&&label.type!=='ABS'){
    const key=`${label.type}:${label.id}`,members=relativeGroups.get(key)??[];members.push(index);relativeGroups.set(key,members);
  }});
  return{atoms:atoms.map(atom=>({key:atom.id,element:atom.element,charge:atom.formalCharge??0,xy:[atom.x,atom.y]})),
    relativeGroups:[...relativeGroups.values()],
    bonds:component.bonds.filter(bond=>indices.has(component.atoms[bond.a].id)&&indices.has(component.atoms[bond.b].id)).map(bond=>({a:indices.get(component.atoms[bond.a].id)!,b:indices.get(component.atoms[bond.b].id)!,order:bond.order,
      ...([1,6].includes(bond.stereo??0)?{center:indices.get(component.atoms[bond.a].id)!,sign:(bond.stereo===1?1:-1) as 1|-1}:{})}))};
}
/** A chemical stereo edit, not a diagram translation, rotation or arbitrary
 * distant graph change. The same correspondence validator is used both ways
 * so adding or removing a specified centre is an explicit edit too. */
export function hasExplicitTwoDStereoEdit(baseline:TwoDDraft['components'][number],current:TwoDDraft['components'][number]):boolean {
  const a=componentStereoGraph(baseline),b=componentStereoGraph(current);
  return sourceStereoCorrespondence(a,b)==='changed'||sourceStereoCorrespondence(b,a)==='changed';
}
interface SourceStereoAnalysis {sources:StereoAuditGraph[];targets:StereoAuditGraph[];candidates:number[][];targetOwners:number[]}
const sourceStereoAnalyses=new WeakMap<SourceFacts,WeakMap<TwoDDraft,SourceStereoAnalysis>>();
const sourceStereoSourceGraphs=new WeakMap<SourceFacts,StereoAuditGraph[]>();
function sourceStereoGraphs(facts:SourceFacts,draft:TwoDDraft,physical:SourceNode[]):SourceStereoAnalysis {
  let byDraft=sourceStereoAnalyses.get(facts);if(!byDraft){byDraft=new WeakMap();sourceStereoAnalyses.set(facts,byDraft);}
  const existing=byDraft.get(draft);if(existing)return existing;
  let sources=sourceStereoSourceGraphs.get(facts);
  if(!sources){
  const groups=new Map<string,SourceNode[]>();for(const node of physical){const rows=groups.get(node.fragmentKey)??[];rows.push(node);groups.set(node.fragmentKey,rows);}
  const bondGroups=new Map<string,SourceBond[]>();for(const bond of facts.bonds){const rows=bondGroups.get(bond.fragmentKey)??[];rows.push(bond);bondGroups.set(bond.fragmentKey,rows);}
  sources=[...groups.entries()].map(([fragmentKey,nodes])=>{
    const indices=new Map(nodes.map((node,index)=>[node.id,index]));
    const relativeGroups=new Map<string,number[]>();
    nodes.forEach((node,index)=>{if(['3','4','And','Or'].includes(String(node.attrs.EnhancedStereoType))){
      const key=JSON.stringify([node.attrs.EnhancedStereoType,node.attrs.EnhancedStereoGroupNum]);
      const members=relativeGroups.get(key)??[];members.push(index);relativeGroups.set(key,members);
    }});
    return{atoms:nodes.map(node=>({key:node.id,element:ELEMENTS[node.element-1]??`unknown:${node.element}`,charge:node.charge,xy:node.xy})),
      relativeGroups:[...relativeGroups.values()],
      bonds:(bondGroups.get(fragmentKey)??[]).filter(bond=>indices.has(bond.begin)&&indices.has(bond.end)).map(bond=>({a:indices.get(bond.begin)!,b:indices.get(bond.end)!,order:bond.order,
        ...(bond.wedge&&indices.has(bond.wedge.center)?{center:indices.get(bond.wedge.center)!,sign:bond.wedge.sign}:{})}))};
  });
  sourceStereoSourceGraphs.set(facts,sources);
  }
  const targets:StereoAuditGraph[]=draft.components.map(componentStereoGraph);
  const relevantBuckets=new Set(sources.filter(source=>prepareStereoGraph(source).centers.length).map(source=>prepareStereoGraph(source).bucket));
  const targetBuckets=new Map<string,number[]>();for(const [index,target]of targets.entries()){
    const bucket=prepareStereoGraph(target).bucket;if(!relevantBuckets.has(bucket))continue;
    const rows=targetBuckets.get(bucket)??[];rows.push(index);targetBuckets.set(bucket,rows);
  }
  const targetOwners=targets.map(()=>0),candidates=sources.map(source=>{
    const bucket=prepareStereoGraph(source).bucket;if(!relevantBuckets.has(bucket))return[];
    const rows=(targetBuckets.get(bucket)??[]).filter(index=>sourceStereoMapping(source,targets[index]));for(const index of rows)targetOwners[index]++;return rows;
  });
  const result={sources,targets,candidates,targetOwners};byDraft.set(draft,result);return result;
}
/** Repair an unambiguous converted diagram from independently retained source
 * facts. The returned KET must be parsed and audited again by the caller. */
export function restoreMappedSourceStereo(facts:SourceFacts,draft:TwoDDraft):{ket:string;repairedCenters:number}|undefined {
  if(!facts.bonds.some(bond=>bond.wedge))return;
  const physical=facts.nodes.filter(node=>!node.attrs.HasNestedFragment&&['0','1','Unspecified','Element'].includes(String(node.type)));
  const {sources,targets,candidates,targetOwners}=sourceStereoGraphs(facts,draft,physical);if(sources.length!==targets.length)return;
  let document:Record<string,any>|undefined,repairedCenters=0;
  for(const [sourceIndex,source]of sources.entries()){
    const prepared=prepareStereoGraph(source);if(!prepared.centers.length)continue;
    const matches=candidates[sourceIndex];if(matches.length!==1)continue;
    const targetIndex=matches[0];if(targetOwners[targetIndex]!==1)continue;
    if(sourceStereoCorrespondence(source,targets[targetIndex])==='compatible')continue;
    const mapping=sourceStereoMapping(source,targets[targetIndex])!,component=draft.components[targetIndex];
    let target=targets[targetIndex],ownsCopy=false;
    const originalIndices=new Map(component.atoms.map(atom=>{const match=atom.sourceAtomKey.match(/\/atom\/(\d+)$/);return[atom.id,match?Number(match[1]):undefined];}));
    const originalIndex=(index:number)=>originalIndices.get(target.atoms[index].key);
    let node:Record<string,any>|undefined,rawBonds:Map<string,any>|undefined;
    for(const center of prepared.centers){
      const neighbours=[...prepared.adjacency[center].keys()].sort((a,b)=>a-b);
      if(![3,4].includes(neighbours.length)||mapping[center]===undefined||neighbours.some(index=>mapping[index]===undefined))continue;
      const before=sourceStereoParity(source,center,neighbours),targetCenter=mapping[center]!,targetNeighbours=neighbours.map(index=>mapping[index]!);
      if(!before||sourceStereoParity(target,targetCenter,targetNeighbours)===before)continue;
      const sourceWedge=[...prepared.adjacency[center].values()].find(bond=>bond.center===center)!,other=sourceWedge.a===center?sourceWedge.b:sourceWedge.a,targetOther=mapping[other];if(targetOther===undefined)continue;
      if(!ownsCopy){target=structuredClone(target);ownsCopy=true;}
      const restored=target,incident=[...prepareStereoGraph(target).adjacency[targetCenter].values()];
      const previous=incident.map(bond=>({bond,center:bond.center,sign:bond.sign}));
      const rollback=()=>{for(const row of previous){row.bond.center=row.center;row.bond.sign=row.sign;}};
      for(const bond of incident)if(bond.center===targetCenter){delete bond.center;delete bond.sign;}
      const wedge=prepareStereoGraph(restored).adjacency[targetCenter].get(targetOther);if(!wedge)continue;
      wedge.center=targetCenter;wedge.sign=sourceWedge.sign;
      const after=sourceStereoParity(restored,targetCenter,targetNeighbours);if(!after){rollback();continue;}if(after!==before)wedge.sign=wedge.sign===1?-1:1;
      const rawCenter=originalIndex(targetCenter),rawOther=originalIndex(targetOther);if(rawCenter===undefined||rawOther===undefined){rollback();continue;}
      if(!document)document=JSON.parse(draft.ket);
      if(!node){node=document![component.sourceNodeKey];if(!Array.isArray(node?.bonds)){rollback();continue;}
        rawBonds=new Map(node!.bonds.map((bond:{atoms:number[]})=>[[...bond.atoms].sort((a,b)=>a-b).join(':'),bond]));
      }
      const rawBond=rawBonds!.get([rawCenter,rawOther].sort((a,b)=>a-b).join(':'));if(!rawBond){rollback();continue;}
      for(const other of prepareStereoGraph(target).adjacency[targetCenter].keys()){
        const rawNeighbour=originalIndex(other);if(rawNeighbour===undefined)continue;
        const bond=rawBonds!.get([rawCenter,rawNeighbour].sort((a,b)=>a-b).join(':'));if(bond?.atoms[0]===rawCenter&&[1,6].includes(bond.stereo))delete bond.stereo;
      }
      rawBond.atoms=[rawCenter,rawOther];rawBond.stereo=wedge.sign===1?1:6;
      repairedCenters++;
    }
  }
  if(repairedCenters)return{ket:JSON.stringify(document),repairedCenters};
}
function auditMappedSourceStereo(facts:SourceFacts,draft:TwoDDraft,physical:SourceNode[]):TwoDIssue[] {
  if(!facts.bonds.some(bond=>bond.wedge))return[];
  const {sources,targets,candidates}=sourceStereoGraphs(facts,draft,physical);if(sources.length!==targets.length)return[];
  // Unmarked solvent/ions impose no stereo requirement.
  const specified=sources.flatMap((source,index)=>prepareStereoGraph(source).centers.length?[index]:[]);
  const graphRows=specified.map(index=>candidates[index]);
  const stereoRows=specified.map(index=>candidates[index].filter(target=>sourceStereoCorrespondence(sources[index],targets[target])==='compatible'));
  // Matching the full multiset permits source component reordering, including
  // exchanging identical molecules, without losing one specified centre.
  if(hasCompleteMatching(graphRows)&&!hasCompleteMatching(stereoRows)){
    const problem=issue('source-stereo-change','原文件可对应的指定手性中心在二维转换后改变或丢失；请核对原楔线方向与转换结果。');
    const locatedRows=new Set(graphRows.flatMap((row,index)=>row.length===1&&stereoRows[index].length===0?[index]:[]));
    const located=new Set([...locatedRows].map(index=>graphRows[index][0]));
    const remaining=stereoRows.filter((_,index)=>!locatedRows.has(index)).map(row=>row.filter(index=>!located.has(index)));
    if(located.size&&hasCompleteMatching(remaining))return[{...problem,scope:'component',componentIds:[...located].map(index=>draft.components[index].id)}];
    return[problem];
  }
  return[];
}

export function auditSourceFacts(facts:SourceFacts,draft?:TwoDDraft):TwoDIssue[]{
  const issues=[...facts.issues];if(!draft)return issues;
  const physical=facts.nodes.filter(node=>!node.attrs.HasNestedFragment&&['0','1','Unspecified','Element'].includes(String(node.type)));
  const actual=draft.components.flatMap(component=>component.atoms).filter(atom=>!atom.sourceProperties.generatedFromImplicitH);
  const signature=(nodes:{element:string;charge:number}[])=>nodes.map(node=>`${node.element}:${node.charge}`).sort().join('|');
  const expected=physical.map(node=>({element:ELEMENTS[node.element-1]??`unknown:${node.element}`,charge:node.charge}));
  const got=actual.map(atom=>({element:atom.element,charge:atom.formalCharge??0}));
  const completeInventory=facts.nodes.every(node=>node.attrs.HasNestedFragment||['0','1','Unspecified','Element'].includes(String(node.type))||node.nested&&['12','ExternalConnectionPoint'].includes(String(node.type)));
  if(completeInventory&&signature(expected)!==signature(got))issues.push(issue('source-atom-charge-mismatch','原文件与二维解析结果的元素/逐原子电荷清单不一致；请核实缩写展开或来源版本。'));
  const wedges=draft.components.flatMap(component=>component.bonds).filter(bond=>[1,6].includes(bond.stereo??0)).length;
  if(facts.wedges>0&&wedges===0)issues.push(issue('source-stereo-loss','原文件的楔线立体定义在转换结果中缺失。'));
  issues.push(...auditMappedSourceStereo(facts,draft,physical));
  issues.push(...auditSourceStereoGroups(facts,draft,physical));
  const sourceGroups=new Map<string,SourceNode[]>();
  for(const node of physical){const group=sourceGroups.get(node.fragmentKey)??[];group.push(node);sourceGroups.set(node.fragmentKey,group);}
  const componentSignature=(component:TwoDDraft['components'][number])=>signature(component.atoms.filter(atom=>!atom.sourceProperties.generatedFromImplicitH).map(atom=>({element:atom.element,charge:atom.formalCharge??0})));
  return issues.map(original=>{
    if(original.scope==='component'&&original.componentIds?.length)return original;
    let candidates:TwoDDraft['components']=[];
    const group=original.sourceFragmentKey?sourceGroups.get(original.sourceFragmentKey):undefined;
    if(group){
      const key=signature(group.map(node=>({element:ELEMENTS[node.element-1]??`unknown:${node.element}`,charge:node.charge})));
      candidates=draft.components.filter(component=>componentSignature(component)===key);
    }
    const codes=TWO_D_SOURCE_LOCAL_CODES[original.code];
    const retained=codes?draft.components.filter(component=>component.issues.some(value=>codes.includes(value.code))):[];
    if(candidates.length!==1 && retained.length && (!completeInventory||signature(expected)===signature(got)))candidates=retained;
    if(candidates.length===1 || retained.length && candidates.every(candidate=>retained.includes(candidate)) && candidates.length){
      return {...original,scope:'component' as const,componentIds:candidates.map(component=>component.id)};
    }
    // No positional/graph correspondence is invented merely from parser order.
    return {...original,scope:'document' as const,message:`文档级未定位风险：${original.message}`};
  });
}

/** CDX/CDXML group numbers may be renumbered by conversion; compare type and
 * independently mapped membership, never the arbitrary numeric group label. */
function auditSourceStereoGroups(facts:SourceFacts,draft:TwoDDraft,physical:SourceNode[]):TwoDIssue[]{
  const sourceType=(node:SourceNode)=>['3','Or'].includes(String(node.attrs.EnhancedStereoType))?'OR':
    ['4','And'].includes(String(node.attrs.EnhancedStereoType))?'AND':undefined;
  if(!physical.some(sourceType))return[];
  const analysis=sourceStereoGraphs(facts,draft,physical),issues:TwoDIssue[]=[];
  const groups=new Map<string,SourceNode[]>();
  for(const node of physical){const type=sourceType(node);if(!type)continue;
    const key=JSON.stringify([node.fragmentKey,type,node.attrs.EnhancedStereoGroupNum??'missing']);
    const members=groups.get(key)??[];members.push(node);groups.set(key,members);
  }
  for(const members of groups.values()){
    const graphIndex=analysis.sources.findIndex(graph=>graph.atoms.some(atom=>atom.key===members[0].id));
    const candidates=analysis.candidates[graphIndex]??[];
    let valid=false,targetIndex:number|undefined;
    if(candidates.length===1){
      targetIndex=candidates[0];const source=analysis.sources[graphIndex],target=analysis.targets[targetIndex];
      const mapping=sourceStereoMapping(source,target)!;
      const mapped=members.map(node=>mapping[source.atoms.findIndex(atom=>atom.key===node.id)]);
      if(mapped.every(index=>index!==undefined)){
        const component=draft.components[targetIndex],labels=mapped.map(index=>parseTwoDStereoLabel(component.atoms.find(atom=>atom.id===target.atoms[index!].key)!.sourceProperties.stereoLabel));
        const label=labels[0];
        valid=!!label&&label.type===sourceType(members[0])&&labels.every(other=>other?.type===label.type&&other.id===label.id)&&
          component.atoms.filter(atom=>{const other=parseTwoDStereoLabel(atom.sourceProperties.stereoLabel);return other?.type===label.type&&other.id===label.id;}).length===members.length;
      }
    }
    if(!valid)issues.push({...issue('source-enhanced-stereo','原文件增强立体组的类型或成员未能与转换图完整对应。'),sourceFragmentKey:members[0].fragmentKey,
      ...(targetIndex!==undefined?{scope:'component' as const,componentIds:[draft.components[targetIndex].id]}:{})});
  }
  return issues;
}
