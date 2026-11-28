import {isPeriodic} from '../../core/periodic';
import type { AdvancedFrameSource } from "../../modeling/advanced/frame-source";
import type {
	AdvancedMixedSamplingDefinition,
	AdvancedOptimizationMethod,
	AdvancedOptimizationStageConfig,
	AdvancedTaskRecord,
	AdvancedTaskSpec
} from "../../modeling/advanced/contracts";
import {
	allocateConformerTorsionPoints,
	conformerTorsionCombinationCount,
	createConformerSnapshot,
	discoverConformerTorsionRows,
	findRotatableTorsions,
	inspectConformerTorsion,
	inspectManualConformerTorsion,
	type TorsionAtoms,
	type TorsionRejection
} from "../../modeling/conformers";
import { convertEnergy } from "../../results/energy";
import { automaticStem } from "../../core/naming";
import {
	changeSamplingOperation,
	compileSampling,
	initialSamplingDraft,
	type SamplingDraft
} from "./process-config";
import { initialConformerStageMethod, restoreConformerTaskDraft } from "./conformer-draft-hydration";
import type { ConformerOptimizationDraft } from "./ConformerOptimizationStages";
import type { ConformerTorsionDraft } from "./ConformerTorsionControls";
import {conformerSolvationDraftIssue} from './conformer-solvation-draft';
import {DEFAULT_CONFORMER_CONVERGENCE,conformerOptimizerAvailable,defaultConformerOptimizer,validConformerOptimizer} from '../../modeling/advanced/conformer-shared-optimization';
import {isPesNetMethod} from '../../modeling/pes/contracts';
import {conformerAlpbPresets} from '../../modeling/advanced/conformer-solvation';
import {validXtbResourceOverride} from '../../modeling/resource-preferences';

export type MixedSamplingChoice = "md" | "metadynamics" | "conformer-search";
export const MIXED_SAMPLING_CHOICES = [
	{ id: "md", label: "高温 MD" },
	{ id: "metadynamics", label: "RMSD-MTD" },
	{ id: "conformer-search", label: "柔性键采样" }
] as const;
export interface MixedSamplingCardDraft {
	id: string;
	kind: MixedSamplingChoice;
	expanded: boolean;
	sampling: SamplingDraft;
	torsions: ConformerTorsionDraft[];
	targetText: string;
	activeTorsionId: string;
}
export interface MixedConformerDraft {
	cards: MixedSamplingCardDraft[];
	shared: SamplingDraft;
	stages: ConformerOptimizationDraft[];
	dedupRmsdAngstrom: number;
	deduplicationEnabled?: boolean;
}
export const defaultMixedStages = (): ConformerOptimizationDraft[] => [
	{
		id: "stage-1",
		method: { ...initialConformerStageMethod },
		energyThresholdKcalMol: 0.25,
		rmsdThresholdAngstrom: 0.1,
		rmsdMatching: 'fixed',
		eliminateEquivalent: false,
		inputStride: 1,
		checkpointAfter: true
	}
];
export const createMixedConformerDraft = (): MixedConformerDraft => ({
	cards: [],
	shared: {...structuredClone(initialSamplingDraft),coreProtectionEnabled:false},
	stages: defaultMixedStages(),
	dedupRmsdAngstrom: 0.01,
	deduplicationEnabled: false
});

