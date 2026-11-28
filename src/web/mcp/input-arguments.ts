import type { InputDraftConfiguration, InputEngine } from './input-drafts';
import { METHODS, TASKS } from '../../core/gaussian';
import { getOrcaCommonMethods, ORCA_VERSIONS } from '../../core/orca';
import { ORCA_TASKS } from '../orca/task-catalog';
import type { McTool } from './types';

export type Schema = Record<string, unknown>;
export const string = { type: 'string' };
export const boolean = { type: 'boolean' };
export const integer = { type: 'integer' };
export const positive = { type: 'integer', minimum: 1 };
export const numeric = { type: 'number' };
export const nullable = (item: Schema) => ({ anyOf: [item, { type: 'null' }] });
export const choice = (...values: string[]) => ({ type: 'string', enum: values });
export const list = (items: Schema) => ({ type: 'array', items });
export const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: 'object', properties, required, additionalProperties: false
});
export const modelRef = { ...string, description: 'A model reference returned by ES. Omit for the bound window’s current model.' };
export const expectedDraft = { ...string, description: 'Exact draftVersion from input_draft or the last successful input write.' };

export function inputTool(name: string, description: string, schema: Schema, call: McTool['call']): McTool {
  return {name, description, inputSchema:schema, call(args, context) { validateArgs(args, schema); return call(args, context); }};
}

export function validateArgs(value: unknown, schema: Schema, label = '参数'): void {
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) {
    if (variants.some(variant => {
      try { validateArgs(value, variant, label); return true; } catch { return false; }
    })) return;
    throw Error(`${label} 的值不符合允许的格式。`);
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${label} 必须是对象。`);
    if (schema.additionalProperties === true) return;
    const entries = value as Record<string, unknown>, properties = schema.properties as Record<string, Schema>;
    for (const key of schema.required as string[]) if (!Object.hasOwn(entries, key)) throw Error(`${label} 缺少 ${key}。`);
    for (const [key, item] of Object.entries(entries)) {
      const field=Object.hasOwn(properties,key)?properties[key]:schema.additionalProperties;
      if(!field||typeof field!=='object')throw Error(`${label} 不支持 ${key}。`);
      validateArgs(item,field as Schema,`${label}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw Error(`${label} 必须是数组。`);
    for (const [index, item] of value.entries()) validateArgs(item, schema.items as Schema, `${label}[${index}]`);
  } else if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || schema.type === 'integer' && !Number.isSafeInteger(value)
      || typeof schema.minimum === 'number' && value < schema.minimum) throw Error(`${label} 数值无效。`);
  } else if (schema.type === 'null' ? value !== null : typeof value !== schema.type
    || Array.isArray(schema.enum) && !schema.enum.includes(value)) throw Error(`${label} 数值或选项无效。`);
}

const frequency = object({ raman: boolean, temperatureK: nullable(numeric), pressureAtm: nullable(numeric) });
const electronicState = object({ charge: integer, multiplicity: positive, confirmed: boolean }, ['charge', 'multiplicity', 'confirmed']);
export const solvation = { oneOf:[object({mode:choice('builtin'),id:string},['mode','id']),object({mode:choice('custom'),
  custom:object({name:string,dielectric:numeric,refractiveIndex:numeric,hydrogenBondAcidity:numeric,hydrogenBondBasicity:numeric,
    surfaceTension:numeric,aromaticity:numeric,halogenicity:numeric,opticalApproximation:choice('epsinf-1.9')},['name','dielectric'])},['mode','custom'])] };
const solvent = {...string,description:'Exact native solvent name or reviewed alias. For an exact catalog ID use settings.solvation and discover it with input_solvents.'};
const inputSolvation = {...nullable(solvation),description:'Complete native selection; use input_solvents for reviewed IDs. Null explicitly clears this field and the legacy solvent value to return to gas phase.'};
const advanced = object({scfAlgorithm:choice('default','qc','xqc'),noVarAcc:boolean,noIncFock:boolean,fermi:boolean,noDIIS:boolean,
  vshift:nullable(numeric),scfMaxCycle:nullable(positive),maxConventional:nullable(positive),optConvergence:choice('default','loose','tight','verytight'),
  maxStep:nullable(numeric),optMaxCycles:nullable(positive)});
