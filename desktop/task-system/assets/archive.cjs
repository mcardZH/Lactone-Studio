"use strict";
const {
	fs,
	path,
	fail,
	clone,
	ensureDirectory,
	exclusiveDirectory,
	unchanged,
	hashLocal,
	atomicJSON,
	copySource,
	removeExact
} = require("./io.cjs");
const { base, id, safeName, resultRoles, assertScopeSize, EXECUTION_BATCH_ITEMS, yieldIO } = require("./common.cjs");
function relativeTarget(root, relative) {
	if (typeof relative !== "string" || !relative || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === ".." || part.includes(":"))) throw fail("ASSET_ARCHIVE_RELATIVE_PATH_INVALID");
	return path.join(root, ...relative.split("/"));
}
function createArchive(context) {
	const {
		library,
		libraryDirectory,
		localEnvironmentId,
		safeState,
		begin,
		update,
		mutation,
		now,
		fault,
		transport,
		location,
		permits,
		assertEndedMetadata,
		claimRegistered,
		executionLocks
	} = context;
	async function planArchive(request) {
		library.assertManager(request.manager);
		const { run } = await safeState(request.taskId, request.runId);
		const task = library.read("task", request.taskId);
		if (task?.directoryMode === "single") throw fail("ASSET_LOCAL_SINGLE_DIRECTORY");
		const actualLayout = !!task?.directoryMode;
		let artifacts = request.artifacts || [];
		if (actualLayout) {
			const { inventory, ownedArtifactId } = require("./work-files.cjs");
			const listing = await inventory(await transport(request.sourceLocation.environmentId), request.sourceLocation);
			artifacts = listing.files.map(file => {
				const known = artifacts.find(artifact => artifact.locations?.some(location => location.environmentId === request.sourceLocation.environmentId && location.path === file.path));
				return { ...(known || {}), artifactId: known?.artifactId || ownedArtifactId(request.runId, file.relativePath),
					originalName: file.relativePath.split("/").at(-1), originalRelativePath: file.relativePath,
					source: { ...request.sourceLocation, path: file.path }, roles: known?.roles || [file.relativePath.startsWith("scratch/") ? "scratch" : "diagnostic"],
					producer: known?.producer || { kind: "task-work-directory", runId: request.runId },
					provenance: known?.provenance || { kind: "task-owned-file", taskId: request.taskId, runId: request.runId } };
			});
		}
		const manifestId = id("archive"),
			operationId = id("op"),
			target =
				library.read("task", request.taskId)?.plannedArchiveLocation?.path ||
				path.join(libraryDirectory, "archive", manifestId),
			items = [];
		const seen = new Set();
		for (const artifact of artifacts) {
			if (!artifact.artifactId || seen.has(artifact.artifactId)) throw fail("ASSET_DUPLICATE_ID");
			seen.add(artifact.artifactId);
			const source =
				artifact.source ||
				artifact.locations?.find((x) => x.role === "original") ||
				artifact.locations?.[0];
			const sourcePath = source?.path || artifact.path,
				environmentId = source?.environmentId || request.sourceLocation.environmentId;
			const roles = artifact.roles || [],
				known = !!artifact.producer && !!artifact.provenance;
			let reason = roles.includes("scratch")
				? "scratch-excluded"
				: !known
					? "unconfirmed-producer-or-provenance"
					: !roles.some((role) => resultRoles.has(role))
						? "unconfirmed-result-role"
						: !sourcePath
							? "source-location-missing"
							: "confirmed-result-and-provenance";
			const recommended = roles.some(role => ["input", "primary-output", "wavefunction", "restart", "structure", "trajectory", "modes"].includes(role)) || actualLayout && /\.(?:chk|gbw|fchk|fch|molden(?:\.input)?)$/i.test(artifact.originalName || "");
			if (actualLayout) {
				const isScratch = artifact.originalRelativePath.startsWith("scratch/");
				reason = request.archiveMode === "selected"
					? ((request.selectedArtifactIds ? request.selectedArtifactIds.includes(artifact.artifactId) : recommended) ? "selected-file" : "not-selected")
					: run.softwareSnapshot.engineId === "gaussian" && isScratch ? "scratch-excluded" : "task-owned-file";
			}
			const included = ["confirmed-result-and-provenance", "selected-file", "task-owned-file"].includes(reason);
			const item = {
				originalName:
					artifact.originalName ||
					artifact.preparedName ||
					path.basename(sourcePath || artifact.artifactId),
				format: artifact.format || null,
				formatVersion: artifact.formatVersion || null,
				representation: artifact.representation || "unknown",
				dependencies: artifact.dependencies || [],
				companionCandidate: artifact.companionCandidate || null,
				artifactId: artifact.artifactId,
				originalRelativePath: artifact.originalRelativePath || artifact.artifactId,
				sourceIdentity: {},
				sourceLocation: { environmentId, path: sourcePath || "" },
				roles,
				included,
				recommended,
				reason,
				copyState: "not-copied",
				verificationState: "not-verified",
				producer: artifact.producer || null,
				provenance: artifact.provenance || null
			};
			if (included || actualLayout) {
				try {
					const t = await transport(environmentId),
						identity = await t.stat(sourcePath);
					if (identity.isDirectory) throw fail("ASSET_NOT_REGULAR_FILE");
					const checked = await t.hash({ path: sourcePath, identity, algorithm: "sha256" });
					item.sourceIdentity = checked.identity;
					item.sha256 = checked.hash;
					item.byteSize = checked.identity.byteSize;
					item.targetPath = actualLayout ? relativeTarget(target, item.originalRelativePath) : path.join(target, safeName(artifact.artifactId) + ".asset");
				} catch (error) {
					item.included = false;
					item.reason =
						error.code === "ENOENT"
							? "source-missing"
							: "source-unavailable:" + (error.code || "unknown");
					item.verificationState = "unavailable";
				}
			}
			items.push(item);
		}
		return {
			...base(),
			requiredCapabilities: actualLayout ? ["es:task-layout-v2"] : [],
			manifestId,
			taskId: request.taskId,
			runId: request.runId,
			operationId,
			sourceLocation: clone(request.sourceLocation),
			targetLocation: location(target),
			items,
			...(actualLayout ? { fileLayout: "task-relative-v1", archiveMode: request.archiveMode || "default" } : {}),
			status: "planned",
			createdAt: now()
		};
	}
	function registerArchive({ manager, manifest }) {
		library.assertManager(manager);
		assertEndedMetadata(manifest.taskId, manifest.runId);
		assertScopeSize(manifest, manifest.items.length);
		if (!manifest.items.some((x) => x.included) || manifest.status !== "planned")
			throw fail("ASSET_EMPTY_OR_INVALID_ARCHIVE");
		const archiveRoot = path.join(libraryDirectory, "archive");
		const planned = library.read("task", manifest.taskId)?.plannedArchiveLocation?.path;
		if (
			(manifest.targetLocation.path !== path.join(archiveRoot, safeName(manifest.manifestId)) &&
				manifest.targetLocation.path !== planned) ||
			manifest.targetLocation.environmentId !== localEnvironmentId
		)
			throw fail("ASSET_ARCHIVE_TARGET_INVALID");
		const artifactIds = new Set();
		for (const item of manifest.items) {
			if (artifactIds.has(item.artifactId)) throw fail("ASSET_DUPLICATE_ID");
			artifactIds.add(item.artifactId);
			if (
				item.included &&
				(item.targetPath !== (manifest.fileLayout === "task-relative-v1" ? relativeTarget(manifest.targetLocation.path, item.originalRelativePath) :
					path.join(manifest.targetLocation.path, safeName(item.artifactId) + ".asset")) ||
					!item.producer ||
					!item.provenance ||
					(manifest.fileLayout !== "task-relative-v1" && (item.roles.includes("scratch") ||
					!item.roles.some((role) => resultRoles.has(role)))))
			)
				throw fail("ASSET_ARCHIVE_SCOPE_INVALID");
		}
		const op = begin(
			manager,
			"archive",
			[
				{ kind: "archiveManifest", id: manifest.manifestId },
				{ kind: "task", id: manifest.taskId }
			],
			{
				requiredCapabilities: manifest.requiredCapabilities || [],
				operationId: manifest.operationId,
				manifest: clone(manifest),
				effects: "copy-only-source-retained"
			}
		);
		return { operationId: op.operationId };
	}
	async function executeRegisteredArchive({ operationId, signal }) {
		let op = claimRegistered(operationId, "archive");
		const manifest = clone(op.authorizationScope.manifest);
		let copied = 0, pendingResults = [];
		const total = manifest.items.reduce((sum, item) => sum + Number(!!item.included), 0);
		try {
			await safeState(
				manifest.taskId,
				manifest.runId,
				manifest.items.filter((x) => x.included).map((x) => x.artifactId),
				op.operationId
			);
			await ensureDirectory(path.join(libraryDirectory, "archive"));
			if (
				library.read("task", manifest.taskId)?.plannedArchiveLocation?.path ===
				manifest.targetLocation.path
			) {
				const portable = require("../library/markers.cjs");
				const marker = portable.readMarker(path.join(manifest.targetLocation.path, "task.ddwz"));
				if (marker.value.id !== manifest.taskId)
					throw fail("ASSET_PLANNED_ARCHIVE_IDENTITY_CONFLICT");
				const names = await fs.readdir(manifest.targetLocation.path);
				if (names.some((name) => name !== "task.ddwz"))
					throw fail("ASSET_PLANNED_ARCHIVE_NOT_EMPTY");
			} else await exclusiveDirectory(manifest.targetLocation.path);
			await atomicJSON(path.join(manifest.targetLocation.path, "archive-owner.json"), {
				operationId: op.operationId,
				manifestId: manifest.manifestId,
				paths: manifest.items.filter((x) => x.included).map((x) => x.targetPath)
			});
			op = update(op, "copying", "running");
			const completed = clone(manifest);
			for (const item of completed.items.filter((x) => x.included)) {
				await ensureDirectory(path.dirname(item.targetPath));
				const t = await transport(item.sourceLocation.environmentId);
				const copy = await copySource(
					{ path: item.sourceLocation.path, identity: item.sourceIdentity, sha256: item.sha256 },
					item.targetPath,
					{ transport: t, signal, fault }
				);
				item.copyState = "copied";
				item.verificationState = "verified";
				item.copyIdentity = copy;
				pendingResults.push({ artifactId: item.artifactId, copy }); copied++;
				if (pendingResults.length === EXECUTION_BATCH_ITEMS || copied === total) {
					op = update(op, "copying", "running", pendingResults, [], { completed: copied, total, unit: "files" });
					pendingResults = []; await yieldIO();
				}
			}
			await safeState(
				manifest.taskId,
				manifest.runId,
				completed.items.filter((x) => x.included).map((x) => x.artifactId),
				op.operationId
			);
			// Every earlier source is rechecked after the final copy, before publication.
			for (const item of completed.items.filter((x) => x.included)) {
				const t = await transport(item.sourceLocation.environmentId);
				const current = await t.hash({
					path: item.sourceLocation.path,
					identity: item.sourceIdentity,
					algorithm: "sha256"
				});
				if (!unchanged(item.sourceIdentity, current.identity) || current.hash !== item.sha256)
					throw fail("ASSET_SOURCE_CHANGED");
			}
			completed.status = "verified";
			completed.verifiedAt = now();
			await atomicJSON(path.join(completed.targetLocation.path, "manifest.json"), completed);
			const portable = require("../library/markers.cjs"),
				markerFile = path.join(completed.targetLocation.path, "task.ddwz");
			let marker = null;
			try {
				marker = portable.readMarker(markerFile);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			const task = library.read("task", completed.taskId),
				mainItem =
					completed.items.find((item) => item.included && item.roles.includes("primary-output")) ||
					completed.items.find((item) => item.included);
			portable.writeMarker(
				markerFile,
				{
					...(marker?.value || {}),
					version: 1,
					id: completed.taskId,
					name: marker?.value.name || task?.displayName || completed.taskId,
					date: marker?.value.date || completed.createdAt.slice(0, 10),
					main: path.basename(mainItem.targetPath),
					sourceVersion: completed.runId,
					note: marker?.value.note || "",
					management: marker?.value.management || task?.management || portable.management(null)
				},
				marker?.identity ?? null
			);
			const archivedLocation = portable.locate(
				libraryDirectory,
				completed.targetLocation.path,
				"archive"
			);
			archivedLocation.markerPath =
				archivedLocation.scope === "library"
					? path.relative(libraryDirectory, markerFile)
					: markerFile;
			const registeredTask = {
				...task,
				revision: task.revision + 1,
				archiveState: "archived",
				management: portable.readMarker(markerFile).value.management,
				requiredCapabilities: [
					...new Set([...(task.requiredCapabilities || []), "es:task-marker-v1"])
				],
				locations: [
					...(task.locations || []).filter((row) => row.locationId !== archivedLocation.locationId),
					archivedLocation
				]
			};
			await fault("archive-before-register", { manifest: completed });
			update(
				op,
				"registered",
				"succeeded",
				[{ manifestId: completed.manifestId }],
				[
					mutation("archiveManifest", completed.manifestId, completed),
					mutation("task", completed.taskId, registeredTask, task.revision)
				]
			);
			return completed;
		} catch (error) {
			update(op, "needs-inspection", "waiting-verification", [...pendingResults,
				{ error: error.code || String(error) }
			]);
			throw error;
		} finally {
			executionLocks.delete(operationId);
		}
	}
	async function archive({ manager, manifest, signal }) {
		const registered = registerArchive({ manager, manifest });
		return executeRegisteredArchive({ operationId: registered.operationId, signal });
	}
	async function recoverArchive({ operationId }) {
		let op = library.read("operation", operationId);
		if (!op || op.type !== "archive") throw fail("ASSET_ARCHIVE_OPERATION_REQUIRED");
		if (!permits.has(operationId)) throw fail("ASSET_OPERATION_RESUME_REQUIRED");
		const manifest = clone(op.authorizationScope.manifest);
		if (library.read("archiveManifest", manifest.manifestId))
			throw fail("ASSET_ARCHIVE_ALREADY_REGISTERED");
		await safeState(
			manifest.taskId,
			manifest.runId,
			manifest.items.filter((x) => x.included).map((x) => x.artifactId),
			op.operationId
		);
		for (const item of manifest.items.filter((x) => x.included)) {
			const current = await hashLocal(item.targetPath);
			if (current.sha256 !== item.sha256 || current.byteSize !== item.byteSize)
				throw fail("ASSET_INCOMPLETE_COPY");
			const t = await transport(item.sourceLocation.environmentId),
				source = await t.hash({
					path: item.sourceLocation.path,
					identity: item.sourceIdentity,
					algorithm: "sha256"
				});
			if (!unchanged(item.sourceIdentity, source.identity) || source.hash !== item.sha256)
				throw fail("ASSET_SOURCE_CHANGED");
			item.copyState = "copied";
			item.verificationState = "verified";
			item.copyIdentity = current;
		}
		manifest.status = "verified";
		manifest.verifiedAt = now();
		manifest.recovered = true;
		// Existing marker is evidence only. Refuse mismatched content rather than overwrite it.
		const marker = path.join(manifest.targetLocation.path, "manifest.json");
		try {
			const value = JSON.parse(await fs.readFile(marker, "utf8"));
			if (
				value.manifestId !== manifest.manifestId ||
				value.items.some(
					(x) =>
						x.included &&
						!manifest.items.some((y) => y.artifactId === x.artifactId && y.sha256 === x.sha256)
				)
			)
				throw fail("ASSET_ARCHIVE_MARKER_CONFLICT");
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
			await atomicJSON(marker, manifest);
		}
		update(
			op,
			"recovered-registered",
			"succeeded",
			[{ verifiedAt: now() }],
			[mutation("archiveManifest", manifest.manifestId, manifest)]
		);
		return manifest;
	}
	async function retryArchive({ operationId, signal }) {
		let op = library.read("operation", operationId);
		if (!op || op.type !== "archive" || !permits.has(operationId))
			throw fail("ASSET_OPERATION_RESUME_REQUIRED");
		const manifest = clone(op.authorizationScope.manifest);
		await safeState(
			manifest.taskId,
			manifest.runId,
			manifest.items.filter((x) => x.included).map((x) => x.artifactId),
			op.operationId
		);
		const ownerPath = path.join(manifest.targetLocation.path, "archive-owner.json");
		await hashLocal(ownerPath);
		const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"));
		if (
			owner.operationId !== operationId ||
			owner.manifestId !== manifest.manifestId ||
			JSON.stringify(owner.paths) !==
				JSON.stringify(manifest.items.filter((x) => x.included).map((x) => x.targetPath))
		)
			throw fail("ASSET_CANDIDATE_OWNER_CONFLICT");
		for (const item of manifest.items.filter((x) => x.included)) {
			const t = await transport(item.sourceLocation.environmentId);
			let current = null;
			try {
				current = await hashLocal(item.targetPath);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			if (current && current.byteSize === item.byteSize && current.sha256 === item.sha256) continue;
			if (current) {
				if (current.byteSize > item.byteSize) throw fail("ASSET_CANDIDATE_CONTENT_CONFLICT");
				const prefix = await t.hash({
					path: item.sourceLocation.path,
					identity: item.sourceIdentity,
					algorithm: "sha256",
					range: { offset: 0, length: current.byteSize }
				});
				if (prefix.hash !== current.sha256 || !unchanged(item.sourceIdentity, prefix.identity))
					throw fail("ASSET_CANDIDATE_CONTENT_CONFLICT");
				await removeExact(manifest.targetLocation.path, current);
			}
			const copy = await copySource(
				{ path: item.sourceLocation.path, identity: item.sourceIdentity, sha256: item.sha256 },
				item.targetPath,
				{ transport: t, signal, fault }
			);
			op = update(op, "retrying-affected-copy", "running", [{ artifactId: item.artifactId, copy }]);
		}
		return recoverArchive({ operationId });
	}

	return {
		planArchive,
		archive,
		recoverArchive,
		retryArchive,
		registerArchive,
		executeRegisteredArchive
	};
}
module.exports = { createArchive };