export function createMixedSamplingCard(
	kind: MixedSamplingChoice,
	source: AdvancedFrameSource | null
): MixedSamplingCardDraft {
	const torsions =
		kind === "conformer-search" && source
			? allocateConformerTorsionPoints(
					discoverConformerTorsionRows(
						createConformerSnapshot(source.structure, source.ref, source.constraints)
					),
					2000
				)
			: [];
	return {
		id: crypto.randomUUID(),
		kind,
		expanded: true,
		sampling: changeSamplingOperation(
			structuredClone(initialSamplingDraft),
			kind === "conformer-search" ? "md" : kind
		),
		torsions,
		targetText: "2000",
		activeTorsionId: torsions[0]?.id ?? ""
	};
}
export function compileConformerStageMethod(draft: ConformerOptimizationDraft["method"], threads: number, periodic = false): AdvancedOptimizationMethod {
	if (isPesNetMethod(draft.method)) throw Error('此版本提供 xTB 计算，请为此构象优化级选择可用方法。');
	if (draft.retiredMethod) throw Error("请为此构象优化级重新选择计算级别。");
	if (!Number.isSafeInteger(threads) || threads < 1) throw Error("线程数须为正整数。");
	const optimizer={algorithm:draft.optimizer??defaultConformerOptimizer(draft.method,periodic,draft.convergencePreset),convergencePreset:draft.convergencePreset??DEFAULT_CONFORMER_CONVERGENCE,
		...(draft.convergencePreset==='custom'&&draft.convergenceLimits?{convergenceLimits:draft.convergenceLimits}:{})};
	if(!validConformerOptimizer(optimizer))throw Error('请填写有效的构象优化收敛限度。');
	const maxSteps=draft.maxSteps??500;
	if(!Number.isSafeInteger(maxSteps)||maxSteps<1)throw Error('最大优化步数须为正整数。');
	if(!conformerOptimizerAvailable(draft.method,periodic,optimizer.algorithm))throw Error('所选计算级别或优化算法不适用于当前体系。');
	const solvationModel=periodic||!conformerAlpbPresets(draft.method).length?'none':draft.solvationModel;
	const solventIssue=conformerSolvationDraftIssue(draft.method,{...draft,solvationModel});
	if(solventIssue)throw Error(solventIssue);
	const maxSccIterations=['gfn1','gfn2','gxtb'].includes(draft.method)?draft.sccIterationLimit:undefined;
	if(maxSccIterations!==undefined&&(!Number.isSafeInteger(maxSccIterations)||maxSccIterations<1))throw Error('SCC 迭代上限须为正整数。');
	const xtbBatchParallelism=draft.resourceOverrides?.xtbBatchParallelism;
	if(!validXtbResourceOverride(xtbBatchParallelism))throw Error('xTB 批量并行数须为正整数。');
	return { backend: "xtb", options: {
		method: draft.method, threads, maxSteps,
		...(xtbBatchParallelism===undefined?{}:{resourceOverrides:{xtbBatchParallelism}}),
		solvent: solvationModel === "none" ? "none" : draft.solvent,
		internalConstraintsConfirmed: draft.internalConstraintsConfirmed,
		...(maxSccIterations!==undefined&&draft.sccIterationLimitExplicit?{maxSccIterations}:{}),
		...(solvationModel === "none" ? {} : { solvation: { model: solvationModel, solvent: draft.solvent } })
	}, optimizer };
}
export function compileMixedStages(
	stages: readonly ConformerOptimizationDraft[],
	threads: number,
	periodic = false
): AdvancedOptimizationStageConfig[] {
	return stages.map((stage,index) => {
		if(index&&(!Number.isSafeInteger(stage.inputClusterCount??10)||(stage.inputClusterCount??10)<1))throw Error('选取上一级簇数须为正整数。');
		if(!index&&(!Number.isSafeInteger(stage.inputStride??1)||(stage.inputStride??1)<1))throw Error('抽帧间隔须为正整数。');
		if (!Number.isFinite(stage.rmsdThresholdAngstrom) || stage.rmsdThresholdAngstrom <= 0)
			throw Error("各级归簇 RMSD 须为正数。");
		if(!Number.isFinite(stage.energyThresholdKcalMol)||stage.energyThresholdKcalMol<0)throw Error('各级归簇能量差须为非负数。');
		return {
			id: stage.id,
			...(index?{inputClusterCount:stage.inputClusterCount??10}:{inputStride:stage.inputStride??1}),
			checkpointAfter: true,
			clustering: {
				rmsdMatching: 'fixed',
				eliminateEquivalent: !periodic&&stage.eliminateEquivalent===true,
				rmsdThresholdAngstrom: stage.rmsdThresholdAngstrom,
				maxDeltaEnergyHartree: convertEnergy(
					{ value: stage.energyThresholdKcalMol, unit: "kcal/mol" },
					"hartree"
				)!
			},
			method: compileConformerStageMethod(stage.method, threads, periodic)
		};
	});
}
export function compileMixedDefinition(
	draft: MixedConformerDraft,
	source: AdvancedFrameSource,
	resources: { threads: number; memoryBudgetBytes: number }
): AdvancedMixedSamplingDefinition {
	const atomIssues=mixedConformerAtomConfigurationIssues(draft,source);
	if(atomIssues.core||Object.keys(atomIssues.cards).length)
		throw new MixedConformerConfigurationError(atomIssues.core??Object.values(atomIssues.cards)[0],atomIssues.details);
	if (!Number.isFinite(draft.dedupRmsdAngstrom) || draft.dedupRmsdAngstrom <= 0)
		throw Error("采样去重 RMSD 须为正数。");
	const shared = draft.shared,
		protectedSource = source;
	const periodic=isPeriodic(source.structure);
	const definition: AdvancedMixedSamplingDefinition = {
		protectionMode:'shared-freeze',
		cards: [],
		dedupRmsdAngstrom: draft.dedupRmsdAngstrom,
		deduplicationEnabled: draft.deduplicationEnabled !== false,
		protectedAtomIds: [],
		coreProtectionEnabled:false,
	};
	for (const card of draft.cards) {
		if(periodic&&card.kind!=='md')throw Error('固定晶胞采样仅支持高温 MD。');
		if (card.kind === "conformer-search") {
			const snapshot = createConformerSnapshot(
				protectedSource.structure,
				protectedSource.ref,
				protectedSource.constraints
			);
			const torsions = card.torsions
				.filter((row) => row.enabled)
				.map((row) => {
					if (row.atomIds.length !== 4) throw Error("请为每个柔性键确认四个原子。");
					const inspected = (
						row.origin === "manual" ? inspectManualConformerTorsion : inspectConformerTorsion
					)(snapshot, row.atomIds as TorsionAtoms);
					if (!inspected.accepted) throw Error(`柔性键不可旋转：${inspected.reason}`);
					return {
						torsion: inspected.torsion,
						pointCount: row.pointCount,
						pointCountMode: row.pointCountMode
					};
				});
			if (!torsions.length) {
				const { excluded } = findRotatableTorsions(snapshot);
				throw new MixedConformerConfigurationError("柔性键采样至少需要一个有效柔性键。",
					[{ cardId: card.id, kind: card.kind, reason: "no-enabled-torsions", excluded }]);
			}
			const target = card.targetText.trim() === "" ? null : Number(card.targetText);
			const capacity = target ?? Number(BigInt(conformerTorsionCombinationCount(card.torsions)));
			if (!Number.isSafeInteger(capacity) || capacity < 1)
				throw Error("请填写有效的目标帧数，或保留可处理的撒点组合。");
			definition.cards.push({
				id: card.id,
				kind: "conformer-search",
				search: {
					torsions,
					quantity:
						target === null
							? { mode: "per-torsion", pointsPerTorsion: 3 }
							: {
									mode: "total-effective",
									targetCount: target,
									pointsPerTorsion: 3,
									automaticPointAllocation: true
								},
					samplingLimits: { maxCandidates: capacity }
				}
			});
		} else {
			const sampling = compileSampling(
				{
					...card.sampling,
					...resources,
					coreIds: [],
					coreProtectionEnabled:false,
					coreForce: shared.coreForce,
					sphereEnabled: shared.sphereEnabled,
					sphere: structuredClone(shared.sphere),
					spherePaddingAngstrom: shared.spherePaddingAngstrom
				},
				protectedSource
			);
			if (sampling.sphere) definition.sphere = structuredClone(sampling.sphere);
			if (sampling.nativeProtection)
				definition.nativeProtection = {
					...definition.nativeProtection,
					...structuredClone(sampling.nativeProtection)
				};
			definition.cards.push({ id: card.id, kind: "sampling", sampling });
		}
	}
	// Shared-freeze requests derive protection from their captured source only.
	// Old soft definitions remain in historical snapshots, never in new inputs.
	if(definition.nativeProtection){
		delete definition.nativeProtection.core;
		if(!definition.nativeProtection.core&&!definition.nativeProtection.sphere)delete definition.nativeProtection;
	}
	return definition;
}

