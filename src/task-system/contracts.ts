/** Protocol v1 domain. No desktop, scientific parser, project or UI dependencies. */
export type JsonValue =
	null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Extensible = { [key: string]: unknown };
export type FieldState = "known" | "unknown" | "unavailable" | "unsupported" | "conflict";
export interface FieldStatus extends Extensible {
	state: FieldState;
	reason?: string;
	evidenceRefs?: string[];
}
export interface RecordBase extends Extensible {
	schemaVersion: 1;
	revision: number;
	requiredCapabilities: string[];
	fieldStatus?: Record<string, FieldStatus>;
}
export interface ProjectRef extends Extensible {
	projectId: string;
}
export interface WorkLocation extends Extensible {
	environmentId: string;
	path: string;
}
export interface ContentIdentity extends Extensible {
	algorithm: string;
	hash: string | null;
}
export interface SourceAnchor extends Extensible {
	artifactId: string;
	revision: number;
	byteRange?: { start: number; end: number };
	rawBlockRef?: string;
	jobRef?: string;
	stageRef?: string;
	frameRef?: string;
}
export interface ScientificValue extends Extensible {
	rawToken: string;
	unit: string | null;
	printedPrecision: string | null;
	status: FieldStatus;
	source: SourceAnchor;
	/** Canonical decimal text, never a rounded display replacement for rawToken. */
	value?: string;
	converted?: Extensible;
	display?: Extensible;
}
export interface Evidence extends Extensible {
	type: string;
	evidenceRefs: string[];
	checkedAt: string;
}
/** Names identify contracts, never proof that an adapter implements them. */
export const TASK_SYSTEM_CAPABILITIES = {
	marker: "es:task-marker-v1",
	multigroup: "es:task-multigroup-v1",
	sourceOnly: "es:task-source-only-v1",
	logicalRecycle: "es:task-logical-recycle-v1",
	postprocessCache: "es:task-postprocess-cache-v1",
	environmentSites: "es:task-environment-sites-v1",
	editableScript: "es:task-editable-script-v1",
	taskLayout: "es:task-layout-v2",
	clearWork: "es:task-clear-work-v1",
	overwriteSubmission: "es:task-overwrite-v1",
	environmentTemplates: "es:task-environment-templates-v1",
	resultAdoption: "es:task-result-adoption-v1",
	posixStopDispatch: "es:task-posix-stop-dispatch-v1",
	slurmSchedulerEnd: "es:task-slurm-scheduler-end-v1"
} as const;
export interface MarkerManagement extends Extensible {
	revision: number;
	changeId: string;
	parentChangeId: string | null;
	recycled: boolean;
}
export interface ManagedSourceOrigin extends Extensible {
	kind: "postprocess" | "xtb-generated" | "task-snapshot";
	linkedTaskId?: string;
	linkedRunId?: string | null;
	libraryId?: string;
	snapshotId?: string;
	sourceSetId?: string;
	sourceVersion?: string;
}
export interface TaskOrigin extends Extensible {
	kind: "submitted" | "external-directory" | "postprocess-saved" | "marker-recovered";
	sourceKind?: ManagedSourceOrigin["kind"];
}
export interface TaskLocation extends Extensible {
	locationId: string;
	kind: "work" | "planned-archive" | "archive" | "external" | "legacy-recycle";
	/** library paths are relative to the owning library root. */
	scope: "library" | "external";
	path: string;
	environmentId?: string;
	sourceSetId?: string;
	sourceVersion?: string;
	markerPath?: string;
	management?: MarkerManagement;
}
export interface TaskThumbnail extends Extensible {
	sourceVersion: string;
	dataUrl: string;
	formula?: string;
}
/** Plain scientific geometry data, independent of parser, project and UI owners. */
export interface ScientificStructure {
	id: string;
	name: string;
	format: string;
	atoms: { id?: string; sourceIndex?: number; element: string; x: number; y: number; z: number }[];
	charge: number | null;
	multiplicity: number | null;
	notes: string[];
	bonds?: { a: number; b: number; order: number }[];
	cell?: {
		vectors: [[number, number, number], [number, number, number], [number, number, number]];
		pbc: [boolean, boolean, boolean];
		origin?: [number, number, number];
		source?: string;
	};
}
export interface ManagedSourceSummaryView extends Extensible {
	schema: 1;
	sourceSetId: string;
	sourceVersion: string;
	sourceSha256: string;
	sourceId: string;
	engineId: string;
	taskKind: string;
	frameIndex: number;
	sourceFrameIndex: number | null;
	structure: ScientificStructure;
	energy: { value: number; unit: string } | null;
	method?: string;
	capabilities?: string[];
}
export interface Task extends RecordBase {
	taskId: string;
	displayName: string;
	createdAt: string;
	lastSubmittedAt?: string;
	directoryMode?: "single" | "dual";
	workFileState?: "present" | "cleared" | "unknown";
	archiveState?: "unarchived" | "archived" | "archiving" | "cleared" | "failed";
	engineId: string;
	taskKind: string;
	sourceProjectRef: ProjectRef | null;
	groupId: string | null;
	latestRunId: string | null;
	formula?: string | null;
	origin?: TaskOrigin;
	sourceSetId?: string | null;
	sourceVersion?: string;
	locations?: TaskLocation[];
	thumbnail?: TaskThumbnail | null;
	sourceSummary?: ManagedSourceSummaryView | null;
	postprocessCache?: {
		cacheId: string;
		sourceSetId: string;
		sourceVersion: string;
		manifestPath: string;
		savedAt: string;
		byteSize: number;
		requiredCapabilities?: string[];
	} | null;
}
export interface ConnectionConfiguration extends Extensible {
	kind: "local" | "wsl" | "ssh";
	distribution?: string;
	host?: string;
	user?: string;
	port?: number;
}
export interface EnvironmentSnapshot extends Extensible {
	environmentId: string;
	configurationRevision: number;
	connection: ConnectionConfiguration;
	scheduler: { kind: "none" | "slurm"; submitCommandTemplate?: string; [key: string]: unknown };
	softwareAdapter: Extensible;
	workingRoot: string;
	configuration: Extensible;
}
export interface SoftwareSnapshot extends Extensible {
	engineId: string;
	rawVersion: string | null;
	recognizedVersion: string | null;
	platform: string;
	entryIdentity: Extensible | null;
	adapterVersion: string;
	capabilities: Extensible;
	fieldStatus?: Record<string, FieldStatus>;
}
export interface ResourceLayer extends Extensible {
	source: unknown;
	observedAt?: string;
	phaseRef?: string;
	cpuCores?: number | null;
	mpiProcesses?: number | null;
	threadsPerProcess?: number | null;
	memory?: {
		value: string | number;
		unit: string;
		scope: string;
		raw: string;
		[key: string]: unknown;
	} | null;
	gpus?: Extensible | null;
	limits?: Extensible | null;
}
export interface Resources extends Extensible {
	inputRequest: ResourceLayer | null;
	schedulerRequest: ResourceLayer | null;
	grant: ResourceLayer | null;
	observation: ResourceLayer | null;
	fieldStatus?: Record<string, FieldStatus>;
}
export interface ExecutionIdentity extends Extensible {
	submissionIntentId: string | null;
	workLocation: WorkLocation | null;
	executorIdentity: Extensible | null;
	launchIdentity: Extensible | null;
	launchReceipt: Extensible | null;
	endReceipt: Extensible | null;
	schedulerEndReceipt?: ExecutionReceipt;
	fieldStatus?: Record<string, FieldStatus>;
}
export type ExecutionState =
	"preparing" | "submitting" | "queued" | "running" | "stop-requested" | "ended" | "unknown";
