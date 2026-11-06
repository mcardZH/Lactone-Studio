import { ELEMENTS } from '../../core/elements';
import type { TwoDDraft, TwoDIssue } from './types';

interface SourceNode { id:string; type:number|string; element:number; charge:number; nested:boolean; fragmentKey:string; attrs:Record<string,string|number> }
interface SourceBond { id:string; begin:string; end:string; order:number; fragmentKey:string }
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
  if(a.EnhancedStereoType && !['0','1','2','Absolute','None','Unspecified'].includes(String(a.EnhancedStereoType))) issues.push(issue('source-enhanced-stereo','原文件含增强或相对立体组。'));
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
      const node:SourceNode={id:attrs.id??'',type:attrs.NodeType??'Element',element:Number(attrs.Element??6),charge:Number(attrs.Charge??0),nested:nodeDepth>0,fragmentKey:fragments[0]??'document',attrs};
      checkNode(node,result.issues); result.nodes.push(node);if(!selfClosing){nodeDepth++;nodeStack.push(node);}
    }
    if(name==='fragment'){if(nodeStack.length)nodeStack.at(-1)!.attrs.HasNestedFragment=1;if(!selfClosing)fragments.push(attrs.id??`fragment-${token.index}`);}
    if(name==='b'){
      if(attrs.B&&attrs.E)result.bonds.push({id:attrs.id??'',begin:attrs.B,end:attrs.E,order:Number(attrs.Order??1),fragmentKey:fragments[0]??'document'});
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
  const stack:{type:number;id:number;node?:SourceNode;bond?:SourceBond}[]=[];let pos=start,objects=0,ended=false;
  const need=(n:number)=>{if(pos+n>input.length)throw new Error('CDX属性或对象被截断。');};
  while(pos<input.length){
    need(2);const tag=view.getUint16(pos,true);pos+=2;
    if(tag===0){if(stack.length){const frame=stack.pop()!;if(frame.node)checkNode(frame.node,result.issues);if(frame.bond)result.bonds.push(frame.bond);}else{ended=true;break;}continue;}
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
      if(tag===0x0400)node.type=uint();if(tag===0x0402)node.element=uint();if(tag===0x0421)node.charge=length===1?view.getInt8(pos):length===2?view.getInt16(pos,true):0;
      const fields:Record<number,string>={0x0403:'ElementList',0x0404:'Formula',0x0420:'Isotope',0x0422:'Radical',0x0423:'FreeSites',0x0425:'RingBondCount',0x0426:'UnsaturatedBonds',0x0441:'GenericList',0x0446:'EnhancedStereoType'};
      if(fields[tag])node.attrs[fields[tag]]=uint();
    }
    const fragmentKey=String(stack.find(parent=>parent.type===0x8003)?.id??'document');
    if(frame?.bond){if(tag===0x0604)frame.bond.begin=String(uint());if(tag===0x0605)frame.bond.end=String(uint());if(tag===0x0600)frame.bond.order=uint();}
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
  const sourceGroups=new Map<string,SourceNode[]>();
  for(const node of physical){const group=sourceGroups.get(node.fragmentKey)??[];group.push(node);sourceGroups.set(node.fragmentKey,group);}
  const componentSignature=(component:TwoDDraft['components'][number])=>signature(component.atoms.filter(atom=>!atom.sourceProperties.generatedFromImplicitH).map(atom=>({element:atom.element,charge:atom.formalCharge??0})));
  return issues.map(original=>{
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
