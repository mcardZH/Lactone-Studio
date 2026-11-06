/** Renderer application DTOs. Domain/protocol modules must never import this file. */
import type {
	Run,
	Operation,
	ExecutionReceipt,
	InputSnapshot,
	ScientificState,
	PosixStopDisposition,
	TaskOrigin,
	TaskLocation,
	TaskThumbnail,
	SourceBoundary,
	ManagedSourceOrigin,
	SiteProfile,
	OperationState,
	CalculationScript,
	CalculationScriptIdentity,
	ManagedSourceSummaryView,
	ScientificStructure
} from "./contracts";
import type { TrajectoryResult } from "../results/contracts";
export type {
	ManagedSourceOrigin,
	CalculationScript,
	CalculationScriptIdentity,
	ManagedSourceSummaryView
} from "./contracts";
export type TaskCategory =
	"all" | "active" | "unverified" | "completed" | "failed" | "archived" | "recycle" | "ungrouped";
export type TaskBatchAction =
	| "group"
	| "stop"
	| "archive"
	| "cleanup"
	| "cleanup-archive"
	| "delete-task"
	| "recycle"
	| "restore";
/** Host-derived logical-run stop capability. UI management permission remains separate. */
export interface TaskStopControlView {
	canRequest: boolean;
	pending: boolean;
	targets: ("execution" | "result-preparation")[];
	reason?: string;
}
export interface TaskCardView {
	taskId: string;
	runId: string | null;
	displayName: string;
	engineId: string;
	taskKind: string;
	formula: string | null;
	createdAt: string;
	environmentId: string;
	environmentName: string;
	connectionKind: "local" | "wsl" | "ssh";
	schedulerKind: "none" | "slurm";
	/** Absent on legacy records: retain their recorded location semantics. */
	directoryMode?: "single" | "dual";
	workFileState?: "present" | "cleared" | "unknown";
	lastSubmittedAt?: string;
	archiveState?: "archived" | "unarchived" | "archiving" | "cleared" | "failed";
	failureKind?: "submission" | "execution" | "verification" | null;
	resultLimited?: boolean;
	resultLimitReason?: string | null;
	groupId: string | null;
	executionState: string;
	/** Optional for older view payloads; a preparation owner can outlive native execution. */
	stopControl?: TaskStopControlView;
	verificationState: string;
	checkedAt: string | null;
	endReason?: string;
	nativeEndReason?: string;
	nativeExitCode?: number | null;
	stopDisposition?: PosixStopDisposition;
	archived: boolean;
	recycled: boolean;
	workPath: string | null;
	archivePath: string | null;
	/** Actual current SourceSet location; never an invented execution work directory. */
	sourcePath?: string | null;
	groupIds?: string[];
	origin?: TaskOrigin;
	noRun?: boolean;
	sourceSetId?: string | null;
	sourceVersion?: string;
	locations?: TaskLocation[];
	thumbnail?: TaskThumbnail | null;
	sourceSummary?: ManagedSourceSummaryView | null;
	thumbnailStructure?: ScientificStructure | null;
	thumbnailSourceVersion?: string;
	resourceSummary?: {
		cpuLabel: string;
		cpuValue: number | null;
		memoryValue: string | null;
		memoryUnit: string | null;
		memoryScope: string | null;
	};
	elapsedSeconds?: number | null;
}
export interface TaskGroupView {
	groupId: string;
	parentGroupId: string | null;
	displayName: string;
	order?: number;
}
export interface TaskFileView {
	artifactId: string;
	name: string;
	role: string;
	size: number | null;
	checkedAt: string | null;
	verificationState: string;
	path: string;
	kind: "text" | "binary" | "unknown";
	sourceId?: string;
	sourceVersion?: string;
	sourceGeneration?: number;
	sourceIdentity?: { generation: string; revision?: string; location: string };
	previewSourceIdentity?: PreviewSourceIdentity;
	exists?: boolean | null;
	existence?: "present" | "missing" | "unknown";
	sourceKind?: "archive" | "work";
	readable?: boolean;
	readError?: string | null;
}
export interface TaskManagerView {
	access: "manager" | "readonly" | "unavailable";
	epoch: number | null;
	ownerLabel?: string;
	reason?: string;
}
export interface TaskLibraryView {
	libraryId: string | null;
	path: string | null;
	migrating: boolean;
	recycledCount: number;
	recycledBytes: number | null;
}
export interface TaskCenterView {
	manager: TaskManagerView;
	library: TaskLibraryView;
	tasks: TaskCardView[];
	groups: TaskGroupView[];
	environments: EnvironmentView[];
	monitoring: MonitoringSettings;
	siteProfiles?: SiteProfileView[];
	operations?: { operationId: string; type: string; phase: string; state: OperationState }[];
	remoteReminders?: {
		reminderId: string;
		taskId: string;
		displayName: string;
		environmentName: string;
		workPath: string | null;
		message: string;
	}[];
}
export interface MonitoringSettings {
	localIntervalSeconds: number;
	remoteIntervalSeconds: number;
	backgroundIntervalSeconds: number;
	automatic: boolean;
}
export interface EnvironmentView {
	environmentId: string;
	revision: number;
	displayName: string;
	engineId: "gaussian" | "orca";
	connectionKind: "local" | "wsl" | "ssh";
	schedulerKind: "none" | "slurm";
	host: string;
	port: number;
	user: string;
	distribution: string;
	executable: string;
	workingRoot: string;
	scratchRoot: string;
	partition: string;
	account: string;
	qos: string;
	timeLimit: string;
	initialization: string;
	scriptTemplate: string;
	/** Empty selects the supported engine/platform default calculation template. */
	calculationTemplate?: string;
	/** SSH + Slurm only; empty retains the standard managed sbatch command. */
	submitCommandTemplate?: string;
	/** Environment-level only. Site-managed leaves scheduler memory unknown. */
	slurmMemoryPolicy?: "input-request" | "site-managed";
	authentication: "agent" | "password" | "private-key";
	privateKeyPath: string;
	templateVariables?: { name: string; description: string }[];
	siteId?: string;
	siteRevision?: number;
	check?: EnvironmentCheckView;
}
export type SiteProfileView = Pick<
	SiteProfile,
	| "siteId"
	| "revision"
	| "displayName"
	| "connectionKind"
	| "host"
	| "port"
	| "user"
	| "distribution"
	| "workingRoot"
	| "schedulerKind"
	| "partition"
	| "account"
	| "qos"
	| "timeLimit"
	| "authentication"
	| "privateKeyPath"
	| "deleted"