const integration=object({grid:choice('fine','ultrafine','superfinegrid'),acc2e:positive});
const grid=choice('auto','DefGrid1','DefGrid2','DefGrid3');
const scf=object({convergence:choice('default','loose','normal','strong','tight','verytight'),strategy:choice('default','SlowConv','VerySlowConv'),
  algorithm:choice('auto','KDIIS','SOSCF','TRAH'),maxIterations:positive});

const gaussianSettings = object({
  method: choice(...METHODS.map(method => method.id)), customMethod: string, basis: string,
  dispersion: choice('gd3bj', 'gd3', 'none'), grid: choice('efficient', 'default'),
  scf: choice('default', 'conver6'), nosymm: boolean, solvent, solvation:inputSolvation, solventModel: choice('iefpcm', 'smd'), solventModelManuallySelected:boolean,unrestricted: boolean,
  use5D: boolean, integral: integration, advanced,
  xtb: object({ scriptPath: string, executable: string, level: string, entryBasis: boolean, scriptConfirmed: boolean }),
  mixedBasis:object({enabled:boolean,dForm:choice('5D','6D'),angularExplicit:boolean,
    regions:list(object({id:string,name:string,basis:string,atoms:list(positive)},['id','name','basis','atoms']))}),
  parameterDrafts:object({scf:object({enabled:boolean,advanced,scf:choice('default','conver6')}),
    integration:object({enabled:boolean,grid:choice('efficient','default'),integral:integration,gridDraft:choice('fine','ultrafine','superfinegrid'),acc2eDraft:positive,nosymm:boolean}),
    vshift:nullable(numeric),scfMaxCycle:nullable(positive),vshiftEnabled:boolean,scfMaxCycleEnabled:boolean}),
  taskOptions: object({
    frequency,
    irc: object({ maxPoints: nullable(positive), stepSize: nullable(numeric), lqa: boolean, confirmed: boolean }),
    excited: object({ nstates: nullable(positive), nstatesMode: choice('auto', 'manual'), root: positive,
      approximation: choice('td','tda','zindo'), spin: choice('default','singlets','triplets','50-50'),
      targetSpin: choice('singlets','triplets'), useUks: boolean, frequency: boolean, frequencyOnly: boolean, printCoefficients: boolean }),
    nmr: object({ mode: choice('giao','spinspin','mixed') }),
    stable: object({ optimize: boolean, confirmed: boolean }),
    fragments: list(object({ id: string, label: string, atoms: list(positive), charge: integer, multiplicity: positive, multiplicityMode: choice('auto','manual') }, ['atoms','charge','multiplicity'])),
    fragmentStatesConfirmed: boolean
  })
});
const fileSettings = object({
  saveCheckpoint: boolean, checkpointName: string, readCheckpoint: boolean, oldCheckpoint: string,
  writeMemory: {...boolean,description:'Write the explicit Gaussian %mem setting. False leaves memory to the execution environment.'},
  writeCores: {...boolean,description:'Write the explicit Gaussian %nprocshared setting. False leaves cores to the execution environment on ordinary Gaussian routes.'},
  geometry: choice('explicit','check','allcheck'),
  guessRead: boolean, hessian: choice('none','readfc','rcfc','calcfc','calcall','recalcfc'), recalcInterval: nullable(positive),
  basisFromCheckpoint: boolean, compatibilityConfirmed: boolean, sourceElements: string
});

