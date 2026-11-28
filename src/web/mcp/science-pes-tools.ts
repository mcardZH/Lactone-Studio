import { baseElectronicStateParameterError, type BaseElectronicStateValues } from '../../core/base-electronic-state';
import { isPeriodic } from '../../core/periodic';
import { supportsXtbAlpb, usesXtbSccIterations } from '../../core/xtb-capabilities';
import type { AdvancedFrameSource } from '../../modeling/advanced/frame-source';
import type { PesController } from '../../modeling/pes/controller';
import type { PesAxis, PesCard, PesGeometry, PesGroup, PesMethodDraft,
  PesNode, PesParameter, PesParameters, PesRun } from '../../modeling/pes/contracts';
import { defaultParameters, defaultPesCard, defaultPesMethod, effectivePesScanAlgorithm, isPesScanOptimizer, isSellaTsAlgorithm, nebPresetParameters,
  parameterVisible, PES_ALGORITHMS, PES_CI_NEB_MINIMUM_BEADS, PES_DEFAULT_HESSIAN_STEP_BOHR, PES_DEFAULT_SCAN_ALGORITHM,
  PES_IRC_NUMBER_FIELDS, pesParameterSections, sellaPresetParameters } from '../../modeling/pes/defaults';
import { pesCoordinateNameIssue } from '../../modeling/pes/expressions';
import { PesCompositionChange, pesElectronicConfirmation, pesElectronicDraft, PesSubmissionChanged } from '../../modeling/pes/input-state';
import { periodicPesOperationAvailable } from '../../modeling/pes/periodic-capabilities';
import { cardSource, numberDraft, parameterValue, pesPathStructureIssue } from '../../modeling/pes/request';
import { scanCardDraft } from '../../modeling/pes/scan-source';
import { objectSchema, presentationFields, presentationMode, toolError, type McCall, type McpPresentationMode, type McTool } from './types';
import { electronicOptions, integer, positive, record, textValue, oneOf, targetSchema } from './science-arguments';
import { pesRequestEvidence, presentScienceRun, type SciencePresentation } from './science-runtime';
import { batchCounts } from './batch-receipts';
import { checkToolArguments } from './tool-arguments';
import { pesHessianMode } from './pes-evidence';

export interface SciencePesContext extends SciencePresentation {
  pes(): Promise<PesController | undefined>;
  resolveSource(target: unknown, signal?: AbortSignal, electronic?:BaseElectronicStateValues): Promise<AdvancedFrameSource>;
  registerPesNode(groupId: string, node: PesNode): unknown;
  pesTarget?(groupId:string,nodeId:string):string|undefined;
  readPesScanGeometry?(groupId:string):PesGeometry|undefined;
  /** null means this node owns the visible canvas, but it has no submitted frame. */
  readPesWorkbenchGeometry?(groupId:string,nodeId:string):PesGeometry|null|undefined;
  presentPesConfiguration?(groupId:string,node:PesNode,cardId:string|undefined,mode:McpPresentationMode,call?:McCall):unknown|Promise<unknown>;
}

function unavailableFrame(groupId:string,nodeId:string,cardId?:string){
  return toolError('SCIENCE_FRAME_UNAVAILABLE','请在对应的势能面工作区显示完整科学帧或准备其轨迹后再提交。',{
    groupId,nodeId,cardId,submitted:false,next:{tool:'es_show',arguments:{target:{kind:'pes-node',ref:nodeId},waitFor:'selected'}},
  });
}

function workbenchGeometry(ctx:SciencePesContext,controller:PesController,group:PesGroup,nodeId:string,cardId?:string):PesGeometry {
  const node=group.nodes.find(row=>row.id===nodeId);
  if(!node)throw toolError('TARGET_MISSING','势能面输入节点已关闭。',{
    groupId:group.id,nodeId,cardId,submitted:false,next:{tool:'es_pes_groups',arguments:{groupId:group.id}},
  });
  const visible=ctx.readPesWorkbenchGeometry?.(group.id,nodeId);
  if(visible===null)throw unavailableFrame(group.id,nodeId,cardId);
  const source=visible??controller.nodeGeometry(group.id,nodeId);
  if(!source||node.kind==='result'&&!source.source?.frameId)throw unavailableFrame(group.id,nodeId,cardId);
  return source;
}

const parameterValueSchema = { type: ['number', 'string', 'boolean'] };
const countValue = { type: ['integer', 'string'] };
const convergencePresets = ['loose','medium','tight','custom'] as const;
const ciNebPathInitializers = ['sidpp','fsm'] as const;
const ciNebParametersSchema = {
  type: 'object',
  properties: {
    beads: { ...countValue, minimum: PES_CI_NEB_MINIMUM_BEADS, description: 'Total number of beads, including the two endpoints.' },
    nebIterations: { ...countValue, minimum: 1, description: 'Maximum native path iterations, including the climbing stage.' },
    recordInterval: { ...countValue, minimum: 1, description: 'Retain a path record every N iterations.' },
    nebOptimizer: { enum: ['fire2','fire','lbfgs'] },
    nebConvergencePreset: { enum: convergencePresets, description: 'Use custom to supply explicit NEB or CI force thresholds.' },
    pathInitializer: { enum: ciNebPathInitializers },
    coordinateSystem: { const: 'xyz' },
  },
  additionalProperties: parameterValueSchema,
};
const parametersSchema = { type: 'object', description: 'Exact native parameter names depend on operation and algorithm. Read es_pes_parameters for defaults, units and applicable fields.', additionalProperties: parameterValueSchema };
const electronicSchema = objectSchema({ charge: {type:'integer'}, multiplicity: {type:'integer',minimum:1} }, ['charge','multiplicity']);
const pesMethods=['gfn0','gfn1','gfn2','gfnff'] as const;
const methodSchema = objectSchema({ method: {enum:pesMethods},
  solvationModel:{enum:['none','alpb']}, solvent:{type:'string'} });
const pathSchema = { start:targetSchema, end:targetSchema, atomMapping:{type:'object',additionalProperties:{type:'string'}},
  useAtomOrder:{type:'boolean'}, method:methodSchema, electronic:electronicSchema, parameters:parametersSchema };
const pathResourceOverrideSchema=objectSchema({xtbBatchParallelism:{type:'integer',minimum:1}},['xtbBatchParallelism']);
const ciNebPairSchema = objectSchema({ ...pathSchema, parameters: ciNebParametersSchema,resourceOverrides:pathResourceOverrideSchema }, ['start','end']);
const expressionFields = { expression:{type:'string'},
  coordinates:{type:'array',items:objectSchema({ id:{type:'string'}, name:{type:'string'}, type:{enum:['B','A','D']},
    atomIds:{type:'array',items:{type:'string'},description:'Stable atom IDs in geometric order. For A the second atom is the vertex. For D the middle two atoms are the central bond.'}, images:{type:'array',items:{type:'array',items:{type:'integer'},minItems:3,maxItems:3}}},
    ['id','name','type','atomIds'])}};
const axisSchema = objectSchema({ ...expressionFields,name:{type:'string'},lower:{type:'number'},upper:{type:'number'},points:{type:'integer',minimum:2}},
  ['coordinates','upper','points']);