type MixedConformerConfigurationIssue = {
	cardId: string;
	kind: MixedSamplingChoice;
	reason: TorsionRejection | 'invalid-source' | 'no-enabled-torsions';
	torsionId?: string;
	atomIds?: readonly string[];
	axisAtomIds?: readonly string[];
	excluded?: ReturnType<typeof findRotatableTorsions>['excluded'];
};

export class MixedConformerConfigurationError extends Error {
	constructor(message: string, readonly issues: readonly MixedConformerConfigurationIssue[]) { super(message); }
}

/** Preserve every stored ID/row. Invalid bindings are editing drafts until the
 * user explicitly reassigns them, never positional mappings to different atoms. */
export function mixedConformerAtomConfigurationIssues(draft:MixedConformerDraft,source:AdvancedFrameSource):{
	core?:string;cards:Record<string,string>;details:MixedConformerConfigurationIssue[];
}{
	const ids=new Set(source.structure.atoms.map(atom=>atom.id)),cards:Record<string,string>={};
	const details:MixedConformerConfigurationIssue[]=[];
	for(const card of draft.cards){
		if(card.kind==='metadynamics'&&(card.sampling.metaScope==='selected'||card.sampling.metaScope===undefined&&card.sampling.metaIds.length>0)){
			const missing=card.sampling.metaIds.filter(id=>!ids.has(id));
			if(missing.length){
				cards[card.id]='RMSD 偏置包含已失效原子，需重新指定；原草稿已保留。';
				details.push({cardId:card.id,kind:card.kind,reason:'missing-atoms',atomIds:missing});
			}
		}
		if(card.kind!=='conformer-search')continue;
		for(const row of card.torsions.filter(row=>row.enabled)){
			let reason:MixedConformerConfigurationIssue['reason']|undefined;
			if(row.atomIds.length!==4||row.atomIds.some(id=>!ids.has(id)))reason='missing-atoms';
			else try{
				const snapshot=createConformerSnapshot(source.structure,source.ref,source.constraints);
				const value=(row.origin==='manual'?inspectManualConformerTorsion:inspectConformerTorsion)(snapshot,row.atomIds as TorsionAtoms);
				if(!value.accepted)reason=value.reason;
			}catch{reason='invalid-source';}
			if(!reason)continue;
			details.push({cardId:card.id,kind:card.kind,reason,torsionId:row.id,atomIds:row.atomIds,axisAtomIds:row.atomIds.slice(1,3)});
			cards[card.id]??=reason==='closed-ring'?'柔性键中心轴位于闭环内，无法独立旋转；原草稿已保留。':
				reason==='missing-atoms'?'柔性键需要四个当前结构的有效原子；原草稿已保留。':
				'柔性键已不适用于当前结构，需重新指定；原草稿已保留。';
		}
	}
	return {cards,details};
}