const orcaSettings = object({
  version: choice(...ORCA_VERSIONS), method: choice(...getOrcaCommonMethods().map(method => method.id)), basis: string,
  unrestricted: boolean, pno: choice('normal','tight','loose'), grid,
  solvent, solvation:inputSolvation, solventModel: choice('cpcm','smd'), solventModelManuallySelected:boolean,nmr: choice('shielding','coupling'), stableOptimize: boolean,
  fragmentStatesConfirmed: boolean,
  fragments: list(object({ id: string, atomIds: list(string), charge: integer, multiplicity: positive, multiplicityMode: choice('auto','manual') }, ['id','atomIds','charge','multiplicity'])),
  frequency: object({ raman: boolean, temperatureK: numeric, pressureAtm: numeric }),
  optimization: object({ convergence: choice('default','loose','normal','tight','verytight'), hessian: choice('default','calc','recalc'),
    recalcInterval: positive, maxIterations: positive, maxStep: numeric }),
  excited:object({rootsMode:choice('auto','manual'),approximation:choice('td','tda','stddft','stda'),roots:positive,root:positive,
    targetSpin:choice('singlet','triplet'),useUks:boolean,frequency:boolean,frequencyOnly:boolean,soc:boolean,triplets:boolean,printCoefficients:boolean,
    energyWindowEV:numeric,selectionThresholdEh:numeric,perturbationWindowEV:numeric}),
  neb:object({variant:choice('ci-neb','neb-ts'),images:positive,freeEnds:boolean,preOptimize:boolean,interpolation:choice('sidpp','idpp','linear'),
    customConvergenceEnabled:boolean,convergence:object({convType:choice('all','cionly'),maxForceCI:numeric,rmsForceCI:numeric,turnOnCI:numeric,toleranceScale:numeric,maxIterations:positive}),
    tsConvergence:object({maxGradient:numeric,rmsGradient:numeric,energyChange:numeric,maxDisplacement:numeric,rmsDisplacement:numeric,maxIterations:positive})}),
  scf,parameterDrafts:object({scf:object({enabled:boolean,values:scf}),grid:object({enabled:boolean,value:grid})}),
  md: object({ timestepFs: nullable(numeric), steps: nullable(positive), initialTemperatureK: nullable(numeric), targetTemperatureK: nullable(numeric),
    thermostat: choice('none','csvr','nhc'), couplingTimeFs: nullable(numeric), trajectoryStride: positive, restartAssetId: string,
    activeAtomIds: list(string), taskIdentity:string,restartConfirmed: boolean, durationFs: numeric }),
  ircMaxIterations: positive, ircHessianId: string, initialOrbitalsId: string
});
const patchFields = { name: string,
  cores: {...positive,description:'Requested CPU cores. In Gaussian, enable files.writeCores to write this resource.'},
  memoryGB: { type: 'number', minimum: 0,description:'Requested memory in GB. In Gaussian, enable files.writeMemory to write this resource.' },
  resourcesConfirmed: boolean, electronicState };
const byEngine = {
  gaussian: object({ ...patchFields, engine: choice('gaussian'), task: choice(...TASKS.map(task => task.id)), settings: gaussianSettings,
    files: fileSettings, frequencyConditionsConfirmed: boolean }, ['engine']),
  orca: object({ ...patchFields, engine: choice('orca'), task: choice(...ORCA_TASKS.filter(task=>!task.pending).map(task => task.id)), settings: orcaSettings,confirmIrcStart:boolean }, ['engine'])
};
export const inputConfigurationSchema = { oneOf: Object.values(byEngine) };
export const frameInputConfigurationSchema={oneOf:Object.values(byEngine).map(schema=>{
  const {name:_name,confirmIrcStart:_irc,...properties}=schema.properties as Record<string,Schema>;
  return {...schema,properties};
})};

export function readInputConfiguration(value: unknown): InputDraftConfiguration {
  if (!value || typeof value !== 'object' || !['gaussian','orca'].includes(String((value as { engine?: unknown }).engine))) throw Error('请指定 engine 为 gaussian 或 orca。');
  validateArgs(value, byEngine[(value as {engine: InputEngine}).engine], 'configuration');
  return value as InputDraftConfiguration;
}

/** Project facts onto the published write schema without inventing defaults.
 * Invalid or private native fields remain available in parameters, never as
 * an implied write. An invalid array is omitted whole, not partially accepted. */
function writableValue(value:unknown,schema:Schema):unknown {
  if(value===undefined)return undefined;
  const variants=schema.oneOf??schema.anyOf;
  if(Array.isArray(variants)){
    for(const variant of variants){const projected=writableValue(value,variant as Schema);if(projected!==undefined)return projected;}
    return undefined;
  }
  let projected=value;
  if(schema.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
    const fields=schema.properties as Record<string,Schema>,input=value as Record<string,unknown>,output:Record<string,unknown>={};
    for(const [key,field]of Object.entries(fields)){const item=writableValue(input[key],field);if(item!==undefined)output[key]=item;}
    projected=output;
  }else if(schema.type==='array'){
    if(!Array.isArray(value))return undefined;
    const items=value.map(item=>writableValue(item,schema.items as Schema));
    if(items.some(item=>item===undefined))return undefined;
    projected=items;
  }
  try{validateArgs(projected,schema);return projected;}catch{return undefined;}
}