>;
export type EnvironmentCheckFactState = "passed" | "unknown" | "failed";
export interface EnvironmentCheckView {
	state: "passed" | "limited" | "failed";
	fingerprint: string;
	checkedAt: string;
	connection: EnvironmentCheckFactState;
	entry: EnvironmentCheckFactState;
	family: { state: EnvironmentCheckFactState; engineId: "gaussian" | "orca" | null };
	version: { state: "known" | "unknown"; value: string | null };
	execution: "not-tested";
	evidenceKind: "pe-metadata" | "embedded-strings" | "command-output" | "mixed" | "unknown";
}
export interface EnvironmentDocumentPreservation {
	envelopeExtensions: Record<string, unknown>;
	environmentExtensions: Record<string, unknown>;
}
export interface EnvironmentImportPreview {
	environment: EnvironmentView;
	preserved: EnvironmentDocumentPreservation;
	requiredCapabilities: string[];
	changes: { field: string; value: string | number }[];
}
export interface EnvironmentBrowseResult {
	domain: "local" | "wsl" | "ssh";
	path: string;
	entries: { name: string; kind: "file" | "directory" | "link" | "other" }[];
	parentPath?: string;
	selected?: string;
}
/** Secret lifetime belongs to one request; never persist/export this as environment configuration. */
export interface EnvironmentSecretPayload {
	password?: string;
	privateKeyPassphrase?: string;
	remember: boolean;
}
export interface HostKeyChallenge {
	challengeId: string;
	host: string;
	algorithm: string;
	fingerprint: string;
	state: "unknown" | "changed";
}
export interface ResourceSummaryView {
	label: string;
	value: string;
	source: string;
}
export interface SubmitDependencyView {
	name: string;
	sourceRef: string;
	role: string;
	size: number | null;
}
export interface SnapshotLeaseView {
	snapshotId: string;
	leaseId: string;
}
export interface SnapshotDescriptionView extends SnapshotLeaseView {
	taskId: string;
	runId: string | null;
	sourceSetId?: string;
	sourceVersion?: string;
	libraryId: string;
	contentIdentity: { algorithm: string; hash: string | null };
	preparationState: { sourcesReady: boolean; playbackReady: boolean };
	files: {
		artifactId: string;
		sourceRef: string;
		name: string;
		byteSize: number;
		sha256: string;
		roles: string[];
		sourceIdentity: Record<string, unknown>;
		provenance?: Record<string, unknown> | null;
		range: { offset: number; length: number };
		format?: string | null;
		formatVersion?: string | null;
		representation?: "text" | "binary" | "unknown";
		dependencies?: unknown[];
		companionCandidate?: {
			kind: string;
			rawReadable: boolean;
			originVerified: boolean;
			unambiguous: boolean;
			scientificState: string;
			evidence: string[];
		};
	}[];
}
export interface SubmitTaskInput {
	engineId: "gaussian" | "orca";
	inputName: string;
	finalInputText: string;
	dependencies: SubmitDependencyView[];
	suggestedName: string;
	projectId: string | null;
	resources: ResourceSummaryView[];
	initialGroupIds?: string[];
}
export interface SubmitTaskRequest {
	input: SubmitTaskInput;
	environmentId: string;
	displayName: string;
	groupIds?: string[];
	/** One dialog/submit intent, stable across preview edits and transport retries. */
	submissionIntentId?: string;
	resubmitTaskId?: string;
	overwritePlanId?: string;
	workingRootOverride?: string;
	archiveRootOverride?: string;
	submissionPlanId?: string;
	calculationScript?: CalculationScript;
	slurm?: { partition: string; account: string; qos: string; timeLimit: string };
}
export interface TaskOperationItem {
	taskId: string;
	displayName: string;
	eligible: boolean;
	impact: string;
	reason?: string;
	files?: {
		artifactId: string;
		relativePath: string;
		roles?: string[];
		byteSize: number | null;
		included: boolean;
		recommended: boolean;
	}[];
	totalBytes?: number;
	requiresStop?: boolean;
	workPath?: string | null;
	directoryMode?: "single" | "dual";
	archiveCoverage?: "full" | "partial" | "none" | "unknown";
}
export interface TaskOperationPlan {
	planId: string;
	action: TaskBatchAction;
	items: TaskOperationItem[];
	totalBytes?: number;
	warning?: string;
}
export interface TaskOperationResult {
	operationId: string;
	items: {
		taskId: string;
		displayName: string;
		outcome: "succeeded" | "failed" | "not-executed";
		message?: string;
		childOperationId?: string;
	}[];
}
export interface TaskOperationStart {
	operationId: string;
	items?: TaskOperationResult["items"];
}
export interface TaskOperationItemView extends Omit<
	TaskOperationResult["items"][number],
	"outcome"