export type VerificationState = "verified" | "stale" | "unreachable" | "conflict" | "unknown";
export type ScientificState =
	"unknown" | "in-progress" | "satisfied" | "not-satisfied" | "not-applicable" | "conflict";
export type OperationState =
	"pending" | "running" | "waiting-verification" | "succeeded" | "failed" | "cancelled" | "partial";
export interface RunState extends Extensible {
	executionState: ExecutionState;
	endReason?: "completed" | "failed" | "stopped" | "interrupted" | "unknown";
	verificationState: VerificationState;
	checkedAt: string | null;
	evidenceRefs: string[];
	scientificState: Record<
		string,
		{
			state: ScientificState;
			evidenceRefs: string[];
			raw?: string;
			reason?: string;
			[key: string]: unknown;
		}
	>;
	lastReliableExecutionState?: ExecutionState;
}
export interface Run extends RecordBase {
	runId: string;
	/** Durable restricted result-adoption operation reference; never a live process/reader handle. */
	resultAdoptionOperationId?: string;
	taskId: string;
	attemptOrdinal: number;
	inputSnapshotId: string;
	environmentSnapshot: EnvironmentSnapshot;
	softwareSnapshot: SoftwareSnapshot;
	executionIdentity: ExecutionIdentity;
	state: RunState;
	stopDisposition?: PosixStopDisposition;
	resources?: Resources;
	parentRunId?: string;
	stageId?: string;
	runtimeTimingObservation?: {
		runId: string;
		submissionIntentId: string;
		kind: "linux-boot-uptime-v1";
		clockDomain: string;
		elapsedSeconds: number;
		observedAt: string;
		state: "running";
	};
}
export interface PosixStopDisposition extends Extensible {
	kind: "posix-term-verified";
	taskId: string;
	runId: string;
	submissionIntentId: string;
	stopOperationId: string;
	launchReceiptId: string;
	endReceiptId: string;
	exitCode: number;
	attemptAt: string;
	dispatchedAt: string;
	endAt: string;
	evidenceRefs: string[];
}
export interface InputDependency extends Extensible {
	artifactId: string;
	roles: string[];
	originalLocation: WorkLocation;
	preparedLocation: WorkLocation | null;
	integrity: unknown;
	contentIdentity: ContentIdentity;
}
export interface CalculationScript {
	kind: "bash" | "powershell";
	text: string;
}
export interface CalculationScriptIdentity {
	algorithm: "sha256";
	hash: string;
	byteSize: number;
}
export interface InputSnapshot extends RecordBase {
	inputSnapshotId: string;
	primaryInputArtifactId: string;
	dependencies: InputDependency[] | null;
	contentIdentity: ContentIdentity;
	parsedRequests: Extensible;
	engineExtensions: Extensible;
	calculationScript?: CalculationScript;
	calculationScriptIdentity?: CalculationScriptIdentity;
}
export type ArtifactRole =
	| "input"
	| "primary-output"
	| "structure"
	| "trajectory"
	| "wavefunction"
	| "modes"
	| "restart"
	| "diagnostic"
	| "scratch"
	| "other";