function sourceGeometry(source: AdvancedFrameSource): PesGeometry {
  return { documentId:source.ref.documentId, revision:source.ref.revision, label:source.label,
    structure:source.sourceElectronicState?{...source.structure,...source.sourceElectronicState}:source.structure, originFrame:source.ref };
}

function groupRecord(controller: PesController, value: unknown): PesGroup {
  const id=textValue(value,'groupId');
  const group=controller.getSnapshot().groups.find(row=>row.id===id);
  if(!group)throw toolError('TARGET_MISSING','势能面组已关闭或不属于当前项目。');
  return group;
}

function requirePesMethod(method:PesMethodDraft['method']) {
  if(!pesMethods.some(option=>option===method))throw toolError('INVALID_ARGUMENT','请为此势能面组选择支持的 xTB 方法。');
}

function methodPatch(value: unknown,current:PesMethodDraft,periodic:boolean): Partial<PesMethodDraft> {
  if(value!==undefined)checkToolArguments(methodSchema,value,'arguments.method');
  const values=value===undefined?{}:record(value,'method'),method=oneOf(values.method,pesMethods,'method.method');
  const solvationModel=oneOf(values.solvationModel,['none','alpb'],'method.solvationModel');
  const solvent=values.solvent===undefined?undefined:textValue(values.solvent,'method.solvent');
  const effective=method??current.method,model=solvationModel??current.solvationModel;
  requirePesMethod(effective);
  if(solvent&&model!=='alpb')throw toolError('INVALID_ARGUMENT','指定溶剂时请选择 ALPB。');
  if((solvationModel==='alpb'||solvent)&&!supportsXtbAlpb(effective,solvent??current.solvent,periodic))
    throw toolError('INVALID_ARGUMENT','当前体系或计算级别不支持所选的 ALPB 溶剂。');
  return {...(method?{method,device:undefined}:{}),
    ...(solvationModel?{solvationModel}:{}),...(solvent?{solvent}:{})};
}

function settings(algorithm:string, before:PesParameters, value:unknown, method:PesMethodDraft['method'],periodic:boolean){
  if(value===undefined)return before;
  const values=record(value,'parameters'),patch:PesParameters={};
  if(algorithm==='ci-neb'&&values.pathInitializer!==undefined&&!ciNebPathInitializers.some(name=>name===values.pathInitializer))
    throw toolError('INVALID_ARGUMENT','CI-NEB 的路径初猜可用 S-IDPP（sidpp）或 FSM（fsm）。',
      {algorithm,field:'pathInitializer',path:'parameters.pathInitializer',requested:values.pathInitializer,
        supportedValues:ciNebPathInitializers,configurationChanged:false,submitted:false,
        recovery:{tool:'es_pes_parameters',arguments:{algorithm,method}}});
  if(algorithm==='ci-neb'&&values.nebConvergencePreset!==undefined)
    before=nebPresetParameters(before,oneOf(values.nebConvergencePreset,convergencePresets,'nebConvergencePreset')!);
  if((isPesScanOptimizer(algorithm)||Object.hasOwn(PES_ALGORITHMS.ts,algorithm))&&values.convergencePreset!==undefined)
    before=sellaPresetParameters(algorithm,before,oneOf(values.convergencePreset,convergencePresets,'convergencePreset')!);
  const accepted=new Set([...Object.keys(defaultParameters(algorithm)),...Object.keys(before),
    ...pesParameterSections(algorithm,before).flatMap(section=>section.fields.map(field=>field.key))]);
  const executionFields=['executionProfile','pathSemantics','device','netGpuBatchLimit'];
  for(const [key,field] of Object.entries(values)){
    if(!accepted.has(key)||executionFields.includes(key))throw toolError('INVALID_ARGUMENT','该算法没有可设置的参数 '+key+'。',{
      algorithm,field:key,path:'parameters.'+key,supportedParameters:[...accepted].filter(name=>name!=='accuracy'&&!executionFields.includes(name)&&
        (usesXtbSccIterations(method)||!['electronicTemperatureK','maxSccIterations'].includes(name))),
    });
    if(!['number','string','boolean'].includes(typeof field)||typeof field==='number'&&!Number.isFinite(field))
      throw toolError('INVALID_ARGUMENT','参数 '+key+' 需要此卡支持的有限数值、字符串或布尔值。',{algorithm,field:key});
    if(key==='accuracy')throw toolError('INVALID_ARGUMENT','精度由 PES 执行策略按操作确定，请在运行回执读取实际精度。');
    if(['electronicTemperatureK','maxSccIterations'].includes(key)&&!usesXtbSccIterations(method))
      throw toolError('INVALID_ARGUMENT','该电子结构后端不使用 '+key+'。');
    patch[key]=field as PesParameter;
  }
  const chosen={...before,...patch};
  const presetParameters=algorithm==='ci-neb'?['nebConvergencePreset','ciMaxForce','ciRmsForce','nebMaxForce','nebRmsForce']:
    algorithm==='de-gsm'?['gsmConvergencePreset','gsmMaxGradient','gsmRmsGradient']:
    isPesScanOptimizer(algorithm)||Object.hasOwn(PES_ALGORITHMS.ts,algorithm)?['convergencePreset','fmaxHartreePerBohr','maxForceHartreePerBohr']:undefined;
  if(presetParameters&&presetParameters.slice(1).some(key=>Object.hasOwn(patch,key))&&chosen[presetParameters[0]]!=='custom')
    throw toolError('INVALID_ARGUMENT','自定义收敛阈值需配合自定义预设 '+presetParameters[0]+'。');
  if(isPesScanOptimizer(algorithm)||Object.hasOwn(PES_ALGORITHMS.ts,algorithm)){
    for(const retired of ['rmsForceHartreePerBohr','maxDisplacementBohr','rmsDisplacementBohr'])if(Object.hasOwn(patch,retired))
      throw toolError('INVALID_ARGUMENT','现有算法仅使用最大力收敛阈值 fmaxHartreePerBohr。');
  }
  if(patch.coordinateSystem!==undefined&&(periodic||algorithm==='ci-neb'||isPesScanOptimizer(algorithm)&&algorithm!=='sella-scan')&&patch.coordinateSystem!=='xyz')
    throw toolError('INVALID_ARGUMENT','该算法使用笛卡尔坐标 xyz。');
  const fields=new Map(pesParameterSections(algorithm,chosen).flatMap(section=>section.fields.map(field=>[field.key,field] as const)));
  for(const [key,value] of Object.entries(patch)){
    if(!parameterVisible(key,chosen))throw toolError('INVALID_ARGUMENT','所选参数分支不使用 '+key+'。');
    const field=fields.get(key);
    if(field)parameterValue(field,value);
  }
  return chosen;
}

function electronicValues(geometry:PesGeometry,value:unknown){
  const override=value===undefined?{}:record(value,'electronic');
  const charge=integer(override.charge??geometry.structure.charge??undefined,'charge');
  const multiplicity=integer(override.multiplicity??geometry.structure.multiplicity??undefined,'multiplicity',1);
  if(charge===undefined||multiplicity===undefined)throw toolError('INVALID_ARGUMENT','请指定输入结构的电荷和自旋多重度。');
  const issue=baseElectronicStateParameterError(geometry.structure,{charge,multiplicity});
  if(issue)throw toolError('INVALID_ARGUMENT',issue);
  return {charge,multiplicity};
}

