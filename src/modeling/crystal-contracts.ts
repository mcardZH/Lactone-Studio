import type { Structure, Vector3 } from "../core/types";
import type { StructureTransformCandidate } from "../core/modeling/contracts";

export type CrystalOperation =
	| "symmetry"
	| "primitive"
	| "conventional"
	| "p1"
	| "idealize"
	| "supercell"
	| "slab-terminations"
	| "slab";
export type CrystalInspectOperation = "symmetry" | "slab-terminations";
export type CrystalTransformOperation = Exclude<CrystalOperation, CrystalInspectOperation>;
export interface CrystalParameters {
	/** Cartesian matching tolerance in Angstrom. */
	symprec?: number;
	/** Degrees; -1 delegates the angle criterion to spglib. */
	angleTolerance?: number;
	matrix?: [Vector3, Vector3, Vector3];
	miller?: Vector3;
	/** Minimum repeat thickness, or equivalent hkl repeat layers. */
	thickness?: number;
	thicknessMode?: "angstrom" | "layers" | "fractional";
	/** Continuous start in the same units as thickness; boundaries are [start,end). */
	start?: number;
	/** Distance from cell bottom to the lowest atomic layer, Angstrom. */
	position?: number;
	/** Total empty gap between slab images, Angstrom. */
	vacuum?: number;
	repeat?: [number, number];
	/** Index from the corresponding slab-terminations response. */
	termination?: number;
}
export interface CrystalRequest {
	documentId: string;
	expectedRevision: number;
	operation: CrystalOperation;
	structure: Structure;
	parameters?: CrystalParameters;
}
export interface CrystalSymmetry {
	number: number;
	symbol: string;
	hallSymbol: string;
	pointGroup: string;
	symprec: number;
	angleTolerance: number;
	equivalentAtoms: { atomId: string; representativeId: string }[];
}
export interface CrystalTermination {
	index: number;
	shift: number;
	lowerElements: string[];
	upperElements: string[];
}
export interface CrystalResult {
	documentId: string;
	expectedRevision: number;
	operation: CrystalOperation;
	symmetry?: CrystalSymmetry;
	candidate?: StructureTransformCandidate;
	terminations?: CrystalTermination[];
	miller?: Vector3;
	normal?: Vector3;
	interplanarSpacing?: number;
	details?: {
		symmetry?: CrystalSymmetry | { number: 1; symbol: "P1" };
		idealized?: boolean;
		geometryUnchanged?: boolean;
		sourceVolume?: number;
		volume?: number;
		matrix?: number[][];
		multiplicity?: number;
		miller?: Vector3;
		normal?: Vector3;
		outputNormal?: Vector3;
		rotation?: number[][];
		interplanarSpacing?: number;
		termination?: CrystalTermination;
		lowerElements?: string[];
		upperElements?: string[];
		thicknessMode?: "angstrom" | "layers" | "fractional";
		requestedThickness?: number;
		start?: number;
		position?: number;
		lowerVacuum?: number;
		upperVacuum?: number;
		boundaryRule?: string;
		layerTolerance?: number;
		repeatLayers?: number;
		atomicLayers?: number;
		actualThickness?: number;
		vacuum?: number;
		repeat?: [number, number];
		completeCellRetained?: boolean;
		calculationPeriodicity?: "source-model-only";
	};
}