export interface SourceBoundary extends Extensible {
	fileIdentity: Extensible;
	readByteRange: { start: number; end: number };
	publishedByteRange: { start: number; end: number };
	observedEnd?: number;
	consumedByteRange?: { start: number; end: number };
	sourceGeneration?: number;
}
export interface Artifact extends RecordBase {
	artifactId: string;
	runId: string | null;
	/** Required when runId is null; legacy executed artifacts retain their Run binding. */
	taskId?: string;
	sourceSetId?: string;
	roles: ArtifactRole[];
	format: string | null;
	formatVersion: string | null;
	representation: "text" | "binary";
	locations: Extensible[] | null;
	provenance: Extensible | null;
	producer: Extensible | null;
	byteSize: number | null;
	integrity: unknown;
	contentHash: ContentIdentity | null;
	sourceBoundary?: SourceBoundary;
	jobRef?: unknown;
	stageRef?: unknown;
	frameRef?: unknown;
	dependencies?: unknown[];
}
export type RecordKind =
	| "task"
	| "run"
	| "inputSnapshot"
	| "environment"
	| "artifact"
	| "operation"
	| "group"
	| "groupMembership"
	| "siteProfile"
	| "sourceSet"
	| "projectAssociation"
	| "snapshot"
	| "archiveManifest"
	| "cleanupManifest"
	| "recycleRecord"
	| "library";
