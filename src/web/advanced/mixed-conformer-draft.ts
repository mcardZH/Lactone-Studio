import type { AdvancedFrameSource } from "../../modeling/advanced/frame-source";
import type {
	AdvancedMixedSamplingDefinition,
	AdvancedOptimizationStageConfig,
	AdvancedTaskRecord,
	AdvancedTaskSpec
} from "../../modeling/advanced/contracts";
import {
	allocateConformerTorsionPoints,
	conformerTorsionCombinationCount,
	createConformerSnapshot,
	discoverConformerTorsionRows,
	inspectConformerTorsion,
	inspectManualConformerTorsion,
	type TorsionAtoms
} from "../../modeling/conformers";
import { convertEnergy } from "../../results/energy";
import {
	changeSamplingOperation,
	compileSampling,
	initialSamplingDraft,
	type SamplingDraft
} from "./process-config";
import { initialAdvancedMethod, compileAdvancedMethod } from "./AdvancedMethodControls";
import { restoreConformerStages, restoreConformerTaskDraft } from "./conformer-draft-hydration";
import type { ConformerOptimizationDraft } from "./ConformerOptimizationStages";
import type { ConformerTorsionDraft } from "./ConformerTorsionControls";
import {conformerSolvationDraftIssue} from './conformer-solvation-draft';

export type MixedSamplingChoice = "md" | "metadynamics" | "conformer-search";
export const MIXED_SAMPLING_CHOICES = [
	{ id: "md", label: "高温 MD" },
	{ id: "metadynamics", label: "Metadynamics" },
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
		method: { ...initialAdvancedMethod, maxSteps: 500 },
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
	deduplicationEnabled: true
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
export function compileMixedStages(
	stages: readonly ConformerOptimizationDraft[],
	threads: number
): AdvancedOptimizationStageConfig[] {
	return stages.map((stage,index) => {
		const solventIssue=conformerSolvationDraftIssue(stage.method.method,stage.method);if(solventIssue)throw Error(solventIssue);
		if(index&&(!Number.isSafeInteger(stage.inputClusterCount??10)||(stage.inputClusterCount??10)<1))throw Error('选取上一级簇数须为正整数。');
		if(!Number.isSafeInteger(stage.inputStride??1)||(stage.inputStride??1)<1)throw Error('抽帧间隔须为正整数。');
		if (!Number.isFinite(stage.rmsdThresholdAngstrom) || stage.rmsdThresholdAngstrom <= 0)
			throw Error("各级归簇 RMSD 须为正数。");
		return {
			id: stage.id,
			inputStride: stage.inputStride??1,
			...(index?{inputClusterCount:stage.inputClusterCount??10}:{}),
			checkpointAfter: true,
			clustering: {
				rmsdMatching: 'fixed',
				eliminateEquivalent: stage.eliminateEquivalent===true,
				rmsdThresholdAngstrom: stage.rmsdThresholdAngstrom,
				maxDeltaEnergyHartree: convertEnergy(
					{ value: stage.energyThresholdKcalMol, unit: "kcal/mol" },
					"hartree"
				)!
			},
			method: compileAdvancedMethod({
				...stage.method,
				maxSteps: stage.method.maxSteps,
				threads: ["MMFF94", "MMFF94s", "UFF"].includes(stage.method.method) ? 1 : threads
			})
		};
	});
}
export function compileMixedDefinition(
	draft: MixedConformerDraft,
	source: AdvancedFrameSource,
	resources: { threads: number; memoryBudgetBytes: number }
): AdvancedMixedSamplingDefinition {
	const atomIssues=mixedConformerAtomConfigurationIssues(draft,source);
	if(atomIssues.core||Object.keys(atomIssues.cards).length)throw Error(atomIssues.core??Object.values(atomIssues.cards)[0]);
	if (!Number.isFinite(draft.dedupRmsdAngstrom) || draft.dedupRmsdAngstrom <= 0)
		throw Error("采样去重 RMSD 须为正数。");
	const shared = draft.shared,
		protectedSource = source;
	const definition: AdvancedMixedSamplingDefinition = {
		protectionMode:'shared-freeze',
		cards: [],
		dedupRmsdAngstrom: draft.dedupRmsdAngstrom,
		deduplicationEnabled: draft.deduplicationEnabled !== false,
		protectedAtomIds: [],
		coreProtectionEnabled:false,
	};
	for (const card of draft.cards) {
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
			if (!torsions.length) throw Error("柔性键采样至少需要一个有效柔性键。");
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

/** Preserve every stored ID/row. Invalid bindings are editing drafts until the
 * user explicitly reassigns them, never positional mappings to different atoms. */
export function mixedConformerAtomConfigurationIssues(draft:MixedConformerDraft,source:AdvancedFrameSource):{core?:string;cards:Record<string,string>}{
	const ids=new Set(source.structure.atoms.map(atom=>atom.id)),cards:Record<string,string>={};
	for(const card of draft.cards){
		if(card.kind==='metadynamics'&&(card.sampling.metaScope==='selected'||card.sampling.metaScope===undefined&&card.sampling.metaIds.length>0)&&card.sampling.metaIds.some(id=>!ids.has(id)))cards[card.id]='RMSD 偏置包含已失效原子，需重新指定；原草稿已保留。';
		if(card.kind!=='conformer-search')continue;
		for(const row of card.torsions.filter(row=>row.enabled)){
			if(row.atomIds.some(id=>!ids.has(id))){cards[card.id]='柔性键包含已失效原子，需重新指定；原草稿已保留。';break;}
			if(row.atomIds.length!==4)continue;
			try{const snapshot=createConformerSnapshot(source.structure,source.ref,source.constraints),value=(row.origin==='manual'?inspectManualConformerTorsion:inspectConformerTorsion)(snapshot,row.atomIds as TorsionAtoms);
				if(!value.accepted){cards[card.id]='柔性键已不适用于当前结构，需重新指定；原草稿已保留。';break;}}
			catch{cards[card.id]='柔性键已不适用于当前结构，需重新指定；原草稿已保留。';break;}
		}
	}
	return {cards};
}

/** A placeholder permits defining cards before any computation is requested. */
export function createMixedTaskSpec(
	source: AdvancedFrameSource,
	draft: MixedConformerDraft,
	resources: { threads: number; memoryBudgetBytes: number }
): AdvancedTaskSpec {
	return {
		kind: "sampling",
		source,
		sampling: compileSampling(
			{ ...structuredClone(initialSamplingDraft), ...resources, coreIds: [], sphereEnabled: false },
			source
		),
		mixedSampling: compileMixedDefinition(draft, source, resources),
		optimizationStages: compileMixedStages(draft.stages, resources.threads),
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