export function writableInputConfiguration(engine:InputEngine,parameters:Record<string,unknown>):InputDraftConfiguration {
  const settings=parameters.settings as Record<string,unknown>|undefined;
  const candidate={...parameters,engine,task:settings?.task,electronicState:{charge:parameters.charge,multiplicity:parameters.multiplicity,confirmed:parameters.electronicStateConfirmed}};
  return writableValue(candidate,byEngine[engine]) as InputDraftConfiguration;
}

const sourceBindingFields = new Set(['ircHessianId', 'initialOrbitalsId', 'restartAssetId', 'taskIdentity']);
const isConfirmation = (key: string) => /(?:^confirmed$|Confirmed$)/.test(key);

/** Same-task edits are differences. A native task or Gaussian method transition
 * resets settings before the MCP patch is applied. */
export function changedInputConfiguration(current:InputDraftConfiguration,next:InputDraftConfiguration):InputDraftConfiguration {
  if(current.engine!==next.engine)return next;
  const taskChanges = next.task !== undefined && next.task !== current.task;
  const methodChanges = next.engine === 'gaussian' && next.settings?.method !== undefined && next.settings.method !== current.settings?.method;

  function difference(before:unknown,after:unknown,keepExplicit=false):unknown {
    if(!keepExplicit&&JSON.stringify(before)===JSON.stringify(after))return undefined;
    if(after&&typeof after==='object'&&!Array.isArray(after)){
      const prior=before&&typeof before==='object'&&!Array.isArray(before)?before as Record<string,unknown>:{};
      const patch:Record<string,unknown>={};
      for(const [key,value]of Object.entries(after)){
        // A copied confirmation or source binding belongs to the previous
        // conditions. A changed binding and an explicit clear still pass through.
        const confirmed = value === true && isConfirmation(key);
        const bound = typeof value === 'string' && value !== '' && sourceBindingFields.has(key);
        if(keepExplicit&&value===prior[key]&&(confirmed||bound))continue;
        const changed=difference(prior[key],value,keepExplicit);
        if(changed!==undefined)patch[key]=changed;
      }
      // A confirmation supplied beside a changed value confirms that new
      // value within the current conditions.
      if(!keepExplicit&&Object.keys(patch).length)for(const [key,value]of Object.entries(after)){
        if(typeof value==='boolean'&&isConfirmation(key))patch[key]=value;
      }
      return Object.keys(patch).length?patch:undefined;
    }
    return after;
  }
  const patch=(difference(current,next)??{}) as Record<string,unknown>;
  // q/M and confirmation are one explicit pair in the public contract.
  if(patch.electronicState!==undefined)patch.electronicState=next.electronicState;
  if(taskChanges||methodChanges){
    const settings = difference(current.settings,next.settings,true);
    if(settings===undefined)delete patch.settings;
    else patch.settings=settings;
  }
  const settingsPatch=patch.settings as Record<string,unknown>|undefined;
  if(settingsPatch&&next.settings?.solvation!==undefined&&['solvation','solvent','solventModel'].some(key=>Object.hasOwn(settingsPatch,key)))
    settingsPatch.solvation=next.settings.solvation;
  // A legacy solvent write replaces the retained structured selection even if
  // the requested name matches the previous inactive text field.
  if(next.settings?.solvent!==undefined&&next.settings.solvation===undefined&&current.settings?.solvation!==undefined)
    patch.settings={...settingsPatch,solvent:next.settings.solvent};
  return {...patch,engine:next.engine} as InputDraftConfiguration;
}

/** Merge only fields admitted by the public configuration schema. Arrays are explicit replacements. */
export function mergeInputPatch<T extends object>(current: T, patch: Partial<T>): T {
  const result = { ...current };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key], prior = current[key];
    result[key] = (value && typeof value === 'object' && !Array.isArray(value) && prior && typeof prior === 'object' && !Array.isArray(prior)
      ? mergeInputPatch(prior, value as Partial<typeof prior>) : value) as T[keyof T];
  }
  return result;
}