export interface RecordTarget extends Extensible {
	kind: RecordKind;
	id: string;
}
export interface Operation extends RecordBase {
	operationId: string;
	type: string;
	targets: RecordTarget[];
	preconditions: Extensible;
	authorizationScope: Extensible;
	phase: string;
	operationState: OperationState;
	results: Extensible[];
	owner?: ProcessIdentity;
}
export interface EnvironmentRecord extends RecordBase {
	environmentId: string;
	displayName: string;
	configuration: EnvironmentSnapshot;
}
export interface TaskGroup extends RecordBase {
	groupId: string;
	displayName: string;
	parentGroupId: string | null;
	order?: number;
	deleted?: boolean;
}
export interface TaskGroupMembership extends RecordBase {
	membershipId: string;
	taskId: string;
	groupId: string;
	deleted?: boolean;
}
export interface SiteProfile extends RecordBase {
	siteId: string;
	displayName: string;
	connectionKind: "local" | "wsl" | "ssh";
	host: string;
	port: number;
	user: string;
	distribution: string;
	workingRoot: string;
	schedulerKind: "none" | "slurm";
	partition: string;
	account: string;
	qos: string;
	timeLimit: string;
	authentication: "agent" | "password" | "private-key";
	privateKeyPath: string;
	deleted?: boolean;
}
export interface SourceSet extends RecordBase {
	sourceSetId: string;
	taskId: string;
	sourceVersion: string;
	origin: ManagedSourceOrigin;
	scope: "library" | "external";
	manifestPath: string;
	directory: string;
	files: {
		artifactId: string;
		roles: string[];
		name: string;
		relativePath: string;
		byteSize: number;
		sha256: string | null;
		sourceId: string;
		required: boolean;
	}[];
	state: "archived" | "external" | "missing";
	main?: string;
	summary?: ManagedSourceSummaryView | null;
}
export interface ProjectAssociation extends RecordBase {
	associationId: string;
	taskId: string;
	projectRef: ProjectRef;
}
export interface TaskSnapshot extends RecordBase {
	snapshotId: string;
	taskId: string;
	runId: string | null;
	sourceSetId?: string;
	sourceVersion?: string;
	sources: Extensible[];
	contentIdentity: ContentIdentity;
	independentSources: Extensible[];
	preparationState: Extensible;
	jobRef?: unknown;
	stageRef?: unknown;
	frameRef?: unknown;
}
export interface ArchiveManifestItem extends Extensible {
	artifactId: string;
	originalRelativePath: string;
	sourceIdentity: Extensible;
	included: boolean;
	reason: string;
	copyState: string;
	verificationState: string;
}
export interface ArchiveManifest extends RecordBase {
	manifestId: string;
	taskId: string;
	runId: string | null;
	sourceSetId?: string;
	operationId: string;
	sourceLocation: WorkLocation;
	targetLocation: WorkLocation;
	items: ArchiveManifestItem[];
}
export interface CleanupManifestItem extends Extensible {
	artifactId: string;
	originalLocation: WorkLocation;
	fileIdentity: Extensible;
	basis: Extensible;
	dependencyCheck: Extensible;
	impact: string;
	result: Extensible;
}
export interface CleanupManifest extends RecordBase {
	manifestId: string;
	taskId: string;
	runId: string | null;
	sourceSetId?: string;
	operationId: string;
	items: CleanupManifestItem[];
}
export interface RecycleRecord extends RecordBase {
	recycleId: string;
	taskId: string;
	artifactIds: string[];
	originalGroupId: string | null;
	originalLocations: WorkLocation[];
	recycleLocations: WorkLocation[];
	cleanupRecordRef: string | null;
	mode?: "logical" | "physical";
	management?: MarkerManagement;
	originalGroupIds?: string[];
}
export interface LibraryRecord extends RecordBase {
	libraryId: string;
	createdAt: string;
}
export interface ExecutionReceipt extends Extensible {
	receiptId: string;
	eventId: string;
	operationId: string;
	taskId: string;
	runId: string;
	submissionIntentId: string;
	source: string;
	sequence: number;
	evidenceRefs: string[];
	sourceRevision?: number;
	managerEpoch?: number;
}
export interface ProcessIdentity extends Extensible {
	instanceId: string;
	pid: number;
	startedAt: string;
	hostId: string;
	userId: string;
	executableIdentity?: string;
}
export interface Manager extends Extensible {
	libraryId: string;
	instanceId: string | null;
	epoch: number;
	processIdentity: ProcessIdentity | null;
}
export interface ManagerClaim {
	instanceId: string;
	epoch: number;
}
export interface OperationPermit {
	operationId: string;
	ownerInstanceId: string;
	token: string;
}
export interface RecordMutation {
	kind: RecordKind;
	id: string;
	expectedRevision: number | null;
	value: RecordBase;
}
export type ExecutionAction =
	"capabilities" | "prepare" | "submit" | "inspect" | "requestStop" | "collectArtifacts";
