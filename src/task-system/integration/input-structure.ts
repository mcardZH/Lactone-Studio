import { parseStructures } from "../../core/parsers";
import { parseOrcaInput, referencedXyz } from "../../core/orca-readers";
import { recognizeSourceText } from "../../results/source-recognition";
import {parseGaussianSource} from '../../core/gaussian-source';
import {orcaSourceLine} from '../../core/orca/input-source';
import {gaussianScientificTasks} from '../../results/gaussian-scientific-parser';
import {orcaScientificTasks} from '../../results/orca-scientific-parser';
import type { Structure } from "../../core/types";
import type { ScientificStructure } from "../contracts";

export interface FinalInputStructureRequest {
	engineId: "gaussian" | "orca";
	inputName: string;
	finalInputText: string;
	/** Actual decoded, hash-verified frozen dependencies supplied by the host. */
	dependencies?: readonly { name: string; text: string }[];
}
export interface FinalInputStructureResult {
	structure: ScientificStructure | null;
	usedDependencies: string[];
	reason?: string;
}

export interface FinalInputTaskResult {taskKind:string|null;reason?:string}

/** Combine only task combinations already represented by the input product.
 * Unrelated requests keep their ambiguity instead of selecting one by priority. */
function finalTaskKind(tasks:readonly string[],sourceTask?:string):FinalInputTaskResult {
	const set=new Set(tasks.filter(task=>task!=='unknown').map(task=>task==='stability'?'stable':task));
	if(sourceTask==='scan')set.add('scan');
	if(!set.size)return {taskKind:null,reason:'最终输入没有可可靠识别的任务请求，未默认标为单点能。'};
	const fits=(allowed:string[])=>[...set].every(task=>allowed.includes(task));
	if(set.has('neb')&&fits(['neb','ts','opt']))return {taskKind:'neb'};
	if(set.has('scan')&&fits(['scan','opt']))return {taskKind:'scan'};
	if(set.has('ts')&&fits(['ts','opt','freq']))return {taskKind:sourceTask==='qst2'||sourceTask==='qst3'?sourceTask:'ts'};
	if(set.has('td')&&fits(['td','opt','freq']))return {taskKind:set.has('opt')||set.has('freq')?'tdopt':'td'};
	if(set.has('opt')&&set.has('freq')&&fits(['opt','freq']))return {taskKind:'optfreq'};
	if(set.size===1)return {taskKind:[...set][0]};
	return {taskKind:null,reason:'最终输入含多个不同任务请求，不能归为唯一任务类型。'};
}

/** Remove quoted data from an input-only projection; raw input bytes stay intact.
 * Syntax and task meaning remain owned by the existing G/O source readers. */
function withoutQuotedData(text:string):string {
	let quote='',result='';
	for(let index=0;index<text.length;index++){
		const char=text[index];
		if(quote){if(char===quote&&text[index-1]!=='\\')quote='';result+=char==='\n'?'\n':' ';}
		else if(char==='"'||char==="'"){quote=char;result+=' ';}else result+=char;
	}
	if(quote)throw Error('最终输入含未闭合引号，任务类型待核对。');
	return result;
}

/** Requested task from the exact final text, independent of geometry availability,
 * execution or success. Names and dependency bytes never decide task identity. */
