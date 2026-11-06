"use strict";
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function failure(code, detail) {
	const error = new Error(code);
	error.code = code;
	if (detail) error.detail = detail;
	return error;
}
function checkedDirectory(directory) {
	const absolute = path.resolve(directory);
	fs.mkdirSync(absolute, { recursive: true });
	let current = absolute;
	while (true) {
		if (fs.lstatSync(current).isSymbolicLink()) throw failure("LIBRARY_LINK_REFUSED");
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return fs.realpathSync.native(absolute);
}
function flushFile(file) {
	const fd = fs.openSync(file, "r+");
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}
function checkpointFileIdentity(file) {
	const stat = fs.lstatSync(file, { bigint: true });
	if (!stat.isFile() || stat.isSymbolicLink())
		throw failure("MIGRATION_CHECKPOINT_REGULAR_FILE_REQUIRED");
	return {
		path: path.resolve(file),
		fileId: `${stat.dev}:${stat.ino}`,
		byteSize: Number(stat.size),
		changeToken: `${stat.mtimeNs}:${stat.ctimeNs}`,
		sha256: hash(fs.readFileSync(file))
	};
}
function checkpointDirectoryIdentity(directory) {
	const stat = fs.lstatSync(directory, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw failure("MIGRATION_CHECKPOINT_DIRECTORY_REQUIRED");
	return {
		path: path.resolve(directory),
		fileId: `${stat.dev}:${stat.ino}`,
		birthtimeNs: stat.birthtimeNs.toString()
	};
}
function atomicJSON(file, value, publication) {
	const tmp = file + ".candidate-" + crypto.randomUUID();
	const fd = fs.openSync(tmp, "wx");
	try {
		fs.writeFileSync(fd, JSON.stringify(value) + "\n", "utf8");
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	if (publication) return publication(tmp, checkpointFileIdentity(tmp));
	fs.renameSync(tmp, file);
	flushFile(file);
}
function openTaskLibrary(options) {
	const { protocol, processIdentity: suppliedIdentity, probeProcessIdentity } = options;
	const processIdentity = suppliedIdentity && Object.freeze(clone(suppliedIdentity));
	if (
		!protocol?.assertRecord ||
		!protocol.RECORD_ID_FIELDS ||
		!processIdentity?.instanceId ||
		typeof probeProcessIdentity !== "function"
	)
		throw failure("LIBRARY_COMPOSITION_REQUIRED");
	if (options.requireExisting) {
		for (const name of ["library.sqlite", "execution-receipts.sqlite", "checkpoint.json"]) {
			const file = path.join(path.resolve(options.directory), name);
			if (!fs.existsSync(file)) throw failure("LIBRARY_RECOVERY_REQUIRED", { missing: file });
		}
	}
	const directory = checkedDirectory(options.directory),
		dbPath = path.join(directory, "library.sqlite");
	const now = options.now || (() => new Date().toISOString());
	const fault = options.fault || (() => {});
	const migrationContext = options.migrationContext;
	if (
		migrationContext &&
		(!migrationContext.operationId ||
			migrationContext.permit?.operationId !== migrationContext.operationId ||
			!["expected", "changed", "publishPointer"].every(
				(method) => typeof migrationContext.checkpointIO?.[method] === "function"
			))
	)
		throw failure("MIGRATION_CHECKPOINT_COMPOSITION_REQUIRED");
	const capabilities = options.supportedCapabilities || [];
	const artifactReferenceGuards = new Map();
	let artifactRevision = 0;
	const checkpointPolicy = {
		commits: options.checkpointPolicy?.commits ?? 32,
		bytes: options.checkpointPolicy?.bytes ?? 8 * 1024 * 1024
	};
	if (
		!Number.isSafeInteger(checkpointPolicy.commits) ||
		checkpointPolicy.commits < 1 ||
		!Number.isSafeInteger(checkpointPolicy.bytes) ||
		checkpointPolicy.bytes < 1
	)
		throw failure("INVALID_CHECKPOINT_POLICY");
	const existed = fs.existsSync(dbPath);
	if (existed && (fs.lstatSync(dbPath).isSymbolicLink() || fs.statSync(dbPath).size === 0))
		throw failure("INVALID_EXISTING_LIBRARY");
	let db;
	try {
		db = new DatabaseSync(dbPath, { readOnly: Boolean(options.readOnly) });
	} catch (error) {
		throw failure("LIBRARY_OPEN_FAILED", String(error));
	}
	let journalAttached = false,
		pendingChanges = null;
	let receipts,
		closed = false,
		mode = options.readOnly ? "read-only" : "writable";
	function integrity() {
		return db
			.prepare("PRAGMA quick_check")
			.all()
			.map((row) => Object.values(row)[0]);
	}
	try {
		db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
		if (existed && integrity().some((item) => item !== "ok"))
			throw failure("LIBRARY_INTEGRITY_FAILED");
		if (existed) {
			const version = db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get();
			if (!version) throw failure("LIBRARY_METADATA_MISSING");
			if (JSON.parse(version.value) !== 1) mode = "read-only";
			const required = getMeta("requiredCapabilities") || [];
			if (required.some((item) => !capabilities.includes(item))) mode = "read-only";
		}
		if (mode === "writable") {
			db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
       CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,task_id TEXT,run_id TEXT,json TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(kind,id));
       CREATE INDEX IF NOT EXISTS records_task ON records(kind,task_id); CREATE INDEX IF NOT EXISTS records_run ON records(kind,run_id);
       CREATE TABLE IF NOT EXISTS previous_records(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(kind,id));
       CREATE TABLE IF NOT EXISTS manager(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL,json TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS operation_permits(operation_id TEXT PRIMARY KEY,owner_json TEXT NOT NULL,token_hash TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS events_applied(event_id TEXT PRIMARY KEY,source TEXT NOT NULL,sequence INTEGER NOT NULL,receipt_id TEXT NOT NULL,applied_at TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS source_sequences(source TEXT PRIMARY KEY,sequence INTEGER NOT NULL);
      `);
			db.exec("BEGIN IMMEDIATE");
			try {
				if (!existed) {
					setMeta("schemaVersion", 1);
					setMeta("libraryId", options.libraryId || crypto.randomUUID());
					setMeta("requiredCapabilities", []);
					setMeta("createdAt", now());
					setMeta("root", directory);
					setMeta("migration", null);
				}
				if (!db.prepare("SELECT singleton FROM manager WHERE singleton=1").get()) {
					const initial = {
						libraryId: getMeta("libraryId"),
						instanceId: null,
						epoch: 0,
						processIdentity: null
					};
					db.prepare("INSERT INTO manager VALUES(1,0,?)").run(JSON.stringify(initial));
				}
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
			const required = getMeta("requiredCapabilities") || [];
			if (required.some((item) => !capabilities.includes(item))) mode = "read-only";
		}
		if (options.libraryId && getMeta("libraryId") !== options.libraryId)
			throw failure("LIBRARY_IDENTITY_MISMATCH");
		if (mode === "writable") {
			const receiptPath = path.join(directory, "execution-receipts.sqlite");
			if (fs.existsSync(receiptPath) && fs.lstatSync(receiptPath).isSymbolicLink())
				throw failure("RECEIPT_LINK_REFUSED");
			receipts = new DatabaseSync(receiptPath);
			receipts.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
       CREATE TABLE IF NOT EXISTS receipts(receipt_id TEXT PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,json TEXT NOT NULL,sha256 TEXT NOT NULL,received_at TEXT NOT NULL);`);
			receipts.exec(
				"CREATE TABLE IF NOT EXISTS metadata_commits(sequence INTEGER PRIMARY KEY AUTOINCREMENT,json TEXT NOT NULL,sha256 TEXT NOT NULL,committed_at TEXT NOT NULL)"
			);
			db.prepare("ATTACH DATABASE ? AS receipt_journal").run(receiptPath);
			journalAttached = true;
			if (migrationContext) {
				assertMigrationContext();
				if (checkpointExpected("pointer", path.join(directory, "checkpoint.json")) === "absent")
					checkpointInternal();
			} else if (!fs.existsSync(path.join(directory, "checkpoint.json"))) checkpointInternal();
		} else db.exec("PRAGMA query_only=ON");
	} catch (error) {
		try {
			receipts?.close();
		} catch {}
		try {
			db.close();
		} catch {}
		throw error;
	}
	function ensureOpen() {
		if (closed) throw failure("LIBRARY_CLOSED");
	}
	function writable() {
		ensureOpen();
		if (mode !== "writable") throw failure("LIBRARY_READ_ONLY");
	}
	function checkEffectiveWrite(kind = "metadata") {
		for (const guard of [options.beforeWrite, options.assertEffectiveLibrary])
			if (guard) {
				const result = guard({ kind, libraryId: getMeta("libraryId"), directory });
				if (result === false || result?.then) throw failure("LIBRARY_NOT_EFFECTIVE");
			}
		if (migrationContext) {
			assertMigrationContext();
			checkpointExpected("pointer", path.join(directory, "checkpoint.json"));
		}
	}
	function assertMigrationContext() {
		const authority = migrationPermit(migrationContext.permit);
		if (authority.operation.operationId !== migrationContext.operationId || !authority.isTarget)
			throw failure("MIGRATION_CHECKPOINT_TARGET_REQUIRED");
		return authority;
	}
	function checkpointHook(method, value) {
		const result = migrationContext.checkpointIO[method](value);
		if (result?.then) throw failure("MIGRATION_CHECKPOINT_SYNCHRONOUS_REQUIRED");
		return result;
	}
	function checkpointExpected(kind, file) {
		const expected = checkpointHook("expected", { kind, path: file });
		if (expected === "absent") {
			if (fs.existsSync(file)) throw failure("MIGRATION_CHECKPOINT_UNKNOWN_ENTRY");
			return expected;
		}
		if (!expected || expected.path !== path.resolve(file))
			throw failure("MIGRATION_CHECKPOINT_EXPECTED_IDENTITY_REQUIRED");
		const current =
			kind === "directory" ? checkpointDirectoryIdentity(file) : checkpointFileIdentity(file);
		const fields =
			kind === "directory"
				? ["fileId", "birthtimeNs"]
				: ["fileId", "byteSize", "sha256", "changeToken"];
		if (
			fields.some((field) => expected[field] !== undefined && current[field] !== expected[field]) ||
			!expected.fileId ||
			(kind !== "directory" &&
				!["byteSize", "sha256", "changeToken"].every((field) => Object.hasOwn(expected, field)))
		)
			throw failure("MIGRATION_CHECKPOINT_EXPECTED_IDENTITY_CONFLICT");
		return current;
	}
	function checkpointChanged(action, kind, identity) {
		checkpointHook("changed", { action, kind, identity });
	}
	function getMeta(key) {
		const row = db.prepare("SELECT value FROM meta WHERE key=?").get(key);
		return row ? JSON.parse(row.value) : null;
	}
	function setMeta(key, value) {
		db.prepare(
			"INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
		).run(key, JSON.stringify(value));
		if (pendingChanges) pendingChanges.meta.push({ key, value: clone(value) });
	}
	function manager() {
		ensureOpen();
		return JSON.parse(db.prepare("SELECT json FROM manager WHERE singleton=1").get().json);
	}
	function assertManager(claim) {
		const active = manager();
		if (
			!claim ||
			claim.instanceId !== active.instanceId ||
			claim.epoch !== active.epoch ||
			active.instanceId !== processIdentity.instanceId ||
			!same(active.processIdentity, processIdentity)
		)
			throw failure("MANAGER_AUTHORITY_LOST");
		return active;
	}
	function read(kind, id) {
		ensureOpen();
		const row = db.prepare("SELECT json,sha256 FROM records WHERE kind=? AND id=?").get(kind, id);
		if (!row) return null;
		if (hash(row.json) !== row.sha256) throw failure("RECORD_INTEGRITY_FAILED");
		return JSON.parse(row.json);
	}
	function list(kind, filter = {}) {
		ensureOpen();
		if (!Object.hasOwn(protocol.RECORD_ID_FIELDS, kind)) throw failure("UNKNOWN_RECORD_KIND");
		let sql = "SELECT json,sha256 FROM records WHERE kind=?";
		const params = [kind];
		for (const [key, column] of [
			["taskId", "task_id"],
			["runId", "run_id"]
		])
			if (filter[key] !== undefined) {
				sql += " AND " + column + "=?";
				params.push(filter[key]);
			}
		if (filter.afterId !== undefined) {
			if (typeof filter.afterId !== "string") throw failure("INVALID_PAGE");
			sql += " AND id>?"; params.push(filter.afterId);
		}
		const limit = filter.limit ?? 1000,
			offset = filter.offset ?? 0;
		if (
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 10000 ||
			!Number.isSafeInteger(offset) ||
			offset < 0
		)
			throw failure("INVALID_PAGE");
		sql += " ORDER BY id LIMIT ? OFFSET ?";
		params.push(limit, offset);
		return db
			.prepare(sql)
			.all(...params)
			.map((row) => {
				if (hash(row.json) !== row.sha256) throw failure("RECORD_INTEGRITY_FAILED");
				return JSON.parse(row.json);
			});
	}
	/** Stable primary-key order without changing the public bounded page API.
	 * Record revisions and integrity hashes remain those of each stored row. */
	function* iterate(kind, filter = {}) {
		let afterId;
		for (;;) {
			const page = list(kind, { ...filter, limit: 1000, offset: 0, afterId });
			for (const record of page) yield record;
			if (page.length < 1000) return;
			afterId = page.at(-1)[protocol.RECORD_ID_FIELDS[kind]];
		}
	}
	function transaction(fn, { baseline = true, authorize } = {}) {
		writable();
		checkEffectiveWrite();
		authorize?.();
		// The durable attached journal covers every newer transaction. A bounded
		// periodic full baseline avoids copying all historical metadata per scalar update.
		if (journalAttached) {
			let pointer = JSON.parse(fs.readFileSync(path.join(directory, "checkpoint.json"), "utf8"));
			if (pointer.journalSequence === undefined) {
				checkpointInternal(authorize);
				pointer = JSON.parse(fs.readFileSync(path.join(directory, "checkpoint.json"), "utf8"));
			}
			if (
				pointer.libraryId !== getMeta("libraryId") ||
				!Number.isSafeInteger(pointer.journalSequence)
			)
				throw failure("CHECKPOINT_POINTER_INVALID");
			const size = db
				.prepare(
					"SELECT count(*) AS n,COALESCE(sum(length(json)),0) AS bytes FROM receipt_journal.metadata_commits WHERE sequence>?"
				)
				.get(pointer.journalSequence);
			if (size.n >= checkpointPolicy.commits || size.bytes >= checkpointPolicy.bytes) {
				try {
					checkpointInternal(authorize);
				} catch (error) {
					error.metadataOutcome = "not-started";
					throw error;
				}
			}
		} else if (baseline) checkpointInternal(authorize);
		db.exec("BEGIN IMMEDIATE");
		pendingChanges = {
			schemaVersion: 1,
			libraryId: getMeta("libraryId"),
			records: [],
			meta: [],
			appliedEvents: [],
			manager: null
		};
		let commitAttempted = false;
		try {
			checkEffectiveWrite();
			authorize?.();
			const value = fn();
			const artifactsChanged = pendingChanges.records.some(row => row.kind === "artifact");
			if (
				journalAttached &&
				(pendingChanges.records.length ||
					pendingChanges.meta.length ||
					pendingChanges.appliedEvents.length ||
					pendingChanges.manager)
			) {
				const json = JSON.stringify(pendingChanges);
				const receipt = db
					.prepare(
						"INSERT INTO receipt_journal.metadata_commits(json,sha256,committed_at) VALUES(?,?,?)"
					)
					.run(json, hash(json), now());
				db.prepare(
					"INSERT INTO meta VALUES('journalSequence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
				).run(JSON.stringify(Number(receipt.lastInsertRowid)));
				fault("metadata-journal-written");
			}
			fault("before-commit");
			commitAttempted = true;
			db.exec("COMMIT");
			if (artifactsChanged) artifactRevision++;
			pendingChanges = null;
			return value;
		} catch (error) {
			pendingChanges = null;
			try {
				db.exec("ROLLBACK");
			} catch {}
			if (commitAttempted)
				throw failure("METADATA_COMMIT_OUTCOME_UNCERTAIN", {
					cause: String(error),
					metadataOutcome: "unknown",
					mustInspectOriginalIntent: true
				});
			throw error;
		}
	}
	function assertNotMigrating(stop = false) {
		if (getMeta("migration") && !stop) throw failure("LIBRARY_MIGRATION_PAUSED");
	}
	function applyMutations(mutations, { resumeOperationId } = {}) {
		const records = [];
		const keys = new Set();
		for (const mutation of mutations || []) {
			const { kind, id, expectedRevision } = mutation;
			if (!Object.hasOwn(protocol.RECORD_ID_FIELDS, kind) || typeof id !== "string" || !id)
				throw failure("INVALID_MUTATION_ID");
			const key = kind + "\0" + id;
			if (keys.has(key)) throw failure("DUPLICATE_MUTATION");
			keys.add(key);
			const old = read(kind, id);
			if ((old?.revision ?? null) !== expectedRevision)
				throw failure("REVISION_CONFLICT", {
					kind,
					id,
					expectedRevision,
					actual: old?.revision ?? null
				});
			if (old)
				protocol.assertRecord(kind, old, { forWrite: true, supportedCapabilities: capabilities });
			const value = old ? protocol.mergeRecord(old, mutation.value) : clone(mutation.value);
			if (kind === "artifact") for (const guard of artifactReferenceGuards.values()) {
				if (guard.artifactId instanceof Set ? guard.artifactId.has(id) : guard.artifactId === id) continue;
				if (value.locations?.some(location => location.path === guard.path &&
					(location.environmentId == null || location.environmentId === guard.environmentId)))
					throw failure("ASSET_REFERENCE_CHANGE_DURING_DELETE");
			}
			if (
				value[protocol.RECORD_ID_FIELDS[kind]] !== id ||
				value.revision !== (expectedRevision === null ? 1 : expectedRevision + 1)
			)
				throw failure("INVALID_MUTATION_REVISION");
			protocol.assertRecord(kind, value, { forWrite: true, supportedCapabilities: capabilities });
			if (kind === "run" && old) {
				if (
					old.taskId !== value.taskId ||
					old.inputSnapshotId !== value.inputSnapshotId ||
					old.attemptOrdinal !== value.attemptOrdinal ||
					!same(old.environmentSnapshot, value.environmentSnapshot) ||
					!same(old.softwareSnapshot, value.softwareSnapshot)
				)
					throw failure("FROZEN_RUN_IDENTITY");
				if (
					old.state.executionState === "ended" &&
					(value.state.executionState !== "ended" || value.state.endReason !== old.state.endReason)
				)
					throw failure("TERMINAL_RUN_IMMUTABLE");
				for (const key of [
					"submissionIntentId",
					"workLocation",
					"executorIdentity",
					"launchIdentity",
					"launchReceipt",
					"endReceipt"
				])
					if (
						old.executionIdentity[key] !== null &&
						!same(old.executionIdentity[key], value.executionIdentity[key])
					)
						throw failure("EXECUTION_IDENTITY_IMMUTABLE");
				if (old.executionIdentity.schedulerEndReceipt &&
					!same(old.executionIdentity.schedulerEndReceipt, value.executionIdentity.schedulerEndReceipt))
					throw failure("EXECUTION_IDENTITY_IMMUTABLE");
				if (!old.executionIdentity.schedulerEndReceipt && value.executionIdentity.schedulerEndReceipt &&
					!require("../execution/scheduler-end.cjs").matchesSchedulerEndReceipt(value, value.executionIdentity.schedulerEndReceipt))
					throw failure("SLURM_SCHEDULER_END_CONFLICT");
				if (
					old.state.executionState !== value.state.executionState &&
					!protocol.canTransitionExecution(
						old.state.executionState,
						value.state.executionState,
						value.transitionEvidence
					)
				)
					throw failure("EXECUTION_EVIDENCE_REQUIRED");
			}
			if (kind === "inputSnapshot" && old) {
				for (const key of [
					"primaryInputArtifactId",
					"dependencies",
					"contentIdentity",
					"parsedRequests",
					"engineExtensions"
				])
					if (!same(old[key], value[key])) throw failure("INPUT_SNAPSHOT_IMMUTABLE");
			}
			if (kind === "operation" && old) {
				for (const key of [
					"operationId",
					"type",
					"targets",
					"preconditions",
					"authorizationScope",
					"owner"
				])
					if (!(key === "owner" && id === resumeOperationId) && !same(old[key], value[key]))
						throw failure("OPERATION_SCOPE_IMMUTABLE");
				if (
					old.operationState !== value.operationState &&
					!protocol.canTransitionOperation(
						old.operationState,
						value.operationState,
						value.transitionEvidence
					)
				)
					throw failure("OPERATION_EVIDENCE_REQUIRED");
			}
			if (old) {
				const json = JSON.stringify(old);
				db.prepare(
					"INSERT INTO previous_records VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,json=excluded.json,sha256=excluded.sha256"
				).run(kind, id, old.revision, json, hash(json));
			}
			const json = JSON.stringify(value);
			db.prepare(
				"INSERT INTO records VALUES(?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,task_id=excluded.task_id,run_id=excluded.run_id,json=excluded.json,sha256=excluded.sha256"
			).run(kind, id, value.revision, value.taskId ?? null, value.runId ?? null, json, hash(json));
			if (pendingChanges)
				pendingChanges.records.push({ kind, id, expectedRevision, value: clone(value) });
			records.push(value);
			fault("after-record:" + kind + ":" + id);
		}
		return records;
	}
	function operationPermit(permit) {
		ensureOpen();
		if (!permit?.token) throw failure("OPERATION_PERMIT_REQUIRED");
		const row = db
			.prepare("SELECT owner_json,token_hash FROM operation_permits WHERE operation_id=?")
			.get(permit.operationId);
		const owner = row && JSON.parse(row.owner_json);
		if (
			!row ||
			hash(permit.token) !== row.token_hash ||
			permit.ownerInstanceId !== owner.instanceId ||
			owner.instanceId !== processIdentity.instanceId ||
			!same(owner, processIdentity)
		)
			throw failure("OPERATION_PERMIT_INVALID");
		const operation = read("operation", permit.operationId);
		if (!operation || protocol.TERMINAL_OPERATION_STATES.includes(operation.operationState))
			throw failure("OPERATION_TERMINAL");
		return operation;
	}
	function permitFor(operation) {
		const token = crypto.randomBytes(32).toString("hex");
		db.prepare(
			"INSERT INTO operation_permits VALUES(?,?,?) ON CONFLICT(operation_id) DO UPDATE SET owner_json=excluded.owner_json,token_hash=excluded.token_hash"
		).run(operation.operationId, JSON.stringify(processIdentity), hash(token));
		return {
			operationId: operation.operationId,
			ownerInstanceId: processIdentity.instanceId,
			token
		};
	}
	function checkPermitMutations(operation, mutations) {
		for (const mutation of mutations || [])
			if (
				!operation.targets.some(
					(target) => target.kind === mutation.kind && target.id === mutation.id
				)
			)
				throw failure("OPERATION_TARGET_OUTSIDE_SCOPE");
	}
	function migrationPermit(permit) {
		const operation = operationPermit(permit);
		if (operation.type !== "migrate-library") throw failure("MIGRATION_OPERATION_REQUIRED");
		const scope = operation.authorizationScope;
		if (
			!scope ||
			scope.libraryId !== getMeta("libraryId") ||
			typeof scope.sourceDirectory !== "string" ||
			!path.isAbsolute(scope.sourceDirectory) ||
			typeof scope.targetDirectory !== "string" ||
			!path.isAbsolute(scope.targetDirectory)
		)
			throw failure("MIGRATION_SCOPE_INVALID");
		const source = path.resolve(scope.sourceDirectory),
			target = path.resolve(scope.targetDirectory);
		const key = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
		if (key(source) === key(target) || ![key(source), key(target)].includes(key(directory)))
			throw failure("MIGRATION_DIRECTORY_OUTSIDE_SCOPE");
		return { operation, source, target, isTarget: key(directory) === key(target) };
	}
	function migrationLocationMutations(authority, mutations) {
		if (!mutations.length) return;
		if (!authority.isTarget) throw failure("MIGRATION_LOCATION_WRITE_REQUIRES_TARGET");
		function mapped(value) {
			if (typeof value !== "string") return value;
			const relative = path.relative(authority.source, value);
			return relative &&
				relative !== ".." &&
				!relative.startsWith(".." + path.sep) &&
				!path.isAbsolute(relative)
				? path.join(authority.target, relative)
				: value;
		}
		const physicalFields = [
			"fileId",
			"changeToken",
			"modifiedMs",
			"modifiedAt",
			"mtimeMs",
			"mtimeNs",
			"ctimeMs",
			"ctimeNs",
			"checkedAt"
		];
		const keyPath = (value) =>
			process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
		function copied(location, content = {}, historical = false) {
			if (!location || typeof location.path !== "string") return;
			const previousPath = location.path,
				targetPath = mapped(previousPath);
			if (targetPath === previousPath) return;
			const relative = path.relative(authority.source, previousPath);
			const receipts = authority.operation.results.filter((row) => {
				const source = row.sourceIdentity || row.targetIdentity?.sourceIdentity,
					target = row.targetIdentity;
				return (
					source &&
					target &&
					typeof source.path === "string" &&
					path.isAbsolute(source.path) &&
					typeof target.path === "string" &&
					path.isAbsolute(target.path) &&
					keyPath(source.path) === keyPath(previousPath) &&
					keyPath(target.path) === keyPath(targetPath) &&
					typeof row.relativePath === "string" &&
					!path.isAbsolute(row.relativePath) &&
					path.normalize(row.relativePath) === path.normalize(relative)
				);
			});
			if (!receipts.length) {
				if (historical) {
					location.path = targetPath;
					return;
				}
				throw failure("MIGRATION_COPY_RECEIPT_REQUIRED");
			}
			let chosen;
			for (const row of receipts) {
				const source = row.sourceIdentity || row.targetIdentity.sourceIdentity,
					target = row.targetIdentity;
				if (
					typeof source.sha256 !== "string" ||
					!/^[a-f0-9]{64}$/i.test(source.sha256) ||
					source.sha256 !== target.sha256 ||
					!Number.isSafeInteger(source.byteSize) ||
					source.byteSize < 0 ||
					source.byteSize !== target.byteSize ||
					(location.sha256 !== undefined && location.sha256 !== source.sha256) ||
					(location.byteSize !== undefined && location.byteSize !== source.byteSize) ||
					(content.sha256 != null && content.sha256 !== source.sha256) ||
					(content.byteSize != null && content.byteSize !== source.byteSize)
				)
					throw failure("MIGRATION_COPY_RECEIPT_CONTENT_MISMATCH");
				if (
					(location.fileId !== undefined && location.fileId !== source.fileId) ||
					(location.changeToken !== undefined && location.changeToken !== source.changeToken)
				)
					throw failure("MIGRATION_COPY_RECEIPT_SOURCE_MISMATCH");
				if (
					typeof target.fileId !== "string" ||
					!target.fileId ||
					typeof target.changeToken !== "string" ||
					!target.changeToken
				)
					throw failure("MIGRATION_COPY_PHYSICAL_IDENTITY_REQUIRED");
				for (const field of physicalFields)
					if (
						Object.hasOwn(target, field) &&
						!(
							typeof target[field] === "string" ||
							(typeof target[field] === "number" && Number.isFinite(target[field]))
						)
					)
						throw failure("MIGRATION_COPY_PHYSICAL_FIELD_INVALID");
				if (
					chosen &&
					["fileId", "changeToken", "sha256", "byteSize"].some(
						(field) => chosen[field] !== target[field]
					)
				)
					throw failure("MIGRATION_COPY_RECEIPT_CONFLICT");
				chosen = target;
			}
			location.path = targetPath;
			location.byteSize = chosen.byteSize;
			location.sha256 = chosen.sha256;
			for (const field of physicalFields)
				if (Object.hasOwn(chosen, field)) location[field] = clone(chosen[field]);
		}
		for (const mutation of mutations) {
			if (!["artifact", "archiveManifest", "recycleRecord"].includes(mutation.kind))
				throw failure("MIGRATION_RECORD_KIND_OUTSIDE_SCOPE");
			const original = read(mutation.kind, mutation.id);
			if (!original || mutation.expectedRevision === null)
				throw failure("MIGRATION_EXISTING_RECORD_REQUIRED");
			const expected = clone(original),
				convert = (location) => {
					if (location && typeof location.path === "string") location.path = mapped(location.path);
				};
			expected.revision = original.revision + 1;
			if (mutation.kind === "artifact")
				for (const location of expected.locations || [])
					if (["frozen-input", "archive", "recycle"].includes(location.role))
						copied(location, {
							sha256:
								expected.contentHash?.algorithm === "sha256" ? expected.contentHash.hash : null,
							byteSize: expected.byteSize
						});
			if (mutation.kind === "archiveManifest") {
				convert(expected.targetLocation);
				for (const item of expected.items) {
					if (item.targetPath) item.targetPath = mapped(item.targetPath);
					if (item.recyclePath) item.recyclePath = mapped(item.recyclePath);
					copied(
						item.copyIdentity,
						{ sha256: item.sha256, byteSize: item.byteSize },
						item.storageState === "recycled"
					);
				}
			}
			if (mutation.kind === "recycleRecord") {
				for (const location of [...expected.originalLocations, ...expected.recycleLocations])
					convert(location);
				for (const item of expected.files || []) {
					convert(item.originalIdentity);
					copied(
						item.recycleIdentity,
						{},
						(expected.deletionResults || []).some(
							(result) => result.artifactId === item.artifactId && result.state === "deleted"
						)
					);
				}
			}
			if (!same(expected, protocol.mergeRecord(original, mutation.value)))
				throw failure("MIGRATION_LOCATION_MUTATION_INVALID");
		}
	}
	function managementOrMigrationAuthority(claim, permit, operationId) {
		if (claim && permit) throw failure("MIGRATION_AUTHORITY_AMBIGUOUS");
		if (!permit) return () => assertManager(claim);
		return () => {
			const authority = migrationPermit(permit);
			if (operationId !== undefined && authority.operation.operationId !== operationId)
				throw failure("MIGRATION_IDENTITY_MISMATCH");
			return authority;
		};
	}
	function checkpointInternal(authorize) {
		writable();
		checkEffectiveWrite("checkpoint");
		authorize?.();
		const checkpointDirectory = path.join(directory, "checkpoints");
		if (migrationContext) {
			if (checkpointExpected("directory", checkpointDirectory) === "absent") {
				fs.mkdirSync(checkpointDirectory);
				checkpointChanged("created", "directory", checkpointDirectoryIdentity(checkpointDirectory));
			}
		} else fs.mkdirSync(checkpointDirectory, { recursive: true });
		if (fs.lstatSync(checkpointDirectory).isSymbolicLink())
			throw failure("CHECKPOINT_LINK_REFUSED");
		const file = path.join(checkpointDirectory, "baseline-" + crypto.randomUUID() + ".sqlite");
		// DELETE journal + BEGIN IMMEDIATE prevents any writer changing the main DB while
		// copying it. No transaction pages have been modified by this checkpoint operation.
		// The same lock serializes pointer publication and journal compaction across processes.
		db.exec("BEGIN IMMEDIATE");
		try {
			checkEffectiveWrite("checkpoint");
			authorize?.();
			fs.copyFileSync(dbPath, file, fs.constants.COPYFILE_EXCL);
			flushFile(file);
			let bytes;
			if (migrationContext) {
				bytes = fs.readFileSync(file);
				checkpointChanged("created", "baseline", checkpointFileIdentity(file));
			}
			fault("checkpoint-candidate-flushed");
			bytes ||= fs.readFileSync(file);
			const candidate = new DatabaseSync(file, { readOnly: true });
			let sequence;
			try {
				if (
					candidate
						.prepare("PRAGMA quick_check")
						.all()
						.some((row) => Object.values(row)[0] !== "ok")
				)
					throw failure("CHECKPOINT_INTEGRITY_FAILED");
				for (const row of candidate.prepare("SELECT json,sha256,revision FROM records").all()) {
					if (hash(row.json) !== row.sha256 || JSON.parse(row.json).revision !== row.revision)
						throw failure("CHECKPOINT_RECORD_INTEGRITY_FAILED");
				}
				sequence = JSON.parse(
					candidate.prepare("SELECT value FROM meta WHERE key='journalSequence'").get()?.value ||
						"0"
				);
			} finally {
				candidate.close();
			}
			const result = {
				path: file,
				sha256: hash(bytes),
				byteSize: bytes.length,
				createdAt: now(),
				libraryId: getMeta("libraryId"),
				journalSequence: sequence
			};
			const pointer = path.join(directory, "checkpoint.json");
			const expectedPointer = migrationContext ? checkpointExpected("pointer", pointer) : undefined;
			let old = null;
			try {
				if (expectedPointer !== "absent") {
					if (fs.lstatSync(pointer).isSymbolicLink()) throw failure("CHECKPOINT_LINK_REFUSED");
					old = JSON.parse(fs.readFileSync(pointer, "utf8"));
				}
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			const previous = old
				? {
						path: old.path,
						sha256: old.sha256,
						byteSize: old.byteSize,
						createdAt: old.createdAt,
						libraryId: old.libraryId,
						journalSequence: old.journalSequence ?? 0
					}
				: null;
			atomicJSON(
				pointer,
				{ ...result, previous },
				migrationContext
					? (candidatePath, candidateIdentity) => {
							checkpointChanged("created", "pointer-candidate", candidateIdentity);
							const baselineIdentity = checkpointExpected("baseline", file);
							const receipt = checkpointHook("publishPointer", {
								operationId: migrationContext.operationId,
								destination: pointer,
								candidateIdentity,
								expectedCurrent: expectedPointer,
								baselineIdentity
							});
							const after = checkpointFileIdentity(pointer);
							if (
								!receipt?.after ||
								["path", "fileId", "byteSize", "sha256", "changeToken"].some(
									(field) => receipt.after[field] !== after[field]
								) ||
								after.fileId !== candidateIdentity.fileId ||
								after.byteSize !== candidateIdentity.byteSize ||
								after.sha256 !== candidateIdentity.sha256 ||
								receipt.operationId !== migrationContext.operationId ||
								receipt.libraryId !== getMeta("libraryId") ||
								(expectedPointer === "absent"
									? receipt.before !== "absent"
									: !receipt.before ||
										["path", "fileId", "byteSize", "sha256", "changeToken"].some(
											(field) => receipt.before[field] !== expectedPointer[field]
										))
							)
								throw failure("MIGRATION_CHECKPOINT_PUBLICATION_RECEIPT_CONFLICT");
							if (fs.existsSync(candidatePath))
								throw failure("MIGRATION_CHECKPOINT_CANDIDATE_NOT_RETIRED");
							return receipt;
						}
					: undefined
			);
			fault("checkpoint-published");
			// Keep every commit newer than the OLDER retained complete baseline, never just
			// the latest one. Thus either valid baseline plus journal can recover metadata.
			if (journalAttached && previous)
				db.prepare("DELETE FROM receipt_journal.metadata_commits WHERE sequence<=?").run(
					previous.journalSequence
				);
			db.exec("COMMIT");
			if (old?.previous?.path) {
				const obsolete = path.resolve(old.previous.path);
				if (
					path.dirname(obsolete) === checkpointDirectory &&
					/^baseline-[a-z0-9-]+\.sqlite$/i.test(path.basename(obsolete)) &&
					obsolete !== file &&
					obsolete !== old.path &&
					fs.existsSync(obsolete) &&
					!fs.lstatSync(obsolete).isSymbolicLink()
				) {
					const expectedObsolete = migrationContext
						? checkpointExpected("baseline", obsolete)
						: undefined;
					if (migrationContext && expectedObsolete === "absent")
						throw failure("MIGRATION_CHECKPOINT_RETIRED_IDENTITY_REQUIRED");
					fs.unlinkSync(obsolete);
					if (migrationContext) checkpointChanged("retired", "baseline", expectedObsolete);
				}
			}
			return result;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {}
			throw error;
		}
	}
	function receiptList(filters = {}) {
		ensureOpen();
		if (typeof filters === "boolean") filters = { pendingOnly: filters };
		const { pendingOnly = false, taskId, runId, limit, offset = 0 } = filters;
		if (
			typeof pendingOnly !== "boolean" ||
			(taskId !== undefined && (typeof taskId !== "string" || !taskId)) ||
			(runId !== undefined && (typeof runId !== "string" || !runId))
		)
			throw failure("INVALID_RECEIPT_FILTER");
		if (
			(limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)) ||
			!Number.isSafeInteger(offset) ||
			offset < 0
		)
			throw failure("INVALID_RECEIPT_PAGE");
		if (!receipts) return [];
		let sql = "SELECT r.receipt_id,r.json,r.sha256 FROM receipt_journal.receipts r WHERE 1=1";
		const parameters = [];
		if (taskId !== undefined) {
			sql += " AND json_extract(r.json,'$.taskId')=?";
			parameters.push(taskId);
		}
		if (runId !== undefined) {
			sql += " AND json_extract(r.json,'$.runId')=?";
			parameters.push(runId);
		}
		if (pendingOnly)
			sql += " AND NOT EXISTS (SELECT 1 FROM main.events_applied e WHERE e.event_id=r.event_id)";
		sql += " ORDER BY r.received_at,r.receipt_id";
		if (limit !== undefined) {
			sql += " LIMIT ? OFFSET ?";
			parameters.push(limit, offset);
		} else if (offset) {
			sql += " LIMIT -1 OFFSET ?";
			parameters.push(offset);
		}
		return db
			.prepare(sql)
			.all(...parameters)
			.map((row) => {
				if (hash(row.json) !== row.sha256) throw failure("RECEIPT_INTEGRITY_FAILED");
				return JSON.parse(row.json);
			});
	}
	const store = {
		describe() {
			ensureOpen();
			return {
				libraryId: getMeta("libraryId"),
				schemaVersion: getMeta("schemaVersion"),
				mode,
				root: getMeta("root"),
				requiredCapabilities: getMeta("requiredCapabilities") || [],
				checkpointPolicy: clone(checkpointPolicy),
				migration: getMeta("migration"),
				manager: manager()
			};
		},
		read,
		list,
		iterate,
		artifactRevision() { ensureOpen(); return `${artifactRevision}:${db.prepare("PRAGMA data_version").get().data_version}`; },
		async withArtifactReferenceGuard(location, action) {
			ensureOpen();
			if (!location || typeof location.path !== "string" || typeof action !== "function") throw failure("INVALID_REFERENCE_GUARD");
			const token = crypto.randomUUID(); artifactReferenceGuards.set(token, location);
			try { return await action(); } finally { artifactReferenceGuards.delete(token); }
		},
		assertManager,
		setRootMetadata({ manager: claim }) {
			transaction(() => {
				assertManager(claim);
				setMeta("root", directory);
			});
			const file = path.join(directory, "checkpoint.json");
			const pointer = JSON.parse(fs.readFileSync(file, "utf8"));
			let changed = false;
			for (const descriptor of [pointer, pointer.previous].filter(Boolean)) {
				const local = path.join(directory, "checkpoints", path.basename(descriptor.path));
				if (path.resolve(descriptor.path) === local) continue;
				const actual = checkpointFileIdentity(local);
				if (actual.sha256 !== descriptor.sha256 || actual.byteSize !== descriptor.byteSize)
					throw failure("RELOCATED_CHECKPOINT_IDENTITY_MISMATCH");
				descriptor.path = local;
				changed = true;
			}
			if (changed) atomicJSON(file, pointer);
		},
		requireCapabilities({ manager: claim, requiredCapabilities }) {
			if (
				!Array.isArray(requiredCapabilities) ||
				requiredCapabilities.some((value) => !capabilities.includes(value))
			)
				throw failure("LIBRARY_CAPABILITY_UNSUPPORTED");
			return transaction(() => {
				assertManager(claim);
				assertNotMigrating();
				setMeta("requiredCapabilities", [
					...new Set([...(getMeta("requiredCapabilities") || []), ...requiredCapabilities])
				]);
			});
		},
		async acquireManager() {
			writable();
			const before = manager();
			let status = "dead";
			if (before.instanceId) {
				if (same(before.processIdentity, processIdentity))
					return { acquired: true, manager: before };
				status = await probeProcessIdentity(clone(before.processIdentity));
				if (status !== "dead")
					return {
						acquired: false,
						manager: before,
						reason: status === "alive" ? "manager-alive" : "manager-unverified"
					};
			}
			return transaction(
				() => {
					const current = manager();
					if (!same(current, before))
						return { acquired: false, manager: current, reason: "manager-changed" };
					const next = {
						libraryId: getMeta("libraryId"),
						instanceId: processIdentity.instanceId,
						epoch: current.epoch + 1,
						processIdentity: clone(processIdentity)
					};
					db.prepare("UPDATE manager SET epoch=?,json=? WHERE singleton=1").run(
						next.epoch,
						JSON.stringify(next)
					);
					pendingChanges.manager = clone(next);
					return { acquired: true, manager: next };
				},
				{ baseline: false }
			);
		},
		releaseManager(claim) {
			return transaction(
				() => {
					const current = assertManager(claim);
					const next = {
						...current,
						instanceId: null,
						processIdentity: null,
						epoch: current.epoch + 1
					};
					db.prepare("UPDATE manager SET epoch=?,json=? WHERE singleton=1").run(
						next.epoch,
						JSON.stringify(next)
					);
					pendingChanges.manager = clone(next);
					return true;
				},
				{ baseline: false }
			);
		},
		commit({ manager: claim, mutations }) {
			writable();
			assertManager(claim);
			assertNotMigrating();
			return transaction(() => {
				assertManager(claim);
				assertNotMigrating();
				return applyMutations(mutations);
			});
		},
		beginOperation({ manager: claim, operation, mutations = [] }) {
			writable();
			assertManager(claim);
			assertNotMigrating(operation.type === "request-stop");
			return transaction(() => {
				assertManager(claim);
				assertNotMigrating(operation.type === "request-stop");
				if (operation.operationState !== "pending" || operation.revision !== 1)
					throw failure("OPERATION_INTENT_REQUIRED");
				protocol.assertRecord("operation", operation, {
					forWrite: true,
					supportedCapabilities: capabilities
				});
				const targetKeys = new Set();
				const recordRevisions = operation.targets.map(({ kind, id }) => {
					const key = kind + "\0" + id;
					if (targetKeys.has(key)) throw failure("DUPLICATE_OPERATION_TARGET");
					targetKeys.add(key);
					const mutation = mutations.find((item) => item.kind === kind && item.id === id);
					return {
						kind,
						id,
						expectedRevision: mutation
							? mutation.expectedRevision
							: (read(kind, id)?.revision ?? null)
					};
				});
				if (
					operation.preconditions.managerEpoch !== undefined &&
					operation.preconditions.managerEpoch !== claim.epoch
				)
					throw failure("OPERATION_PRECONDITION_CONFLICT");
				if (
					operation.preconditions.recordRevisions !== undefined &&
					!same(operation.preconditions.recordRevisions, recordRevisions)
				)
					throw failure("OPERATION_PRECONDITION_CONFLICT");
				const value = {
					...clone(operation),
					owner: clone(processIdentity),
					preconditions: {
						...clone(operation.preconditions),
						managerEpoch: claim.epoch,
						recordRevisions
					}
				};
				checkPermitMutations(value, mutations);
				const records = applyMutations([
					...mutations,
					{ kind: "operation", id: value.operationId, expectedRevision: null, value }
				]);
				const permit = permitFor(value);
				return { operation: records.at(-1), permit };
			});
		},
		operationPermit,
		commitOperation({ permit, expectedRevision, operation, mutations = [] }) {
			writable();
			const registered = operationPermit(permit);
			const authorize =
				registered.type === "migrate-library" ? () => migrationPermit(permit) : undefined;
			authorize?.();
			return transaction(
				() => {
					const old = operationPermit(permit);
					if (old.revision !== expectedRevision) throw failure("REVISION_CONFLICT");
					for (const key of [
						"operationId",
						"type",
						"targets",
						"preconditions",
						"authorizationScope",
						"owner"
					])
						if (!same(old[key], operation[key])) throw failure("OPERATION_SCOPE_IMMUTABLE");
					if (
						old.type === "migrate-library" &&
						(!Array.isArray(operation.results) ||
							operation.results.length < old.results.length ||
							old.results.some((result, index) => !same(result, operation.results[index])))
					)
						throw failure("MIGRATION_COPY_RESULTS_IMMUTABLE");
					if (
						old.operationState !== operation.operationState &&
						!protocol.canTransitionOperation(
							old.operationState,
							operation.operationState,
							operation.transitionEvidence
						)
					)
						throw failure("OPERATION_EVIDENCE_REQUIRED");
					checkPermitMutations(old, mutations);
					if (old.type === "migrate-library")
						migrationLocationMutations(migrationPermit(permit), mutations);
					const records = applyMutations([
						...mutations,
						{ kind: "operation", id: old.operationId, expectedRevision, value: operation }
					]);
					return { operation: records.at(-1), records: records.slice(0, -1) };
				},
				{ authorize }
			);
		},
		async resumeOperation({ manager: claim, operationId, expectedRevision, evidence }) {
			writable();
			assertManager(claim);
			const operation = read("operation", operationId);
			if (!operation || operation.revision !== expectedRevision) throw failure("REVISION_CONFLICT");
			const oldOwner = operation.owner;
			if (!oldOwner || (await probeProcessIdentity(clone(oldOwner))) !== "dead")
				throw failure("OPERATION_OWNER_NOT_DEAD");
			if (
				!["not-occurred", "occurred", "partial"].includes(evidence?.sideEffectState) ||
				!evidence.evidenceRefs?.length ||
				!Number.isFinite(Date.parse(evidence.checkedAt))
			)
				throw failure("SIDE_EFFECT_VERIFICATION_REQUIRED");
			return transaction(() => {
				assertManager(claim);
				const fresh = read("operation", operationId);
				if (
					!same(fresh, operation) ||
					protocol.TERMINAL_OPERATION_STATES.includes(fresh.operationState)
				)
					throw failure("OPERATION_RESUME_CONFLICT");
				const value = {
					...fresh,
					revision: fresh.revision + 1,
					owner: clone(processIdentity),
					recoveryEvidence: [...(fresh.recoveryEvidence || []), clone(evidence)]
				};
				const [savedOperation] = applyMutations(
					[{ kind: "operation", id: operationId, expectedRevision, value }],
					{
						resumeOperationId: operationId
					}
				);
				return { operation: savedOperation, permit: permitFor(savedOperation) };
			});
		},
		appendExecutionReceipt(receipt) {
			writable();
			for (const key of [
				"receiptId",
				"eventId",
				"operationId",
				"taskId",
				"runId",
				"submissionIntentId",
				"source"
			])
				if (typeof receipt?.[key] !== "string" || !receipt[key])
					throw failure("RECEIPT_IDENTITY_REQUIRED");
			if (
				!Number.isSafeInteger(receipt.sequence) ||
				receipt.sequence < 0 ||
				!receipt.evidenceRefs?.length
			)
				throw failure("RECEIPT_EVIDENCE_REQUIRED");
			const operation = read("operation", receipt.operationId),
				run = read("run", receipt.runId);
			if (
				!operation ||
				!run ||
				run.taskId !== receipt.taskId ||
				run.executionIdentity.submissionIntentId !== receipt.submissionIntentId ||
				!operation.targets.some((target) => target.kind === "run" && target.id === receipt.runId)
			)
				throw failure("RECEIPT_IDENTITY_MISMATCH");
			const json = JSON.stringify(receipt);
			receipts.exec("BEGIN IMMEDIATE");
			try {
				const old = receipts
					.prepare("SELECT json,sha256 FROM receipts WHERE receipt_id=? OR event_id=?")
					.get(receipt.receiptId, receipt.eventId);
				if (old) {
					if (old.sha256 !== hash(json) || old.json !== json) throw failure("RECEIPT_CONFLICT");
					receipts.exec("COMMIT");
					return { accepted: true, receiptId: receipt.receiptId, duplicate: true };
				}
				receipts
					.prepare("INSERT INTO receipts VALUES(?,?,?,?,?)")
					.run(receipt.receiptId, receipt.eventId, json, hash(json), now());
				fault("receipt-before-commit");
				receipts.exec("COMMIT");
				return { accepted: true, receiptId: receipt.receiptId };
			} catch (error) {
				try {
					receipts.exec("ROLLBACK");
				} catch {}
				throw error;
			}
		},
		listExecutionReceipts(filters = {}) {
			return receiptList(filters);
		},
		readExecutionReceipt(receiptId) {
			ensureOpen();
			if (typeof receiptId !== "string" || !receiptId) throw failure("RECEIPT_IDENTITY_REQUIRED");
			if (!receipts) return null;
			const row = receipts
				.prepare("SELECT json,sha256 FROM receipts WHERE receipt_id=?")
				.get(receiptId);
			if (!row) return null;
			if (hash(row.json) !== row.sha256) throw failure("RECEIPT_INTEGRITY_FAILED");
			return JSON.parse(row.json);
		},
		applyExecutionReceipt({ manager: claim, receiptId, mutations = [] }) {
			return transaction(() => {
				const active = assertManager(claim);
				const receipt = receiptList().find((item) => item.receiptId === receiptId);
				if (!receipt) throw failure("RECEIPT_NOT_FOUND");
				if (db.prepare("SELECT event_id FROM events_applied WHERE event_id=?").get(receipt.eventId))
					return [];
				const prior = db
					.prepare("SELECT sequence FROM source_sequences WHERE source=?")
					.get(receipt.source);
				if (prior && receipt.sequence <= prior.sequence) {
					// One native owner reports independent submit and conversion operations.
					// Their files may be observed out of order; only the same operation's
					// applied sequence can make this otherwise identity-checked receipt stale.
					const lane = db.prepare("SELECT MAX(e.sequence) AS sequence FROM events_applied e JOIN receipt_journal.receipts r ON r.receipt_id=e.receipt_id WHERE e.source=? AND json_extract(r.json,'$.operationId')=? AND json_extract(r.json,'$.runId')=?")
						.get(receipt.source, receipt.operationId, receipt.runId);
					if (lane.sequence !== null && receipt.sequence <= lane.sequence)
						throw failure("STALE_RECEIPT_SEQUENCE");
				}
				if (receipt.managerEpoch !== undefined && receipt.managerEpoch !== active.epoch)
					throw failure("STALE_MANAGER_EPOCH");
				if (
					receipt.sourceRevision !== undefined &&
					read("run", receipt.runId)?.revision !== receipt.sourceRevision
				)
					throw failure("STALE_SOURCE_REVISION");
				const operation = read("operation", receipt.operationId);
				checkPermitMutations(operation, mutations);
				const result = applyMutations(mutations);
				db.prepare("INSERT INTO events_applied VALUES(?,?,?,?,?)").run(
					receipt.eventId,
					receipt.source,
					receipt.sequence,
					receiptId,
					now()
				);
				pendingChanges.appliedEvents.push({
					eventId: receipt.eventId,
					source: receipt.source,
					sequence: receipt.sequence,
					receiptId,
					appliedAt: now()
				});
				db.prepare(
					"INSERT INTO source_sequences VALUES(?,?) ON CONFLICT(source) DO UPDATE SET sequence=MAX(sequence,excluded.sequence)"
				).run(receipt.source, receipt.sequence);
				return result;
			});
		},
		recoveryReport() {
			ensureOpen();
			let baseline = null;
			try {
				const pointer = JSON.parse(
					fs.readFileSync(path.join(directory, "checkpoint.json"), "utf8")
				);
				const bytes = fs.readFileSync(pointer.path);
				baseline = {
					...pointer,
					verified: bytes.length === pointer.byteSize && hash(bytes) === pointer.sha256
				};
			} catch (error) {
				baseline = { verified: false, error: String(error) };
			}
			return {
				integrity: integrity(),
				pendingOperations: Array.from(iterate("operation")).filter(
					(op) =>
						!protocol.TERMINAL_OPERATION_STATES.includes(op.operationState) &&
						!require("../operation-guards.cjs").isDeletedTaskOperation(store, op)
				),
				unverifiedRuns: Array.from(iterate("run")).filter(
					(run) =>
						!read("task", run.taskId)?.deleted &&
						(run.state.executionState !== "ended" || run.state.verificationState !== "verified")
				),
				pendingReceipts: receiptList(true),
				previousBaseline: baseline
			};
		},
		checkpoint({ manager: claim, permit } = {}) {
			const authorize = managementOrMigrationAuthority(claim, permit);
			authorize();
			return checkpointInternal(authorize);
		},
		setMigrationPause({ manager: claim, operationId, targetLibraryId, receiptLocation }) {
			return transaction(() => {
				assertManager(claim);
				if (getMeta("migration")) throw failure("MIGRATION_ALREADY_ACTIVE");
				const operation = read("operation", operationId);
				if (!operation || operation.type !== "migrate-library")
					throw failure("MIGRATION_OPERATION_REQUIRED");
				const value = {
					operationId,
					sourceLibraryId: getMeta("libraryId"),
					targetLibraryId,
					receiptLocation,
					phase: "paused",
					createdAt: now()
				};
				setMeta("migration", value);
				return value;
			});
		},
		clearMigrationPause({ manager: claim, permit, operationId }) {
			const authorize = managementOrMigrationAuthority(claim, permit, operationId);
			authorize();
			return transaction(
				() => {
					authorize();
					if (getMeta("migration")?.operationId !== operationId)
						throw failure("MIGRATION_IDENTITY_MISMATCH");
					setMeta("migration", null);
				},
				{ authorize }
			);
		},
		close() {
			if (closed) return;
			closed = true;
			try {
				receipts?.close();
			} finally {
				db.close();
			}
		}
	};
	return store;
}
module.exports = { openTaskLibrary, ...require("./recovery.cjs") };