function electronicConfirmationStep(group:PesGroup,geometry:PesGeometry,operation:'scan'|'path'|'ts'|'hessian'|'irc',nodeId?:string) {
  const draft=pesElectronicDraft(group,geometry),values={charge:Number(draft.charge),multiplicity:Number(draft.multiplicity)};
  const valid=/^[+-]?\d+$/.test(draft.charge)&&/^\+?\d+$/.test(draft.multiplicity)
    &&!baseElectronicStateParameterError(geometry.structure,values);
  return {tool:'es_pes_configure',arguments:{groupId:group.id,operation,...(operation!=='path'&&nodeId?{nodeId}:{}),
    ...(valid?{electronic:values}:{})},confirm:['charge','multiplicity']};
}

function requireRunElectronic(group:PesGroup,geometry:PesGeometry,operation:'scan'|'path'|'ts'|'hessian'|'irc',nodeId?:string,cardId?:string) {
  if(pesElectronicConfirmation(group,geometry))return;
  throw toolError('PES_ELECTRONIC_UNCONFIRMED','请先确认本次输入结构的电荷和自旋多重度。',{
    groupId:group.id,nodeId,cardId,operation,submitted:false,...pesSourceEvidence(geometry),electronicDraft:pesElectronicDraft(group,geometry),
    next:electronicConfirmationStep(group,geometry,operation,nodeId),
  });
}

function confirm(controller:PesController, groupId:string, geometry:PesGeometry, value:unknown, shareWithModel=false){
  controller.confirmElectronic(groupId,geometry,electronicValues(geometry,value),shareWithModel);
}

function recordEndpoint(controller:PesController,groupId:string,card:PesCard,slot:string,geometry:PesGeometry){
  return controller.captureSnapshot(groupId,card.id,slot,geometry).geometry;
}

function pathProduct(start:AdvancedFrameSource,end:AdvancedFrameSource,args:Record<string,unknown>){
  const geometry=sourceGeometry(end),target=geometry.structure;
  const a=start.structure.atoms,b=target.atoms;
  const mapping=args.atomMapping===undefined?undefined:record(args.atomMapping,'atomMapping');
  const stableOwner=start.ref.documentId===end.ref.documentId&&start.ref.documentEpoch===end.ref.documentEpoch
    &&start.ref.sourceId===end.ref.sourceId&&start.ref.sourceRevision===end.ref.sourceRevision;
  if(a.length!==b.length)throw toolError('INVALID_ARGUMENT','两端点原子数不同。');
  if(mapping&&args.useAtomOrder===true)throw toolError('INVALID_ARGUMENT','原子映射和按序对应请择一指定。');
  if(!mapping&&!stableOwner&&args.useAtomOrder!==true)throw toolError('INVALID_ARGUMENT','两个独立来源需要提交原子映射，或在确认后指定按现有顺序对应。');
  if(mapping&&Object.keys(mapping).length!==a.length)throw toolError('INVALID_ARGUMENT','原子映射须覆盖全部原子。');
  const productIds=new Map(b.map((atom,index)=>[atom.id,index]));
  const indices=a.map((atom,index)=>args.useAtomOrder===true?index:productIds.get(mapping?textValue(mapping[atom.id!],'atomMapping'):atom.id));
  if(indices.some((index,at)=>index===undefined||a[at].element!==b[index].element)||new Set(indices).size!==b.length)
    throw toolError('INVALID_ARGUMENT','原子映射须一一对应且保持元素身份。');
  const ordered=indices as number[],atomMapping=Object.fromEntries(a.map((atom,index)=>[atom.id,b[ordered[index]].id]));
  const inverse=new Map(ordered.map((old,index)=>[old,index]));
  const product=ordered.every((old,index)=>old===index)?target:{...target,atoms:ordered.map(index=>b[index]),
    bonds:target.bonds?.map(bond=>({...bond,a:inverse.get(bond.a)!,b:inverse.get(bond.b)!})),molfile:undefined,
    mapping:target.mapping?.map(row=>({...row,current:inverse.get(row.current)??row.current}))};
  const issue=pesPathStructureIssue(start.structure,product,'产物');
  if(issue)throw toolError('INVALID_ARGUMENT',issue);
  return { geometry:{...geometry,structure:product}, atomMapping };
}

function expressionDraft(value:unknown,path:string):PesAxis['definition'] {
  const definition=record(value,'expression definition');
  if(!Array.isArray(definition.coordinates))throw toolError('INVALID_ARGUMENT','表达式需要内坐标定义。');
  const names=new Map<string,string>();
  const coordinates=definition.coordinates.map((value,index)=>{
    const row=record(value,'coordinate'),type=oneOf(row.type,['B','A','D'],'coordinate.type');
    if(!type||!Array.isArray(row.atomIds)||row.atomIds.length!==({B:2,A:3,D:4}[type]))throw toolError('INVALID_ARGUMENT','内坐标原子数与类型不符。');
    const id=textValue(row.id,'coordinate.id'),name=typeof row.name==='string'?row.name:'';
    const issue=pesCoordinateNameIssue(name,names);
    if(issue)throw toolError('INVALID_ARGUMENT',issue==='duplicate-name'?`内坐标名称重复：${name}。`:`内坐标名称无效：${name}。`,
      {path:`${path}.coordinates[${index}].name`,reason:issue,coordinateId:id,name,conflictingCoordinateId:names.get(name),
        expected:'Start with a letter or underscore, followed by letters, digits or underscores.',configurationChanged:false,submitted:false});
    names.set(name,id);
    const images=row.images;
    if(images!==undefined&&(!Array.isArray(images)||images.length!==row.atomIds.length||
      images.some(image=>!Array.isArray(image)||image.length!==3||image.some(value=>!Number.isSafeInteger(value)))))
      throw toolError('INVALID_ARGUMENT','晶胞图像需按内坐标原子逐一给出三个整数。');
    return {id,name,type,atomIds:row.atomIds.map(id=>textValue(id,'coordinate.atomId')),
      ...(images===undefined?{}:{images:images as PesAxis['definition']['coordinates'][number]['images']})};
  });
  return {coordinates,expression:definition.expression===undefined?coordinates[0]?.name??'':textValue(definition.expression,'expression')};
}

function scanAxis(template:PesAxis, value:unknown,index:number):PesAxis {
  const axis=record(value,'axis');
  const upper=axis.upper,lower=axis.lower,points=integer(axis.points,'axis.points',2);
  if(typeof upper!=='number'||!Number.isFinite(upper)||lower!==undefined&&(typeof lower!=='number'||!Number.isFinite(lower))||points===undefined)
    throw toolError('INVALID_ARGUMENT','扫描上限、步数或起点无效。');
  return {...template,name:axis.name===undefined?template.name:textValue(axis.name,'axis.name'),
    definition:expressionDraft(axis,`axes[${index}]`),
    lowerMode:lower===undefined?'automatic':'manual',lower:lower===undefined?'':String(lower),upper:String(upper),points:String(points),rangeDriver:'points'};
}