/** A placeholder permits defining cards before any computation is requested. */
export function createMixedTaskSpec(
	source: AdvancedFrameSource,
	draft: MixedConformerDraft,
	resources: { threads: number; memoryBudgetBytes: number }
): AdvancedTaskSpec {
	const mixedSampling = compileMixedDefinition(draft, source, resources);
	const {seedMode:_seedMode,seedDraft:_seedDraft,...historicalSamplingSlot}=compileSampling(
		{ ...structuredClone(initialSamplingDraft), ...resources, coreIds: [], sphereEnabled: false },
		{ ...source, constraints: { frozenAtomIds: [], coordinates: [] } }
	);
	return {
		kind: "sampling",
		label: `sampling-${automaticStem(source.label)}`,
		source,
		// The top-level slot is retained for reading historical single-card tasks.
		// A mixed task validates and runs its own cards against the captured source.
		sampling: historicalSamplingSlot,
		mixedSampling,
		optimizationStages: compileMixedStages(draft.stages, resources.threads, isPeriodic(source.structure)),
		checkpointAfterSampling: true
	};
}

export function restoreMixedConformerDraft(task: AdvancedTaskRecord): MixedConformerDraft {
	const draft = createMixedConformerDraft(),
		spec = task.spec;
	if (spec.kind !== "sampling" && spec.kind !== "conformer-search") return draft;
	const restored = restoreConformerTaskDraft(spec);
	draft.shared = restored.sampling;
	draft.stages = restored.stages.length ? restored.stages : defaultMixedStages();
	const definition =
		task.mixedSampling?.draft ?? (spec.kind === "sampling" ? spec.mixedSampling : undefined);
	if (!definition) {
		if (spec.kind === "sampling")
			draft.cards = [
				{
					id: "legacy-sampling",
					kind: spec.sampling.operation === "metadynamics" ? "metadynamics" : "md",
					expanded: true,
					sampling: restored.sampling,
					torsions: [],
					targetText: "2000",
					activeTorsionId: ""
				}
			];
		else
			draft.cards = [
				{
					id: "legacy-torsion",
					kind: "conformer-search",
					expanded: true,
					sampling: structuredClone(initialSamplingDraft),
					torsions: restored.torsions,
					targetText:
						spec.search.quantity.mode === "total-effective"
							? String(spec.search.quantity.targetCount)
							: "",
					activeTorsionId: restored.torsions[0]?.id ?? ""
				}
			];
		return draft;
	}
	draft.dedupRmsdAngstrom = definition.dedupRmsdAngstrom ?? 0.01;
	draft.deduplicationEnabled = definition.deduplicationEnabled !== false;
	draft.shared = {
		...draft.shared,
		coreProtectionEnabled:definition.coreProtectionEnabled??Boolean((definition.protectedAtomIds??definition.nativeProtection?.core?.atomIds??definition.coreProtection?.atomIds??[]).length),
		coreIds: [
			...(definition.protectedAtomIds ??
				definition.nativeProtection?.core?.atomIds ??
				definition.coreProtection?.atomIds ??
				[])
		],
		coreForce:
			definition.nativeProtection?.core?.forceConstantEVPerAngstrom2 ??
			definition.coreProtection?.forceConstantEVPerAngstrom2 ??
			initialSamplingDraft.coreForce,
		sphereEnabled: !!(definition.sphere || definition.nativeProtection?.sphere)
	};
	const sphere = definition.sphere ?? definition.nativeProtection?.sphere;
	if (sphere)
		draft.shared.sphere = {
			centerAngstrom: [...sphere.centerAngstrom],
			radiusAngstrom: sphere.radiusAngstrom,
			forceConstantEVPerAngstrom2: initialSamplingDraft.sphere.forceConstantEVPerAngstrom2
		};
	draft.cards = definition.cards.map((card) => {
		const cardSpec: AdvancedTaskSpec =
			card.kind === "sampling"
				? {
						kind: "sampling",
						source: spec.source,
						sampling: card.sampling,
						optimizationStages: [],
						checkpointAfterSampling: true
					}
				: {
						kind: "conformer-search",
						source: spec.source,
						search: { ...card.search, stages: [], checkpointAfterGuesses: true }
					};
		const value = restoreConformerTaskDraft(cardSpec);
		return {
			id: card.id,
			kind:
				card.kind === "sampling"
					? card.sampling.operation === "metadynamics"
						? "metadynamics"
						: "md"
					: "conformer-search",
			expanded: true,
			sampling: value.sampling,
			torsions: value.torsions,
			targetText:
				card.kind === "conformer-search" && card.search.quantity.mode === "total-effective"
					? String(card.search.quantity.targetCount)
					: "",
			activeTorsionId: value.torsions[0]?.id ?? ""
		};
	});
	return draft;
}
