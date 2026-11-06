"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
function fail(code) {
	const error = new Error(code);
	error.code = code;
	return error;
}
function noLinks(file, mustExist = true) {
	let current = path.resolve(file);
	while (true) {
		try {
			if (fs.lstatSync(current).isSymbolicLink()) throw fail("RECOVERY_LINK_REFUSED");
		} catch (error) {
			if (error.code !== "ENOENT" || (current === path.resolve(file) && mustExist)) throw error;
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
}
function identity(file) {
	noLinks(file);
	const stat = fs.statSync(file);
	const bytes = fs.readFileSync(file);
	return {
		path: file,
		sha256: digest(bytes),
		byteSize: bytes.length,
		fileId: `${stat.dev}:${stat.ino}`,
		modifiedMs: stat.mtimeMs
	};
}
function loadBaseline(options) {
	const directory = path.resolve(options.directory);
	noLinks(directory);
	const sourcePath = path.join(directory, "library.sqlite");
	const sourceEvidence = () => {
		try {
			return identity(sourcePath);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			return { path: sourcePath, missing: true, sha256: null, byteSize: null };
		}
	};
	const source = sourceEvidence();
	const pointerPath = path.join(directory, "checkpoint.json");
	noLinks(pointerPath);
	const pointerIdentity = identity(pointerPath);
	const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
	const failures = [];
	let baseline = null;
	for (const descriptor of [pointer, pointer.previous].filter(Boolean)) {
		let database;
		try {
			const file = path.resolve(descriptor.path);
			if (
				path.dirname(file) !== path.join(directory, "checkpoints") ||
				!/^baseline-[a-z0-9-]+\.sqlite$/i.test(path.basename(file))
			)
				throw fail("BASELINE_PATH_INVALID");
			const actual = identity(file);
			if (actual.sha256 !== descriptor.sha256 || actual.byteSize !== descriptor.byteSize)
				throw fail("BASELINE_HASH_MISMATCH");
			database = new DatabaseSync(file, { readOnly: true });
			if (
				database
					.prepare("PRAGMA quick_check")
					.all()
					.some((row) => Object.values(row)[0] !== "ok")
			)
				throw fail("BASELINE_INTEGRITY_FAILED");
			for (const row of database.prepare("SELECT json,sha256,revision FROM records").all())
				if (digest(row.json) !== row.sha256 || JSON.parse(row.json).revision !== row.revision)
					throw fail("BASELINE_RECORD_INTEGRITY_FAILED");
			const meta = (key) =>
				JSON.parse(
					database.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value || "null"
				);
			if (meta("schemaVersion") !== 1) throw fail("BASELINE_SCHEMA_UNSUPPORTED");
			const libraryId = meta("libraryId");
			if (
				libraryId !== descriptor.libraryId ||
				(options.libraryId && libraryId !== options.libraryId)
			)
				throw fail("BASELINE_LIBRARY_MISMATCH");
			const sequence = meta("journalSequence") || 0;
			if (descriptor.journalSequence !== undefined && sequence !== descriptor.journalSequence)
				throw fail("BASELINE_SEQUENCE_MISMATCH");
			baseline = { ...actual, libraryId, schemaVersion: 1, journalSequence: sequence };
			break;
		} catch (error) {
			failures.push({ path: descriptor.path, code: error.code || String(error) });
		} finally {
			database?.close();
		}
	}
	if (!baseline) throw fail("NO_VALID_BASELINE");
	const journalPath = path.join(directory, "execution-receipts.sqlite");
	noLinks(journalPath);
	const journalIdentity = identity(journalPath);
	const journal = new DatabaseSync(journalPath, { readOnly: true });
	let commits;
	try {
		journal.exec("BEGIN");
		if (
			journal
				.prepare("PRAGMA quick_check")
				.all()
				.some((row) => Object.values(row)[0] !== "ok")
		)
			throw fail("RECOVERY_JOURNAL_INTEGRITY_FAILED");
		commits = journal
			.prepare(
				"SELECT sequence,json,sha256,committed_at FROM metadata_commits WHERE sequence>? ORDER BY sequence"
			)
			.all(baseline.journalSequence);
		let expected = baseline.journalSequence + 1;
		for (const commit of commits) {
			if (commit.sequence !== expected++ || digest(commit.json) !== commit.sha256)
				throw fail("RECOVERY_JOURNAL_GAP_OR_HASH");
			commit.value = JSON.parse(commit.json);
			if (commit.value.schemaVersion !== 1 || commit.value.libraryId !== baseline.libraryId)
				throw fail("RECOVERY_JOURNAL_IDENTITY");
		}
		journal.exec("COMMIT");
	} finally {
		journal.close();
	}
	if (
		sourceEvidence().sha256 !== source.sha256 ||
		identity(journalPath).sha256 !== journalIdentity.sha256 ||
		identity(pointerPath).sha256 !== pointerIdentity.sha256
	)
		throw fail("RECOVERY_SOURCE_CHANGED");
	return { directory, source, baseline, journalIdentity, commits, failures };
}
function summary(loaded) {
	return {
		source: loaded.source,
		baseline: loaded.baseline,
		journal: {
			...loaded.journalIdentity,
			commits: loaded.commits.map((commit) => ({
				sequence: commit.sequence,
				sha256: commit.sha256,
				committedAt: commit.committed_at
			})),
			lastSequence: loaded.commits.at(-1)?.sequence ?? loaded.baseline.journalSequence
		},
		issues: loaded.failures
	};
}
/** Read-only evidence. Neither this function nor recovery launches or inspects external software. */
function inspectBaseline(options) {
	return summary(loadBaseline(options));
}

/** Prepare an inactive candidate in a brand-new directory; effective-pointer ownership stays outside. */
function prepareRecoveredLibrary(options) {
	const loaded = loadBaseline(options);
	const targetDirectory = path.resolve(options.targetDirectory);
	const relative = path.relative(loaded.directory, targetDirectory);
	if (
		!relative ||
		(!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
	)
		throw fail("RECOVERY_TARGET_INSIDE_SOURCE");
	noLinks(path.dirname(targetDirectory), false);
	if (fs.existsSync(targetDirectory)) throw fail("RECOVERY_TARGET_MUST_NOT_EXIST");
	if (!options.protocol?.assertRecord) throw fail("RECOVERY_PROTOCOL_REQUIRED");
	fs.mkdirSync(targetDirectory, { recursive: true });
	noLinks(targetDirectory);
	const targetPath = path.join(targetDirectory, "library.sqlite");
	fs.copyFileSync(loaded.baseline.path, targetPath, fs.constants.COPYFILE_EXCL);
	fs.copyFileSync(
		loaded.journalIdentity.path,
		path.join(targetDirectory, "execution-receipts.sqlite"),
		fs.constants.COPYFILE_EXCL
	);
	const db = new DatabaseSync(targetPath);
	const unverifiedRunIds = [];
	try {
		db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE");
		const writeMeta = (key, value) =>
			db
				.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
				.run(key, JSON.stringify(value));
		for (const commit of loaded.commits) {
			for (const mutation of commit.value.records) {
				const { kind, id, expectedRevision, value } = mutation;
				const current = db
					.prepare("SELECT revision,json,sha256 FROM records WHERE kind=? AND id=?")
					.get(kind, id);
				if ((current?.revision ?? null) !== expectedRevision)
					throw fail("RECOVERY_RECORD_REVISION_CONFLICT");
				options.protocol.assertRecord(kind, value, {
					forWrite: true,
					supportedCapabilities: options.supportedCapabilities || []
				});
				if (
					value[options.protocol.RECORD_ID_FIELDS[kind]] !== id ||
					value.revision !== (expectedRevision === null ? 1 : expectedRevision + 1)
				)
					throw fail("RECOVERY_RECORD_IDENTITY");
				const json = JSON.stringify(value);
				db.prepare(
					"INSERT INTO records VALUES(?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,task_id=excluded.task_id,run_id=excluded.run_id,json=excluded.json,sha256=excluded.sha256"
				).run(
					kind,
					id,
					value.revision,
					value.taskId ?? null,
					value.runId ?? null,
					json,
					digest(json)
				);
			}
			for (const item of commit.value.meta) writeMeta(item.key, item.value);
			if (commit.value.manager)
				db.prepare("UPDATE manager SET epoch=?,json=? WHERE singleton=1").run(
					commit.value.manager.epoch,
					JSON.stringify(commit.value.manager)
				);
			for (const event of commit.value.appliedEvents) {
				db.prepare("INSERT OR IGNORE INTO events_applied VALUES(?,?,?,?,?)").run(
					event.eventId,
					event.source,
					event.sequence,
					event.receiptId,
					event.appliedAt
				);
				db.prepare(
					"INSERT INTO source_sequences VALUES(?,?) ON CONFLICT(source) DO UPDATE SET sequence=MAX(sequence,excluded.sequence)"
				).run(event.source, event.sequence);
			}
			writeMeta("journalSequence", commit.sequence);
		}
		// Restoring metadata cannot certify today's external processes, even for previously ended runs.
		for (const row of db.prepare("SELECT id,json FROM records WHERE kind='run'").all()) {
			const run = JSON.parse(row.json);
			options.protocol.assertRecord("run", run, {
				forWrite: true,
				supportedCapabilities: options.supportedCapabilities || []
			});
			run.state = {
				...run.state,
				verificationState: "stale",
				recoveryReason: "metadata-baseline-restored-external-verification-required"
			};
			run.revision += 1;
			const json = JSON.stringify(run);
			db.prepare("UPDATE records SET revision=?,json=?,sha256=? WHERE kind='run' AND id=?").run(
				run.revision,
				json,
				digest(json),
				row.id
			);
			unverifiedRunIds.push(row.id);
		}
		writeMeta("recovery", {
			source: loaded.source,
			baseline: loaded.baseline,
			journalSequence: loaded.commits.at(-1)?.sequence ?? loaded.baseline.journalSequence,
			preparedAt: new Date().toISOString(),
			requiresExternalVerification: true
		});
		db.exec("COMMIT");
		if (
			db
				.prepare("PRAGMA quick_check")
				.all()
				.some((row) => Object.values(row)[0] !== "ok")
		)
			throw fail("RECOVERED_LIBRARY_INTEGRITY_FAILED");
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {}
		throw error;
	} finally {
		db.close();
	}
	const fd = fs.openSync(targetPath, "r+");
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	const copiedJournal = new DatabaseSync(path.join(targetDirectory, "execution-receipts.sqlite"), {
		readOnly: true
	});
	try {
		if (
			copiedJournal
				.prepare("PRAGMA quick_check")
				.all()
				.some((row) => Object.values(row)[0] !== "ok")
		)
			throw fail("RECOVERED_JOURNAL_INTEGRITY_FAILED");
	} finally {
		copiedJournal.close();
	}
	const journalFD = fs.openSync(path.join(targetDirectory, "execution-receipts.sqlite"), "r+");
	try {
		fs.fsyncSync(journalFD);
	} finally {
		fs.closeSync(journalFD);
	}
	if (
		(loaded.source.missing
			? fs.existsSync(loaded.source.path)
			: identity(loaded.source.path).sha256 !== loaded.source.sha256) ||
		identity(loaded.journalIdentity.path).sha256 !== loaded.journalIdentity.sha256
	)
		throw fail("RECOVERY_SOURCE_CHANGED");
	const result = {
		...summary(loaded),
		targetDirectory,
		target: identity(targetPath),
		unverifiedRunIds,
		inactive: true,
		externalActionsReplayed: false,
		effectivePointerChanged: false
	};
	const receiptFile = path.join(targetDirectory, "recovery-receipt.json");
	const receiptFD = fs.openSync(receiptFile, "wx");
	try {
		fs.writeFileSync(receiptFD, JSON.stringify(result, null, 2) + "\n");
		fs.fsyncSync(receiptFD);
	} finally {
		fs.closeSync(receiptFD);
	}
	return result;
}
module.exports = { inspectBaseline, prepareRecoveredLibrary };