function scanAxisCoordinates(axes: readonly PesAxis[], geometry: PesGeometry) {
  const needed = new Set(axes.flatMap(axis => axis.definition.coordinates.flatMap(coordinate => coordinate.atomIds)));
  const atoms = new Map<string, { atomNumber: number; element: string }>();
  for (const [index, atom] of geometry.structure.atoms.entries()) {
    if (atom.id && needed.has(atom.id)) atoms.set(atom.id, { atomNumber: index + 1, element: atom.element });
    if (atoms.size === needed.size) break;
  }
  return axes.map(axis => ({
    axisId: axis.id,
    axisName: axis.name,
    coordinates: axis.definition.coordinates.map(coordinate => {
      const orderedAtoms = coordinate.atomIds.map(atomId => ({ atomId, ...atoms.get(atomId) }));
      return {
        id: coordinate.id, name: coordinate.name, type: coordinate.type, orderedAtoms,
        ...(coordinate.type === 'A' ? { vertex: orderedAtoms[1] } : {}),
      };
    }),
  }));
}

function publicCard(card:PesCard){
  return {id:card.id,name:card.name,kind:card.kind,algorithm:card.algorithm,axes:card.kind==='scan'?card.axes.slice(0,card.dimension):undefined,
    ...(card.kind==='scan'?{sourceMode:'current-display'}:{}),
    parameters:card.parametersByAlgorithm[card.algorithm],
    netGpuBatchLimit:card.netGpuBatchLimit,resourceOverrides:card.resourceOverrides,
    slots:card.kind==='scan'?{}:Object.fromEntries(Object.entries(card.slots).map(([key,value])=>[key,value&&{
      documentId:value.documentId,revision:value.revision,source:value.source,originFrame:value.originFrame,inputSnapshotId:value.inputSnapshotId}])),
    mappings:card.mappings,runIds:card.runIds};
}

function publicGroup(group:PesGroup, source?:PesGeometry){
  return {groupId:group.id,name:group.name,initialNodeId:group.initialNodeId,activeNodeId:group.activeNodeId,
    nodes:group.nodes.map(node=>({id:node.id,name:node.name,kind:node.kind,runIds:node.runIds,source:node.geometry.source,originFrame:node.geometry.originFrame})),
    sharedMethod:group.sharedMethod,electronic:source?pesElectronicConfirmation(group,source):undefined,constraints:group.constraints,
    input:source&&{...pesSourceEvidence(source),documentId:source.documentId,revision:source.revision,
      electronicDraft:pesElectronicDraft(group,source),electronicConfirmed:!!pesElectronicConfirmation(group,source)},
    ts:group.ts,ircParameters:group.ircParameters,hessianStepBohr:group.hessianStepBohr,cards:group.cards.map(publicCard)};
}

async function presentConfiguration(ctx:SciencePesContext,group:PesGroup,nodeId:string,cardId:string|undefined,mode:McpPresentationMode,call?:McCall,source?:PesGeometry){
  const receipt={...publicGroup(group,source),cardId};
  const node=group.nodes.find(row=>row.id===nodeId);
  if(!ctx.presentPesConfiguration||!node)return receipt;
  if(call?.signal.aborted)return {...receipt,presentation:{mode,status:'cancelled'}};
  try{return {...receipt,presentation:await ctx.presentPesConfiguration(group.id,node,cardId,mode,call)};}
  catch(cause){return {...receipt,presentation:{mode,status:'unavailable',message:cause instanceof Error?cause.message:String(cause)}};}
}

const pesParameterAlgorithms = [...Object.keys(PES_ALGORITHMS.path),...Object.keys(PES_ALGORITHMS.scan),...Object.keys(PES_ALGORITHMS.ts),'sella-irc','irc','numeric','hessian'];
const ircParameterFields=[...Object.entries(PES_IRC_NUMBER_FIELDS).map(([key,field])=>({...field,key})),
  {key:'mode',initial:'auto',label:'起始模态',values:['auto','positive one-based mode index']}];
const hessianStepField={key:'hessianStepBohr',initial:PES_DEFAULT_HESSIAN_STEP_BOHR,unit:'bohr',exclusiveMinimum:0,location:'es_pes_configure top level'};
const ircParameterDefaults=Object.fromEntries(ircParameterFields.map(field=>[field.key,field.initial]));

function ircSettings(value:unknown):PesParameters|undefined{
  if(value===undefined)return;
  const input=record(value,'parameters'),settings:PesParameters={};
  for(const [key,raw] of Object.entries(input)){
    const about={operation:'irc',algorithm:'sella-irc',field:key,path:`parameters.${key}`,submitted:false,configurationChanged:false,
      recovery:{tool:'es_pes_parameters',arguments:{algorithm:'sella-irc'}}};
    if(key==='mode'){
      if(raw===''||raw==='auto'){settings.mode='auto';continue;}
      if((typeof raw==='number'||typeof raw==='string')&&Number.isSafeInteger(Number(raw))&&Number(raw)>=1){settings.mode=Number(raw);continue;}
      throw toolError('INVALID_ARGUMENT','IRC 起始模态须为 auto 或从 1 开始的整数。',about);
    }
    if(!Object.hasOwn(PES_IRC_NUMBER_FIELDS,key))throw toolError('INVALID_ARGUMENT',`IRC 不使用参数 ${key}。`,
      {...about,supportedParameters:Object.keys(ircParameterDefaults)});
    const field=PES_IRC_NUMBER_FIELDS[key as keyof typeof PES_IRC_NUMBER_FIELDS];
    let parsed:number;
    try{parsed=numberDraft(String(raw),key);}
    catch{throw toolError('INVALID_ARGUMENT',`IRC 参数 ${key} 需要有限数值。`,{...about,parameter:field});}
    if('integer' in field?!Number.isSafeInteger(parsed)||parsed<field.minimum:parsed<=field.exclusiveMinimum)
      throw toolError('INVALID_ARGUMENT',`IRC 参数 ${key} 超出有效范围。`,{...about,parameter:field});
    settings[key]=parsed;
  }
  return settings;
}

function publicParameters(algorithm:string,method:PesMethodDraft['method']) {
  if(algorithm==='irc'||algorithm==='sella-irc')return {algorithm:'sella-irc',operation:'irc',method,defaults:ircParameterDefaults,
    sections:[{fields:ircParameterFields}],topLevel:[hessianStepField],
    notes:{mode:'auto chooses the native starting mode; a number is a one-based mode index.',recalcInterval:'0 uses the initial Hessian without periodic recalculation.'}};
  if(algorithm==='hessian'||algorithm==='numeric')return {algorithm:'numeric',operation:'hessian',method,
    defaults:{hessianStepBohr:hessianStepField.initial},sections:[],topLevel:[hessianStepField]};
  const defaults=defaultParameters(algorithm), display=pesParameterSections(algorithm,defaults);
  const excluded=['executionProfile','pathSemantics','device','netGpuBatchLimit','accuracy',...(!usesXtbSccIterations(method)?['electronicTemperatureK','maxSccIterations']:[])];
  return {
    algorithm, method,
    defaults:Object.fromEntries(Object.entries(defaults).filter(([key])=>!excluded.includes(key)&&parameterVisible(key,defaults))),
    sections:display.map(section=>({...section,fields:section.fields.filter(field=>!excluded.includes(field.key))})).filter(section=>section.fields.length),
    ...(algorithm==='ci-neb'?{coreParameterSchema:ciNebParametersSchema}:{}),
  };
}