export function identifyFinalInputTask(request:FinalInputStructureRequest):FinalInputTaskResult {
	try{
		const text=request.finalInputText;
		if(!['gaussian','orca'].includes(request.engineId)||typeof text!=='string'||!text.trim()||text.includes('\0')||text.includes('\uFFFD'))throw Error('最终输入不是可可靠读取的Gaussian/ORCA文本。');
		const identity=recognizeSourceText(text);
		if(identity.status==='conflict'||identity.format!=='unknown')throw Error('当前文本识别为其他来源格式，未猜测输入任务。');
		if(request.engineId==='gaussian'){
			const lines=text.replace(/\r\n?/g,'\n').split('\n');
			if(lines.some(line=>/^\s*--Link1--\s*$/i.test(line)))throw Error('多作业输入不能归为唯一任务类型。');
			const start=lines.findIndex(line=>/^\s*#/.test(line));if(start<0)throw Error('最终输入没有Gaussian路由，未按文件名推断任务。');
			const route:string[]=[];for(let index=start;index<lines.length&&lines[index].trim();index++)route.push(lines[index].trim());
			const source=parseGaussianSource(route.join(' '),'gjf',request.inputName),tasks=gaussianScientificTasks(source.route);
			if(source.issues.some(issue=>issue.severity==='conflict'))throw Error('最终输入来源字段冲突，任务类型待核对。');
			// A complete explicit input may carry a ModRedundant scan in its tail.
			// Failure to read geometry does not erase an independently known route task.
			let sourceTask=source.task;
			try{const structures=parseStructures(text,request.inputName+'.gjf');if(structures.length===1)sourceTask=structures[0].gaussianSource?.task??sourceTask;}catch{}
			return finalTaskKind(tasks,sourceTask);
		}
		const lines=text.replace(/\r\n?/g,'\n').split('\n').map(orcaSourceLine);
		if(lines.some(line=>/^\s*\$new_job\s*$/i.test(line)))throw Error('多作业输入不能归为唯一任务类型。');
		withoutQuotedData(lines.join('\n'));
		let coordinates=false;
		const directives=lines.filter(line=>{
			const trimmed=line.trim();
			if(trimmed.startsWith('*')){if(/^\*\s*xyzfile\b/i.test(trimmed))return false;coordinates=!coordinates;return false;}
			if(coordinates)return false;
			// These are file-data declarations, not task request directives.
			return !/^\s*%(?:base|moinp|pointcharges)\b/i.test(line);
		});
		if(!directives.some(line=>/^\s*[!%]/.test(line)))throw Error('最终输入没有ORCA请求指令，未按文件名推断任务。');
		return finalTaskKind(orcaScientificTasks(withoutQuotedData(directives.join('\n'))));
	}catch(error){return {taskKind:null,reason:error instanceof Error?error.message:'输入任务不可可靠识别。'};}
}

/** Discover only the existing ORCA reader's explicitly referenced XYZ dependencies. */
export function finalInputXyzDependencies(
	engineId: "gaussian" | "orca",
	finalInputText: string
): string[] {
	if (engineId !== "orca") return [];
	return [...new Set(referencedXyz(finalInputText))];
}

function scientificStructure(source: Structure): ScientificStructure {
	return {
		id: source.id,
		name: source.name,
		format: source.format,
		charge: source.charge,
		multiplicity: source.multiplicity,
		notes: [...source.notes],
		atoms: source.atoms.map((atom) => ({
			...(atom.id ? { id: atom.id } : {}),
			...(atom.sourceIndex === undefined ? {} : { sourceIndex: atom.sourceIndex }),
			element: atom.element,
			x: atom.x,
			y: atom.y,
			z: atom.z
		})),
		...(source.bonds
			? { bonds: source.bonds.map((bond) => ({ a: bond.a, b: bond.b, order: bond.order })) }
			: {}),
		...(source.cell
			? {
					cell: {
						vectors: structuredClone(source.cell.vectors),
						pbc: [...source.cell.pbc],
						...(source.cell.origin ? { origin: [...source.cell.origin] } : {}),
						...(source.cell.source ? { source: source.cell.source } : {})
					}
				}
			: {})
	};
}

/** A thumbnail fallback is requested-input geometry, never an adopted/observed result.
 * The host owns decoding, frozen-file SHA checks and binding this result to the exact
 * main-input/dependency identities. Unsupported inputs remain an explicit empty state.
 */
export function parseFinalInputStructure(
	request: FinalInputStructureRequest
): FinalInputStructureResult {
	const usedDependencies: string[] = [];
	try {
		const text = request.finalInputText;
		if (
			!["gaussian", "orca"].includes(request.engineId) ||
			typeof text !== "string" ||
			!text.trim() ||
			text.includes("\0") ||
			text.includes("\uFFFD")
		)
			throw new Error("最终输入不是可可靠读取的Gaussian/ORCA文本。");
		if (/^\s*(?:--Link1--|\$new_job)\s*$/im.test(text))
			throw new Error("多作业输入不能唯一指定输入缩略图。");
		const identity = recognizeSourceText(text);
		if (identity.status === "conflict" || identity.format !== "unknown")
			throw new Error("当前文本识别为其他来源格式，未猜测输入几何。");
		let structures: Structure[];
		if (request.engineId === "gaussian") {
			// Engine/role is explicit. The suffix selects the existing GJF reader only;
			// it cannot turn an XYZ/output or a current UI model into Gaussian input.
			structures = parseStructures(text, request.inputName + ".gjf");
			if (
				structures.some(
					(structure) =>
						!structure.gaussianSource || /\bqst[23]\b/i.test(structure.sourceRoute || "")
				)
			)
				throw new Error("Gaussian输入未提供唯一、受支持的显式几何。");
		} else {
			const external: Record<string, Structure[]> = {};
			for (const name of finalInputXyzDependencies(request.engineId, text)) {
				const matches = (request.dependencies || []).filter(
					(dependency) => dependency.name.toLowerCase() === name.toLowerCase()
				);
				if (matches.length !== 1) throw new Error("输入缩略图缺少唯一的已冻结XYZ依赖：" + name);
				const file = matches[0];
				if (file.text.includes("\0") || file.text.includes("\uFFFD"))
					throw new Error("XYZ依赖不是可靠UTF-8文本：" + file.name);
				const dependencyIdentity = recognizeSourceText(file.text);
				if (dependencyIdentity.format !== "xyz" || dependencyIdentity.status === "conflict")
					throw new Error("引用依赖未识别为真实XYZ：" + file.name);
				external[file.name] = parseStructures(file.text, file.name + ".xyz");
				if (external[file.name].length !== 1)
					throw new Error("XYZ依赖含多结构，不能唯一确定输入缩略图：" + file.name);
				usedDependencies.push(file.name);
			}
			structures = parseOrcaInput(text, request.inputName, external);
		}
		if (structures.length !== 1 || !structures[0].atoms.length)
			throw new Error("最终输入没有唯一完整结构，未生成输入缩略图。");
		const source = structures[0];
		if (source.periodicSource?.completeness === "partial")
			throw new Error("输入周期信息不完整，未补造晶胞或输入缩略图。");
		if (source.atoms.some((atom) => ![atom.x, atom.y, atom.z].every(Number.isFinite)))
			throw new Error("输入坐标包含非有限数值。");
		return { structure: scientificStructure(source), usedDependencies };
	} catch (error) {
		return {
			structure: null,
			usedDependencies: [],
			reason: error instanceof Error ? error.message : "输入几何不可可靠读取。"
		};
	}
}