export interface ExecutionRequest extends Extensible {
	protocolVersion: 1;
	requestId: string;
	action: ExecutionAction;
	environmentId: string;
	adapterTarget: string;
	taskId?: string;
	runId?: string;
	submissionIntentId?: string;
	operationId?: string;
	preconditions: Extensible;
	payloadVersion: number;
	payload: Extensible;
}
export interface ExecutionResponse extends Extensible {
	protocolVersion: 1;
	requestId: string;
	action: ExecutionAction;
	taskId?: string;
	runId?: string;
	submissionIntentId?: string;
	operationId?: string;
	payloadVersion: number;
	payload: Extensible;
	responseState: "accepted" | "completed" | "failed" | "waiting-verification";
	actualState: Extensible;
	evidenceRefs: string[];
	error?: { code: string; detailRef?: string; [key: string]: unknown };
}
export interface TaskEvent extends Extensible {
	protocolVersion: 1;
	eventId: string;
	eventType: string;
	source: string;
	sequence: number;
	occurredAt: string;
	payloadVersion: number;
	payload: Extensible;
	taskId?: string;
	runId?: string | null;
	sourceSetId?: string;
	operationId?: string;
	sourceRevision?: number;
	managerEpoch?: number;
	requiredCapabilities?: string[];
}
export interface IOOptions {
	signal?: AbortSignal;
}
export interface Command extends Extensible {
	executable: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	stdin?: Uint8Array | AsyncIterable<Uint8Array>;
	stdoutPath?: string;
	stderrPath?: string;
}
export interface FileIdentity extends Extensible {
	environmentId: string;
	path: string;
	fileId: string | null;
	byteSize: number;
	modifiedAt: string | null;
	checkedAt: string;
	verification: VerificationState;
	isRegularFile?: boolean;
}
export interface TransportCapabilities extends Extensible {
	supported: string[];
	unavailable: string[];
	unverified: string[];
}
export interface CommandReceipt extends Extensible {
	exitCode: number | null;
	stdout: Uint8Array;
	stderr: Uint8Array;
	evidenceRefs: string[];
}
export interface ByteRangeReceipt extends Extensible {
	bytes: Uint8Array;
	offset: number;
	length: number;
	before: FileIdentity;
	after: FileIdentity;
	sha256: string;
}
export interface ObservedRangeRequest {
	path: string;
	identity?: FileIdentity;
	offset: number;
	length: number;
	previousPrefix?: { end: number; sha256: string };
}
/** One finite observation of a live source, independent of strict fixed-source reads. */
export interface ObservedRangeReceipt extends ByteRangeReceipt {
	observedEnd: number;
	previousPrefix?: { end: number; sha256: string };
}
export interface HashReceipt extends Extensible {
	algorithm: "sha256";
	hash: string;
	identity: FileIdentity;
	range?: { offset: number; length: number };
}
export interface FileReceipt extends Extensible {
	path: string;
	byteSize: number;
	sha256: string;
	identity: FileIdentity;
}
export interface DirectoryReceipt extends Extensible {
	path: string;
	created: boolean;
	evidenceRefs: string[];
}
export interface RemoveFileReceipt extends Extensible {
	path: string;
	removed: true;
	evidenceRefs: string[];
}
export interface InputInterpretation extends Extensible {
	parsedRequests: Extensible;
	fieldStatus: Record<string, FieldStatus>;
	restrictions: string[];
}
export interface LaunchPlan extends Extensible {
	command: Command;
	inputSnapshotId: string;
	workLocation: WorkLocation;
}
export interface PreparationPlan extends Extensible {
	command: Command;
	sourceArtifactId: string;
	sourceHash: string;
}
export interface Restriction extends Extensible {
	restricted: true;
	code: string;
	reason: string;
}
/** Transports do not interpret software or scheduler state; aborting IO does not undo side effects. */
export interface ConnectionTransport {
	readonly kind: "local" | "wsl" | "ssh";
	capabilities(io?: IOOptions): Promise<TransportCapabilities>;
	exec(command: Command, io?: IOOptions): Promise<CommandReceipt>;
	/** Keeps a connection alive for an external command; acknowledgement is not native launch proof. */
	handoffPersistentCommand?(
		input: {
			command: Command;
			binding: { taskId: string; runId: string; submissionIntentId: string; operationId: string };
		},
		io?: IOOptions
	): Promise<{
		kind: "wsl-foreground-connection-v1";
		pid: number;
		distribution: string;
		user: string;
		acceptedAt: string;
		evidenceRefs: string[];
	}>;
	stat(path: string, io?: IOOptions): Promise<FileIdentity>;
	listDirectory?(
		input: { path: string; identity: FileIdentity },
		io?: IOOptions
	): Promise<{
		before: FileIdentity;
		after: FileIdentity;
		entries: { name: string; kind: "file" | "directory" | "link" | "other" }[];
	}>;
	readRange(
		input: { path: string; identity: FileIdentity; offset: number; length: number },
		io?: IOOptions
	): Promise<ByteRangeReceipt>;
	readObservedRange?(input: ObservedRangeRequest, io?: IOOptions): Promise<ObservedRangeReceipt>;
	hash(
		input: {
			path: string;
			identity: FileIdentity;
			algorithm: "sha256";
			range?: { offset: number; length: number };
		},
		io?: IOOptions
	): Promise<HashReceipt>;
	putAtomic(
		input: {
			path: string;
			expectedAbsent: true;
			source: Uint8Array | AsyncIterable<Uint8Array>;
			byteSize: number;
			sha256: string;
		},
		io?: IOOptions
	): Promise<FileReceipt>;
	mkdirExclusive(path: string, io?: IOOptions): Promise<DirectoryReceipt>;
	removeFile?(
		input: { path: string; identity: FileIdentity; sha256: string; scopeRoot: string },
		io?: IOOptions
	): Promise<RemoveFileReceipt>;
	dispose(): Promise<void>;
}
export interface ExecutionAdapter {
	readonly kind: "process" | "slurm";
	readonly adapterVersion: string;
	capabilities(request: ExecutionRequest, io?: IOOptions): Promise<ExecutionResponse>;
	prepare(request: ExecutionRequest, io?: IOOptions): Promise<ExecutionResponse>;
	submit(request: ExecutionRequest, io?: IOOptions): Promise<ExecutionResponse>;
	inspect(request: ExecutionRequest, io?: IOOptions): Promise<ExecutionResponse>;
	requestStop(request: ExecutionRequest, io?: IOOptions): Promise<ExecutionResponse>;
	collectArtifacts(request: ExecutionRequest, io?: IOOptions): Promise<ExecutionResponse>;
}
export interface SoftwareAdapter {
	readonly engineId: string;
	readonly adapterVersion: string;
	inspectInput(input: { bytes: Uint8Array; dependencies: InputDependency[] }): InputInterpretation;
	probe(
		input: { transport: ConnectionTransport; environment: EnvironmentSnapshot },
		io?: IOOptions
	): Promise<SoftwareSnapshot>;
	planLaunch(input: {
		inputSnapshot: InputSnapshot;
		environmentSnapshot: EnvironmentSnapshot;
		softwareSnapshot: SoftwareSnapshot;
		workLocation: WorkLocation;
	}): LaunchPlan;
	planWavefunctionPreparation(input: {
		run: Run;
		stableSource: Artifact;
		toolSnapshot: SoftwareSnapshot;
	}): PreparationPlan | Restriction;
}