export function pesSourceEvidence(geometry:PesGeometry){
  return {source:geometry.source??geometry.originFrame,...(geometry.source&&geometry.originFrame?{originFrame:geometry.originFrame}:{})};
}

function startReceipt(controller:PesController,ctx:SciencePesContext,node:PesNode){
  const runId=node.runIds.at(-1)!;
  const run=controller.getSnapshot().groups.find(group=>group.runs[runId])!.runs[runId];
  ctx.registerPesNode(run.request.runIdentity.groupId,node);
  const targetRef=ctx.pesTarget?.(run.request.runIdentity.groupId,node.id);
  return {kind:'pes' as const,...run.request.runIdentity,documentId:run.source.documentId,nodeId:node.id,status:run.status,operation:run.request.operation,algorithm:run.request.algorithm,
    targetRef,...pesSourceEvidence(run.source),request:pesRequestEvidence(run.request),accepted:true,nativeStarted:run.nativeStarted??false,workerSettled:run.workerSettled??false,
    next:{tool:'es_run_read',arguments:{runId}}};
}

function pathResourceOverrides(value:unknown){
  if(value===undefined)return;
  checkToolArguments(pathResourceOverrideSchema,value,'arguments.resourceOverrides');
  return {xtbBatchParallelism:integer(record(value,'resourceOverrides').xtbBatchParallelism,'resourceOverrides.xtbBatchParallelism',1)!};
}
type PesRunTarget = {cardId:string;nodeId?:string;resourceOverrides?:ReturnType<typeof pathResourceOverrides>}
  | {nodeId:string;operation:'ts'|'hessian'|'irc'};
type PendingPesRun = {id:string;sessionId:string|undefined;projectEpoch:string|undefined;target:PesRunTarget;admission:PesCompositionChange};
const pendingPesRuns = new WeakMap<PesController,Map<string,PendingPesRun>>();

async function pesController(ctx:SciencePesContext){
  const controller=await ctx.pes();
  if(!controller)throw toolError('UNAVAILABLE','势能面工作台尚未就绪。');
  return controller;
}

function newGroup(controller:PesController,source:AdvancedFrameSource) {
  const geometry=sourceGeometry(source);
  if(geometry.structure.dimension===2||geometry.structure.periodicSource?.completeness==='partial')
    throw toolError('INVALID_ARGUMENT','势能面计算需要真实三维结构和完整周期晶胞。');
  return controller.createGroup(geometry,undefined,{constraints:source.constraints});
}

async function configurePath(ctx:SciencePesContext,controller:PesController,args:Record<string,unknown>,algorithm:string,call?:McCall,batchLevel?:PesMethodDraft){
  const electronic=electronicOptions(args.electronic);
  const start=await ctx.resolveSource(args.start,call?.signal,electronic),end=await ctx.resolveSource(args.end,call?.signal,electronic);
  const reactant=sourceGeometry(start),product=pathProduct(start,end,args);
  if(args.electronic===undefined&&(start.structure.charge!==end.structure.charge||start.structure.multiplicity!==end.structure.multiplicity))
    throw toolError('INVALID_ARGUMENT','端点的电荷或多重度不同，请明确指定本次统一电子态。');
  electronicValues(reactant,args.electronic);
  const group=args.groupId===undefined?undefined:groupRecord(controller,args.groupId);
  const currentMethod=batchLevel??group?.sharedMethod??controller.defaultCalculationLevel(),periodic=isPeriodic(start.structure);
  const patch=methodPatch(args.method,currentMethod,periodic),method=patch.method??currentMethod.method;
  const resourceOverrides=pathResourceOverrides(args.resourceOverrides);
  if(resourceOverrides&&!['ci-neb','fsm'].includes(algorithm))
    throw toolError('INVALID_ARGUMENT','xTB 批量并行数仅适用于 xTB CI-NEB 或 FSM。');
  if(method==='gxtb')throw toolError('INVALID_ARGUMENT','本工程选用 g-xTB。此势能面入口尚未支持该方法。');
  if(periodic&&!periodicPesOperationAvailable(method,'path',algorithm))throw toolError('INVALID_ARGUMENT','所选计算级别未开放该周期路径入口。');
  const previous=group?.cards.find(card=>card.kind==='path'&&card.algorithm===algorithm)??group?.cardDrafts?.[algorithm];
  const parameters=settings(algorithm,previous?.parametersByAlgorithm[algorithm]??defaultParameters(algorithm),args.parameters,method,periodic);
  call?.signal.throwIfAborted();
  const owned=group??newGroup(controller,start);
  const card=controller.selectCalculationCard(owned.id,'path',algorithm);
  recordEndpoint(controller,owned.id,card,'reactant',reactant);
  recordEndpoint(controller,owned.id,card,'product',product.geometry);
  controller.updateCard(owned.id,card.id,current=>({...current,mappings:{...current.mappings,product:product.atomMapping},
    parametersByAlgorithm:{...current.parametersByAlgorithm,[algorithm]:parameters}}));
  if(!batchLevel&&Object.keys(patch).length)controller.updateSharedMethod(owned.id,patch);
  const current=groupRecord(controller,owned.id);
  confirm(controller,owned.id,cardSource(current,current.cards[0]),args.electronic);
  return {groupId:owned.id,cardId:card.id,runMethod:batchLevel?{...currentMethod,...patch}:undefined,resourceOverrides};
}