> {
	outcome?: TaskOperationResult["items"][number]["outcome"];
	state?: "pending" | "running" | "succeeded" | "failed" | "not-executed";
	phase?: string;
	completedBytes?: number;
	totalBytes?: number | null;
}
export interface TaskOperationView extends Omit<TaskOperationStart, "items"> {
	type?: string;
	phase: string;
	state: OperationState;
	progress: {
		completed: number;
		total: number | null;
		unit: "tasks" | "files" | "bytes";
		elapsedMs?: number;
	};
	items: TaskOperationItemView[];
}
/** Text-window binding; append changes size/mtime without replacing this source. */
export interface PreviewSourceIdentity {
	taskId: string | null;
	artifactId: string;
	environmentId: string;
	path: string;
	fileId: string | null;
	sourceGeneration?: string | null;
}
export interface TextPreviewChunk {
	artifactId: string;
	version: string;
	byteStart: number;
	byteEnd: number;
	lineStart: number | null;
	lines: string[];
	hasBefore: boolean;
	hasAfter: boolean;
	totalBytes: number | null;
	/** New hosts return it; absent in legacy payloads. */
	sourceIdentity?: PreviewSourceIdentity;
}
export interface TextFindMatch {
	byteOffset: number;
	lineNumber: number | null;
	length: number;
}
export interface MonitorGeometry {
	sourceKey: string;
	frameId: string;
	atoms: { id: string; element: string; x: number; y: number; z: number }[];
	/** Absent means display connectivity is unprepared; [] is an explicit empty graph. */
	bonds?: { a: number; b: number; order: number }[];
	cell?: { vectors: number[][]; pbc: boolean[] };
}
export type MonitorCardKind = "energy" | "trajectory" | "vibrations" | "excited" | "atomic";
export interface MonitorDatum {
	label: string;
	value: string;
	unit: string | null;
	sourceLabel: string;
}
export interface MonitorCardData {
	kind: MonitorCardKind;
	title: string;
	columns: string[];
	rows: string[][];
	sourceLabel: string;
	plot?: {
		xLabel: string;
		yLabel: string;
		series: {
			id: string;
			label?: string;
			kind?: "line" | "stick";
			points: { x: number; y: number | null; tooltip?: string; index?: number; segment?: string }[];
		}[];
	};
}
/** Source-bound dimensions remain separate from process exit and result preparation. */
export interface TaskScientificStateView {
	key: string;
	label: string;
	state: ScientificState;
	jobIndex: number;
	segmentIndex: number;
	stageId?: string;
	frameIndex?: number | null;
	sourceLine?: number;
	sourceLabel: string;
	evidenceRefs: string[];
	raw?: string;
	reason?: string;
}
export interface TaskDetailView {
	task: TaskCardView;
	files: TaskFileView[];
	stage: string | null;
	iteration: string | null;
	elapsedSeconds: number | null;
	resultSource?: { kind: "archive" | "work"; path: string } | null;
	updatedAt: string | null;
	notices: {
		id: string;
		message: string;
		details?: string;
		severity?: "warning" | "error";
		artifactId?: string;
	}[];
	scientificStates?: TaskScientificStateView[];
}
/** Complete frame publications only. Same revision => empty delta; reset includes all frames. */
export interface TaskMonitorView extends TaskDetailView {
	collectionId: string | null;
	revision: string | null;
	baseRevision: string | null;
	frameCount: number;
	framesDelta: { index: number; frame: MonitorGeometry }[];
	reset: boolean;
	prepared: boolean;
	cards: MonitorCardData[];
	layout: MonitorCardKind[];
	progress?: ScientificReadProgress;
	sourceGeneration?: number;
	sourceRevision?: number;
	sourceBoundary?: SourceBoundary;
	sourceIdentity?: {
		sourceId: string;
		taskId: string;
		runId: string | null;
		artifactId: string;
		path: string;
	};
	/** Large result data is sent only when the result revision changes. */
	results?: TaskMonitorResultView[];
	/** True only when every parsed job is represented, with no omitted diagnostics. */
	resultsComplete?: boolean;
}
export interface TaskMonitorResultView {
	result: Omit<TrajectoryResult, "getFrame" | "dispose">;
	/** Job-local frame ordinal maps to the collection's flat geometry ordinal. */
	geometryIndices: number[];
}
export interface ScientificReadProgress {
	taskId: string;
	runId: string | null;
	sourceId: string;
	artifactId: string;
	managerEpoch: number;
	sourceGeneration: number;
	sourceRevision: number;
	operationId: string;
	sequence: number;
	stage:
		"connecting" | "transferring" | "parsing" | "preparing" | "publishing" | "ready" | "failed";
	observedAt: string;
	completedBytes: number;
	totalBytes: number | null;
	completeFrames: number;
	preparedFrames: number;
	elapsedMs: number;
}
export interface LibraryDiscoveryView {
	candidateId: string;
	items: {
		taskId: string | null;
		displayName: string;
		directory: string;
		markerPath?: string;
		state: string;
		[key: string]: unknown;
	}[];
	conflicts: { id: string; message: string; [key: string]: unknown }[];
	issues: { id: string; message: string; [key: string]: unknown }[];
}
export interface LibraryDiagnosticView {
	checkId: string;
	issues: { id: string; message: string; repairable: boolean }[];
}
export interface ManagedSourceFileView {
	fileId: string;
	role: string;
	name: string;
	sourceId: string;
	revision?: string;
	byteSize: number;
	required: boolean;
	format?: string | null;
	representation?: "text" | "binary";
	sourceIdentity?: Record<string, unknown>;
	companionCandidate?: SnapshotDescriptionView["files"][number]["companionCandidate"];
}
export interface ManagedSourceSetView {
	sourceSetId: string;
	sourceVersion: string;
	documentId: string;
	origin: ManagedSourceOrigin;
	files: ManagedSourceFileView[];
	summary?: ManagedSourceSummaryView;
}
export interface SourceSaveBeginRequest {
	requestId: string;
	taskId?: string;
	displayName: string;
	groupIds: string[];
	archiveRootOverride?: string;
	sourceSet: ManagedSourceSetView;
}
export interface SourceSaveResult {
	taskId: string;
	sourceSetId: string;
	sourceVersion: string;
	locationId: string;
	directory: string;
	artifactIds: string[];
	archived: true;
}
export interface PostprocessCacheEntry {
	key: string;
	sourceId?: string;
	sourceRevision?: string;
	jobIndex?: number;
	sourceFrameIndex?: number;
	parametersIdentity?: string;
	capabilityVersion?: string;
	assetId: string;
	assetReferences: string[];
}
export interface PostprocessCacheAsset {
	assetId: string;
	fileId: string;
	role: "derived-cache" | "state-index";
	byteSize: number;
}
export interface PostprocessCacheManifest {
	schema: 1;
	capabilities: string[];
	requiredCapabilities: string[];
	cacheId: string;
	taskId: string;
	sourceSetId: string;
	sourceVersion: string;
	documentId: string;
	modelDocumentId?: string;
	sourceBindings?: { sourceId: string; sourceRevision: string; role: string }[];
	entries: PostprocessCacheEntry[];
	assets: PostprocessCacheAsset[];
	savedAt: string;
	byteSize: number;
	state: "complete";
}
export interface CacheUploadFileView {
	fileId: string;
	role: "derived-cache" | "state-index";
	name: string;
	byteSize: number;
}
export interface PostprocessCacheSaveResult {
	cacheId: string;
	taskId: string;
	sourceSetId: string;
	sourceVersion: string;
	savedAt: string;
	byteSize: number;
	state: "complete";
}
export interface TaskSystemCommands {
	"reminder.dismiss": { input: { reminderId: string }; result: void };
	"center.enter": { input: { entryId: string }; result: TaskCenterView };
	"center.leave": { input: { entryId: string }; result: void };
	"center.read": { input: {}; result: TaskCenterView };
	"manager.acquire": { input: { entryId: string }; result: TaskManagerView };
	"task.details": { input: { taskId: string }; result: TaskDetailView };
	"task.execution-evidence": {
		input: {
			taskId: string;
			runId?: string;
			operationOffset?: number;
			operationLimit?: number;
			receiptOffset?: number;
			receiptLimit?: number;
		};
		result: {
			libraryId: string;
			taskId: string;
			runId: string;
			observedAt: string;
			run: Pick<
				Run,
				| "executionIdentity"
				| "state"
				| "stopDisposition"
				| "softwareSnapshot"
				| "inputSnapshotId"
				| "environmentSnapshot"
			> & { resources: Run["resources"] | null; resultPreparationState: unknown };
			inputSnapshot: Pick<
				InputSnapshot,
				| "inputSnapshotId"
				| "contentIdentity"
				| "primaryInputArtifactId"
				| "dependencies"
				| "parsedRequests"
				| "engineExtensions"
			> | null;
			operations: Operation[];
			operationPage: { nextOffset: number; hasMore: boolean; scanned: number };
			executionReceipts: ExecutionReceipt[];
			receiptPage: { nextOffset: number; hasMore: boolean };
		};
	};
	"task.rename": { input: { taskId: string; displayName: string }; result: void };
	"group.save": {
		input: { groupId?: string; parentGroupId: string | null; displayName: string; order?: number };
		result: void;
	};
	"group.move": {
		input: { groupId: string; parentGroupId: string | null; beforeGroupId?: string | null };
		result: void;
	};
	"group.delete": { input: { groupId: string }; result: void };
	"group.membership": {
		input: { taskIds: string[]; groupId: string; mode: "add" | "remove" };
		result: void;
	};
	"operation.plan": {
		input: {
			action: TaskBatchAction;
			taskIds: string[];
			groupId?: string | null;
			deleteLocal?: boolean;
			deleteRemote?: boolean;
			remindRemote?: boolean;
			archiveMode?: "default" | "selected";
			selectedArtifactIds?: string[];
		};
		result: TaskOperationPlan;
	};
	"operation.execute": { input: { planId: string }; result: TaskOperationStart };
	"operation.read": { input: { operationId: string }; result: TaskOperationView };
	"operation.retry": {
		input: { operationId: string; taskIds: string[] };
		result: TaskOperationStart;
	};
	"monitor.read": {
		input: { taskId: string; refresh: boolean; knownRevision: string | null };
		result: TaskMonitorView;
	};
	"monitor.release": { input: { taskId: string }; result: void };
	"monitor.layout": { input: { taskId: string; cards: MonitorCardKind[] }; result: void };
	"monitor.settings": { input: MonitoringSettings; result: MonitoringSettings };
	"preview.read": {
		input: {
			ownerId: string;
			artifactId: string;
			anchor: "tail" | number;
			maxBytes: number;
			expectedSourceIdentity?: PreviewSourceIdentity;
		};
		result: TextPreviewChunk;
	};
	"preview.find": {
		input: {
			ownerId: string;
			artifactId: string;
			query: string;
			fromByte: number;
			/** Frozen EOF returned by the immediately preceding continuation. */
			searchEndByte?: number;
			direction: "previous" | "next";
			expectedSourceIdentity?: PreviewSourceIdentity;
		};
		result: TextFindMatch | null | { kind: "continue"; nextByte: number; searchEndByte: number; completedBytes: number; totalBytes: number };
	};
	"preview.release": { input: { ownerId: string }; result: void };
	"file.save-copy": {
		input: { artifactId: string; expectedSourceIdentity?: PreviewSourceIdentity };
		result: { saved: boolean; path?: string };
	};
	"clipboard.write": { input: { text: string }; result: void };
	"library.associate": {
		input: { root?: string; mode?: "create" | "open" };
		result: TaskLibraryView;
	};
	"library.discover": { input: { root: string }; result: LibraryDiscoveryView };
	"library.rebuild": {
		input: { candidateId: string; choices: Record<string, string> };
		result: { operationId: string };
	};
	"library.migrate": { input: {}; result: { operationId: string; message: string } };
	"library.self-check": {
		input: { repair: boolean; checkId?: string };
		result: LibraryDiagnosticView;
	};
	"library.empty-recycle": { input: {}; result: TaskOperationResult };
	"environment.save": {
		input: {
			environment: EnvironmentView;
			secret?: EnvironmentSecretPayload;
			documentPreservation?: EnvironmentDocumentPreservation;
			requiredCapabilities?: string[];
		};
		result: EnvironmentView;
	};
	"environment.delete": { input: { environmentId: string }; result: void };
	"environment.import": { input: {}; result: EnvironmentView[] };
	"environment.import-preview": {
		input: { text?: string };
		result: EnvironmentImportPreview | null;
	};
	"environment.site-save": { input: { site: SiteProfileView }; result: SiteProfileView };
	"environment.site-delete": { input: { siteId: string; expectedRevision?: number }; result: void };
	"environment.browse": {
		input: {
			environment: EnvironmentView;
			secret?: EnvironmentSecretPayload;
			purpose: "executable" | "working-root" | "scratch-root" | "private-key";
			path?: string;
			mode: "file" | "directory";
		};
		result: EnvironmentBrowseResult | null;
	};
	"environment.export": { input: { environmentId: string }; result: { saved: boolean } };
	"environment.check": {
		input: { environment: EnvironmentView; secret?: EnvironmentSecretPayload };
		result: {
			message: string;
			details?: string;
			hostKey?: HostKeyChallenge;
			check?: EnvironmentCheckView;
		};
	};
	"environment.trust-host-key": {
		input: { challengeId: string; fingerprint: string };
		result: void;
	};
	"submission.preview": {
		input: SubmitTaskRequest;
		result: {
			workingPath: string;
			directoryMode?: "single" | "dual";
			suggestedDisplayName?: string;
			script: string;
			submissionPlanId?: string;
			archivePath?: string;
			executable?: string | null;
			softwareVersion?: string | null;
			taskKind?: string | null;
			calculationScript?: CalculationScript;
			calculationScriptIdentity?: CalculationScriptIdentity;
			resources: ResourceSummaryView[];
			restrictions: string[];
			restrictionDetails?: Array<{
				code: string;
				field?: string;
				expected?: string;
				actual?: string;
				reason?: string;
			}>;
		};
	};
	"location.open": {
		input: { taskId?: string; kind: "work" | "archive"; submissionPlanId?: string };
		result: { opened: boolean; path: string; openedParent: boolean };
	};
	"submission.choose-root": {
		input: { environmentId: string; kind: "work" | "archive"; currentPath?: string };
		result: { path: string | null };
	};
	"submission.resubmit-draft": {
		input: { taskId: string };
		result: SubmitTaskRequest;
	};
	"submission.overwrite-preview": {
		input: { resubmitTaskId: string; submissionPlanId: string };
		result: {
			overwritePlanId: string;
			workFiles: { path: string; byteSize: number }[];
			archiveFiles: { path: string; byteSize: number }[];
			workBytes: number;
			archiveBytes: number;
		};
	};
	"submission.choose-dependencies": {
		input: { engineId: "gaussian" | "orca" };
		result: SubmitDependencyView[];
	};
	"submission.stage-begin": {
		input: { name: string; role: string; byteSize: number };
		result: { token: string };
	};
	"submission.stage-append": {
		input: { token: string; offset: number; bytes: Uint8Array };
		result: { receivedBytes: number };
	};
	"submission.stage-finish": { input: { token: string }; result: SubmitDependencyView };
	"submission.stage-abort": { input: { token: string }; result: void };
	"submission.release-dependencies": { input: { sourceRefs: string[] }; result: void };
	"submission.submit": {
		input: SubmitTaskRequest;
		result: { taskId: string; runId: string; operationId: string };
	};
	"snapshot.open": { input: { taskId: string }; result: SnapshotLeaseView };
	"snapshot.describe": {
		input: { snapshotId: string; leaseId?: string };
		result: SnapshotDescriptionView;
	};
	"snapshot.read-range": {
		input: SnapshotLeaseView & { sourceRef: string; offset: number; length: number };
		result: { bytes: Uint8Array; offset: number; length: number; sha256: string };
	};
	"snapshot.retain": { input: SnapshotLeaseView; result: SnapshotLeaseView };
	"snapshot.release": { input: SnapshotLeaseView; result: void };
	"snapshot.companion-source": {
		input: SnapshotLeaseView & { sourceRef: string };
		result: { token: string; name: string; size: number; revision: string };
	};
	"snapshot.close-companion": { input: { token: string }; result: void };
	"source-save.choose-directory": {
		input: { path?: string };
		result: { directory: string } | null;
	};
	"source-save.admission": {
		input: { origin: ManagedSourceOrigin };
		result: { eligible: boolean; reason?: string };
	};
	"source-save.begin": {
		input: SourceSaveBeginRequest;
		result: { uploadId: string; operationId: string; taskId: string };
	};
	"source-save.append": {
		input: { uploadId: string; fileId: string; offset: number; bytes: Uint8Array };
		result: { written: number };
	};
	"source-save.commit": { input: { uploadId: string }; result: SourceSaveResult };
	"source-save.abort": { input: { uploadId: string }; result: { aborted: boolean } };
	"postprocess-cache.describe": {
		input: { taskId: string; sourceSetId: string; sourceVersion: string };
		result: {
			cacheId: string | null;
			savedAt: string | null;
			byteSize: number;
			state: "absent" | "complete" | "incompatible";
			manifest?: PostprocessCacheManifest;
		};
	};
	"postprocess-cache.begin": {
		input: {
			requestId: string;
			taskId: string;
			sourceSetId: string;
			sourceVersion: string;
			manifest: Omit<PostprocessCacheManifest, "savedAt" | "byteSize" | "state">;
			files: CacheUploadFileView[];
		};
		result: { uploadId: string; operationId: string };
	};
	"postprocess-cache.append": {
		input: { uploadId: string; fileId: string; offset: number; bytes: Uint8Array };
		result: { written: number };
	};
	"postprocess-cache.commit": { input: { uploadId: string }; result: PostprocessCacheSaveResult };
	"postprocess-cache.abort": { input: { uploadId: string }; result: { aborted: boolean } };
	"postprocess-cache.read": {
		input: {
			taskId: string;
			cacheId: string;
			fileId: string;
			offset: number;
			length: number;
			leaseId?: string;
		};
		result: { offset: number; bytes: Uint8Array };
	};
	"postprocess-cache.retain": {
		input: { taskId: string; cacheId: string };
		result: { leaseId: string };
	};
	"postprocess-cache.release": { input: { leaseId: string }; result: void };
	"postprocess-cache.delete-plan": {
		input: { taskId: string; cacheId: string };
		result: { planId: string; byteSize: number; files: CacheUploadFileView[]; inUse: boolean };
	};
	"postprocess-cache.delete": {
		input: { planId: string };
		result: {
			operationId: string;
			deleted: string[];
			retained: { fileId: string; reason: string }[];
		};
	};
}
/** Whitelisted bridge only. No generic FS, shell, process or arbitrary IPC endpoint. */
export interface TaskSystemBridge {
	request<C extends keyof TaskSystemCommands>(
		command: C,
		input: TaskSystemCommands[C]["input"],
		options?: { signal?: AbortSignal }
	): Promise<TaskSystemCommands[C]["result"]>;
}