export function pesTools(ctx:SciencePesContext):McTool[]{
  return [{
    name:'es_pes_groups',description:'List live PES workspaces, native calculation cards and result node identities.',
    inputSchema:objectSchema({groupId:{type:'string'}}),
    async call(args){
      const controller=await pesController(ctx);
      const receipt=(group:PesGroup)=>publicGroup(group,controller.nodeGeometry(group.id,group.activeNodeId));
      return args.groupId===undefined?{groups:controller.getSnapshot().groups.map(receipt)}:receipt(groupRecord(controller,args.groupId));
    },
  },{
    name:'es_pes_parameters',description:'Read supported native PES parameters, defaults and units without opening a card or starting a calculation. Use ci-neb, sella-irc or numeric for CI-NEB, IRC or numeric Hessian respectively.',
    inputSchema:objectSchema({algorithm:{enum:pesParameterAlgorithms},method:{enum:pesMethods}},['algorithm']),
    call(args){
      const algorithm=oneOf(args.algorithm,pesParameterAlgorithms,'algorithm');
      if(!algorithm)throw toolError('INVALID_ARGUMENT','请指定势能面算法。');
      const method=oneOf(args.method,pesMethods,'method')??defaultPesMethod().method;
      return publicParameters(algorithm,method);
    },
  },{
    name:'es_pes_mode_read',description:'Read one native same-frame Hessian mode from a settled PES run. Use the one-based mode and exact frameId returned under es_run_read.hessian. Returns signed frequency and the Cartesian direction in stable atom order. The direction has arbitrary sign and does not set the amplitude. No calculation is started.',
    inputSchema:objectSchema({runId:{type:'string'},mode:{type:'integer',minimum:1},frameId:{type:'string'}},['runId','mode']),
    async call(args,call){
      const controller=await pesController(ctx),runId=textValue(args.runId,'runId');
      const mode=integer(args.mode,'mode',1);
      if(mode===undefined)throw toolError('INVALID_ARGUMENT','需要从 1 开始的原生模态编号。');
      const frameId=args.frameId===undefined?undefined:textValue(args.frameId,'frameId');
      call?.signal.throwIfAborted();
      const run=pesRuns(controller).find(row=>row.request.runIdentity.runId===runId);
      if(!run)throw toolError('TARGET_MISSING','Hessian 所属运行已关闭或不属于当前项目。',{runId});
      const read={tool:'es_run_read',arguments:{runId}};
      if(['starting','running','stopping'].includes(run.status))
        return {runId,status:'unavailable',reason:'run-not-settled',next:read};
      const receipt=pesHessianMode(run,mode,frameId);
      return {runId,groupId:run.request.runIdentity.groupId,nodeId:run.nodeId,...receipt,...(receipt.status==='unavailable'?{next:read}:{})};
    },
  },{
    name:'es_pes_configure',description:'Configure a native PES card or operation without running it. Use live model or frame refs for path endpoints and stable atom IDs for scan axes. The second atom of an angle is its vertex. Check axisCoordinates for the configured atom order and vertex. With groupId, nodeId identifies the PES node whose q/M is being confirmed. Submit a scan with the same explicit nodeId or use the frame actually displayed at submission. Use target to create a new PES workspace. Read parameters and defaults from es_pes_parameters.',
    inputSchema:objectSchema({groupId:{type:'string'},operation:{enum:['path','scan','ts','hessian','irc']},algorithm:{type:'string'},target:targetSchema,nodeId:{type:'string'},
      ...pathSchema,axes:{type:'array',minItems:1,maxItems:2,items:axisSchema},reaction:objectSchema(expressionFields,['coordinates']),
      hessianStepBohr:{type:'number',exclusiveMinimum:0},...presentationFields},['operation']),
    async call(args,call){
      if(Object.hasOwn(args,'netGpuBatchLimit'))
        throw toolError('INVALID_ARGUMENT','势能面配置不接受 netGpuBatchLimit 参数。',{field:'netGpuBatchLimit',submitted:false});
      const operation=oneOf(args.operation,['path','scan','ts','hessian','irc'],'operation');
      if(!operation)throw toolError('INVALID_ARGUMENT','请选择势能面操作。');
      const mode=presentationMode(args);
      const controller=await pesController(ctx);
      if(operation==='path'){
        const existing=args.groupId===undefined?undefined:groupRecord(controller,args.groupId);
        const prior=existing?.cards.find(card=>card.kind==='path');
        const algorithm=oneOf(args.algorithm,['ci-neb','de-gsm','fsm'],'algorithm')??prior?.algorithm??'ci-neb';
        if(existing&&args.start===undefined&&args.end===undefined){
          const previous=prior?.algorithm===algorithm?prior:existing.cardDrafts?.[algorithm];
          const inheritedSource=prior?.slots.reactant??existing.nodes.find(node=>node.id===existing.initialNodeId)!.geometry;
          const periodic=isPeriodic(inheritedSource.structure);
          const currentMethod=existing.sharedMethod??defaultPesMethod(),patch=methodPatch(args.method,currentMethod,periodic),method=patch.method??currentMethod.method;
          if(periodic&&!periodicPesOperationAvailable(method,'path',algorithm))throw toolError('INVALID_ARGUMENT','所选计算级别未开放该周期路径入口。');
          const parameters=settings(algorithm,previous?.parametersByAlgorithm[algorithm]??defaultParameters(algorithm),args.parameters,method,periodic);
          call?.signal.throwIfAborted();
          const card=controller.selectCalculationCard(existing.id,'path',algorithm);
          controller.updateCard(existing.id,card.id,current=>({...current,
            parametersByAlgorithm:{...current.parametersByAlgorithm,[algorithm]:parameters}}));
          if(Object.keys(patch).length)controller.updateSharedMethod(existing.id,patch);
          if(args.electronic!==undefined){
            const current=groupRecord(controller,existing.id);
            confirm(controller,existing.id,cardSource(current,current.cards[0]),args.electronic);
          }
          const current=groupRecord(controller,existing.id);
          const source=current.cards[0]?.slots.reactant??controller.nodeGeometry(current.id,current.initialNodeId);
          return presentConfiguration(ctx,current,existing.activeNodeId,card.id,mode,call,source);
        }
        if(args.start===undefined||args.end===undefined)throw toolError('INVALID_ARGUMENT','请指定两个端点。');
        const configured=await configurePath(ctx,controller,args,algorithm,call);
        const group=groupRecord(controller,configured.groupId);
        return presentConfiguration(ctx,group,group.activeNodeId,configured.cardId,mode,call,cardSource(group,group.cards[0]));
      }
      if(operation!=='scan'&&args.target!==undefined&&args.groupId!==undefined)
        throw toolError('INVALID_ARGUMENT','现有势能面工作区请使用其实际节点。若要使用其他来源，请新建势能面组。');
      const group=args.groupId===undefined?undefined:groupRecord(controller,args.groupId);
      const source=group===undefined?await ctx.resolveSource(args.target,call?.signal,electronicOptions(args.electronic)):undefined;
      const requestedNodeId=args.nodeId===undefined?group?.activeNodeId:textValue(args.nodeId,'nodeId');
      const scanCard=operation==='scan'?group?.cards.find(card=>card.kind==='scan'):undefined;
      const scanDraft=scanCard??(operation==='scan'&&group?scanCardDraft(group):undefined);
      const geometry=source?sourceGeometry(source):operation==='scan'&&args.nodeId===undefined
        ? ctx.readPesScanGeometry?.(group!.id)??workbenchGeometry(ctx,controller,group!,requestedNodeId!,scanCard?.id)
        : workbenchGeometry(ctx,controller,group!,requestedNodeId!,scanCard?.id);
      if(!geometry)throw toolError('TARGET_MISSING','当前势能面输入节点已关闭或帧尚未准备。');
      const periodic=isPeriodic(geometry.structure),currentMethod=group?.sharedMethod??controller.defaultCalculationLevel();
      const patch=methodPatch(args.method,currentMethod,periodic),method=patch.method??currentMethod.method;
      if(method==='gxtb')throw toolError('INVALID_ARGUMENT','本工程选用 g-xTB。此势能面入口尚未支持该方法。');
      const algorithm=operation==='scan'?oneOf(args.algorithm,Object.keys(PES_ALGORITHMS.scan),'algorithm')??scanDraft?.algorithm??PES_DEFAULT_SCAN_ALGORITHM:
        operation==='ts'?oneOf(args.algorithm,Object.keys(PES_ALGORITHMS.ts),'algorithm')??group?.ts.algorithm??'prfo':undefined;
      const effectiveAlgorithm=operation==='scan'?effectivePesScanAlgorithm(algorithm!,periodic):operation==='hessian'?'numeric':operation==='irc'?'sella-irc':algorithm!;
      if(args.algorithm!==undefined&&algorithm===undefined&&args.algorithm!==effectiveAlgorithm)
        throw toolError('INVALID_ARGUMENT',`本操作使用固定算法 ${effectiveAlgorithm}。`,
          {operation,algorithm:effectiveAlgorithm,field:'algorithm',configurationChanged:false,submitted:false,
            recovery:{tool:'es_pes_parameters',arguments:{algorithm:effectiveAlgorithm,method}}});
      if(operation==='scan'&&args.algorithm!==undefined&&effectiveAlgorithm!==algorithm)throw toolError('INVALID_ARGUMENT','该周期扫描请使用 L-BFGS 或 FIRE2。');
      if(periodic&&!periodicPesOperationAvailable(method,operation,effectiveAlgorithm))throw toolError('INVALID_ARGUMENT','所选计算级别未开放该周期计算入口。');
      const prior=operation==='scan'&&algorithm?scanDraft?.parametersByAlgorithm[effectiveAlgorithm]
        ??group?.cardDrafts?.[effectiveAlgorithm]?.parametersByAlgorithm[effectiveAlgorithm]??scanDraft?.parametersByAlgorithm[algorithm]:
        operation==='ts'&&algorithm?group?.ts.parametersByAlgorithm[algorithm]:undefined;
      const parameters=algorithm?settings(effectiveAlgorithm,prior??defaultParameters(effectiveAlgorithm),args.parameters,method,periodic):undefined;
      const irc=operation==='irc'?ircSettings(args.parameters):undefined;
      if(operation==='hessian'&&args.parameters!==undefined)throw toolError('INVALID_ARGUMENT','请在顶层用 hessianStepBohr 设置数值 Hessian 步长。',
        {field:'hessianStepBohr',configurationChanged:false,submitted:false,recovery:{tool:'es_pes_parameters',arguments:{algorithm:'numeric',method}}});
      const hessianStep=operation==='hessian'||operation==='irc'?positive(args.hessianStepBohr,'hessianStepBohr'):undefined;
      const reaction=operation==='ts'&&args.reaction!==undefined?expressionDraft(args.reaction,'reaction'):undefined;
      let requestedAxes:PesCard['axes']|undefined,requestedDimension:1|2|undefined;
      if(operation==='scan'&&args.axes!==undefined){
        if(!Array.isArray(args.axes)||![1,2].includes(args.axes.length))throw toolError('INVALID_ARGUMENT','扫描需要一或两个轴。');
        const templates=(scanDraft??defaultPesCard('scan','scan')).axes;
        requestedDimension=args.axes.length as 1|2;
        requestedAxes=[scanAxis(templates[0],args.axes[0],0),requestedDimension===2?scanAxis(templates[1],args.axes[1],1):templates[1]];
      }
      const electronic=args.electronic??(group?pesElectronicConfirmation(group,geometry):undefined);
      const confirmed=electronicValues(geometry,electronic);
      call?.signal.throwIfAborted();
      const owned=group??newGroup(controller,source!);
      const nodeId=geometry.source?.nodeId??requestedNodeId??owned.initialNodeId;
      const inputGeometry=group?geometry:controller.nodeGeometry(owned.id,nodeId)??geometry;
      if(!group||args.electronic!==undefined)controller.confirmElectronic(owned.id,inputGeometry,confirmed,args.electronic!==undefined);
      let configuredCardId:string|undefined;
      if(operation==='scan'){
        const card=scanCard??controller.selectCalculationCard(owned.id,'scan');
        configuredCardId=card.id;
        const axes:PesCard['axes']=requestedAxes?[{...requestedAxes[0],id:card.axes[0].id},
          requestedDimension===2?{...requestedAxes[1],id:card.axes[1].id}:card.axes[1]]:card.axes;
        const dimension=requestedDimension??card.dimension;
        controller.updateCard(owned.id,card.id,current=>({...current,axes,dimension,algorithm:effectiveAlgorithm,
          ...(args.axes!==undefined?{scanCoordinates:undefined,scanCoordinateDrafts:undefined,scanCoordinateOrder:undefined}:{}),
          parametersByAlgorithm:{...current.parametersByAlgorithm,[effectiveAlgorithm]:parameters!}}));
      }else{
        if(operation==='ts'){
          controller.initializeTsSource(owned.id,nodeId,geometry);
          controller.updateTs(owned.id,draft=>({...draft,algorithm:effectiveAlgorithm,...(reaction?{reaction}:{}),
            ...(isSellaTsAlgorithm(effectiveAlgorithm)&&typeof parameters?.coordinateSystem==='string'&&['xyz','ric'].includes(parameters.coordinateSystem)?
              {sellaCoordinateSystem:parameters.coordinateSystem as 'xyz'|'ric'}:{}),
            parametersByAlgorithm:{...draft.parametersByAlgorithm,[effectiveAlgorithm]:parameters!}}));
        }
        if(irc)controller.updateIrc(owned.id,irc);
        if(hessianStep!==undefined)controller.setHessianStep(owned.id,hessianStep);
      }
      if(Object.keys(patch).length)controller.updateSharedMethod(owned.id,patch);
      const current=groupRecord(controller,owned.id);
      const receipt=await presentConfiguration(ctx,current,nodeId,configuredCardId,mode,call,inputGeometry);
      const next=receipt.input?.electronicConfirmed
        ? {tool:'es_pes_run',arguments:{groupId:owned.id,...(configuredCardId?{cardId:configuredCardId,nodeId}:{operation,nodeId})}}
        : electronicConfirmationStep(current,inputGeometry,operation,nodeId);
      const scan = current.cards.find(card => card.id === configuredCardId && card.kind === 'scan');
      return {...receipt,...(scan?{axisCoordinates:scanAxisCoordinates(scan.axes.slice(0,scan.dimension),inputGeometry)}:{}),next};
    },
  },{
    name:'es_pes_run',description:'Submit a configured native PES card or a TS, numeric Hessian or IRC operation on an explicitly identified node. A scan uses the submitted frame of an explicit nodeId, or the frame actually displayed in its PES workspace when nodeId is omitted. If CONFIRMATION_REQUIRED is returned, ask the user for permission to start in a new PES group. Use the returned retry arguments only after explicit user approval.',
    inputSchema:objectSchema({groupId:{type:'string'},cardId:{type:'string'},nodeId:{type:'string'},operation:{enum:['ts','hessian','irc']},
      confirmationId:{type:'string',description:'One-use ID returned for this exact submission. Supply only after the user approves starting a new PES group.'},
      resourceOverrides:pathResourceOverrideSchema,
      ...presentationFields},['groupId']),
    async call(args,call){
      const controller=await pesController(ctx),group=groupRecord(controller,args.groupId);
      call?.signal.throwIfAborted();
      requirePesMethod((group.sharedMethod??defaultPesMethod()).method);
      let target:PesRunTarget;
      const resourceOverrides=pathResourceOverrides(args.resourceOverrides);
      if(args.cardId!==undefined||args.operation===undefined){
        if(args.operation!==undefined)
          throw toolError('INVALID_ARGUMENT','请使用计算卡标识，或指定工作台操作与节点。');
        const cardId=args.cardId===undefined?group.cards[0]?.id:textValue(args.cardId,'cardId');
        if(!cardId)throw toolError('TARGET_MISSING','没有可运行的计算卡。');
        const nodeId=args.nodeId===undefined?undefined:textValue(args.nodeId,'nodeId');
        if(nodeId&&group.cards.find(card=>card.id===cardId)?.kind!=='scan')
          throw toolError('INVALID_ARGUMENT','只有扫描卡可指定来源 nodeId，路径卡使用记录的端点。',{groupId:group.id,cardId,nodeId,submitted:false});
        target={cardId,...(nodeId?{nodeId}:{}),...(resourceOverrides?{resourceOverrides}:{})};
      }else{
        if(resourceOverrides)throw toolError('INVALID_ARGUMENT','xTB 批量并行数仅适用于 xTB CI-NEB 或 FSM。');
        const operation=oneOf(args.operation,['ts','hessian','irc'],'operation')!;
        const nodeId=args.nodeId===undefined?group.activeNodeId:textValue(args.nodeId,'nodeId');
        target={nodeId,operation};
      }
      let pending=pendingPesRuns.get(controller);
      if(!pending)pendingPesRuns.set(controller,pending=new Map());
      for(const id of pending.keys())if(!controller.getSnapshot().groups.some(row=>row.id===id))pending.delete(id);
      const sessionId=call?.session.id,projectEpoch=call?.presentationOrigin?.projectEpoch;
      let node:PesNode;
      if(args.confirmationId!==undefined){
        const id=textValue(args.confirmationId,'confirmationId'), plan=pending.get(group.id);
        if(!plan||plan.id!==id||plan.sessionId!==sessionId||plan.projectEpoch!==projectEpoch||JSON.stringify(plan.target)!==JSON.stringify(target))
          throw toolError('STALE_TARGET','确认已失效。请用当前计算目标重新提交并取得确认。');
        pending.delete(group.id);
        try{node=plan.admission.continueInNewGroup();}
        catch(cause){
          if(cause instanceof PesSubmissionChanged)throw toolError('STALE_TARGET',cause.message);
          throw cause;
        }
      }else{
        try{
          if('cardId' in target){
            const card=group.cards.find(row=>row.id===target.cardId);
            if(!card)throw toolError('TARGET_MISSING','该计算卡已不存在。',{
              groupId:group.id,cardId:target.cardId,submitted:false,next:{tool:'es_pes_groups',arguments:{groupId:group.id}},
            });
            const readScan=card.kind==='scan'?()=>{
              if(target.nodeId)return workbenchGeometry(ctx,controller,group,target.nodeId,card.id);
              const source=controller.currentScanGeometry(group.id,ctx.readPesScanGeometry&&(()=>ctx.readPesScanGeometry!(group.id)));
              if(!source)throw unavailableFrame(group.id,groupRecord(controller,group.id).activeNodeId,card.id);
              return source;
            }:undefined;
            const source=cardSource(group,card,readScan?.());
            if(card.kind!=='explore')requireRunElectronic(group,source,card.kind,source.source?.nodeId??target.nodeId,card.id);
            node=controller.startCard(group.id,target.cardId,undefined,readScan,undefined,target.resourceOverrides);
          }
          else{
            const geometry=workbenchGeometry(ctx,controller,group,target.nodeId);
            requireRunElectronic(group,geometry,target.operation,target.nodeId);
            node=controller.startWorkbench(group.id,target.nodeId,geometry,target.operation);
          }
          if(pending.get(group.id)?.sessionId===sessionId)pending.delete(group.id);
        }catch(cause){
          if(!(cause instanceof PesCompositionChange))throw cause;
          const confirmationId=crypto.randomUUID();
          pending.set(group.id,{id:confirmationId,sessionId,projectEpoch,target,admission:cause});
          throw toolError('CONFIRMATION_REQUIRED',cause.message,{
            action:'start-in-new-pes-group',groupId:cause.groupId,atomCount:cause.atomCount,existingAtomCounts:cause.existingAtomCounts,
            conflictingResults:cause.conflictingResults,
            retry:{groupId:group.id,...target,confirmationId,...(args.presentation===undefined?{}:{presentation:args.presentation})},
          });
        }
      }
      return presentScienceRun(ctx,startReceipt(controller,ctx,node),args,call);
    },
  },{
    name:'es_ci_neb_batch',description:'Start independent native CI-NEB runs for model/frame pairs. Use parameters.beads (includes both ends), parameters.nebIterations and parameters.recordInterval. Read es_pes_parameters for more. Check counts and items: rejected members do not start a run or discard valid pairs.',
    inputSchema:objectSchema({pairs:{type:'array',minItems:1,items:ciNebPairSchema},...presentationFields},['pairs']),
    argumentValidationSchema:objectSchema({pairs:{type:'array',minItems:1},...presentationFields},['pairs']),
    async call(args,call){
      const controller=await pesController(ctx);
      if(!Array.isArray(args.pairs)||!args.pairs.length)throw toolError('INVALID_ARGUMENT','请提供至少一对双端点。');
      const items=[];
      let first:ReturnType<typeof startReceipt>|undefined;
      const batchLevel=controller.defaultCalculationLevel();
      for(const [index,item] of args.pairs.entries()){
        let configured:Awaited<ReturnType<typeof configurePath>>|undefined;
        try{
          call?.signal.throwIfAborted();
          checkToolArguments(ciNebPairSchema,item,`arguments.pairs[${index}]`);
          configured=await configurePath(ctx,controller,record(item,'pair'),'ci-neb',call,batchLevel);
          const receipt=startReceipt(controller,ctx,controller.startCard(configured.groupId,configured.cardId,undefined,undefined,configured.runMethod,configured.resourceOverrides));
          first??=receipt;items.push({index,...receipt});
        }catch(cause){
          const detail=cause as {code?:string;data?:unknown}|null;
          items.push({index,...(configured?{groupId:configured.groupId,cardId:configured.cardId}:{}),status:call?.signal.aborted?'cancelled':'rejected',error:cause instanceof Error?cause.message:String(cause),
            code:detail?.code??(call?.signal.aborted?'cancelled':'PES_PAIR_REJECTED'),data:detail?.data});
        }
      }
      const focused=first&&await presentScienceRun(ctx,first,args,call);
      const counts=batchCounts(args.pairs.length,items);
      return {status:counts.cancelled?'interrupted':counts.failed?'partial':'complete',counts,items,
        ...(focused&&'presentation' in focused?{presentation:focused.presentation}:{})};
    },
  }];
}

export function pesRuns(controller:PesController|undefined):PesRun[]{
  return controller?.getSnapshot().groups.flatMap(group=>Object.values(group.runs))??[];
}
