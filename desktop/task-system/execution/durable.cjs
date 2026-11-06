"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { sha256, fail } = require("./common.cjs");
const { isCancellationClaim } = require("./claims.cjs");
async function writeExclusive(file, bytes) {
	const temporary = `${file}.candidate-${crypto.randomUUID()}`;
	const handle = await fs.open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await fs.link(temporary, file);
	} finally {
		await fs.unlink(temporary);
	}
}
async function readJson(file) {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}
async function writeReceipt(directory, name, receipt) {
	const file = path.join(directory, name);
	const bytes = Buffer.from(JSON.stringify(receipt));
	await writeExclusive(file, bytes);
	return { file, sha256: sha256(bytes) };
}
async function claimIntent(directory, manifest) {
	const file = path.join(directory, "intent-claim.json"),
		digest = sha256(Buffer.from(JSON.stringify(manifest)));
	try {
		await writeExclusive(
			file,
			Buffer.from(
				JSON.stringify({
					protocolVersion: 1,
					submissionIntentId: manifest.submissionIntentId,
					runId: manifest.runId,
					manifestHash: digest,
					claimedAt: new Date().toISOString()
				})
			)
		);
		return { claimed: true, digest };
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		const previous = await readJson(file);
		if (isCancellationClaim(previous, manifest)) return { claimed: false, cancelled: true, digest };
		if (
			previous?.manifestHash !== digest ||
			previous.runId !== manifest.runId ||
			previous.submissionIntentId !== manifest.submissionIntentId
		)
			fail("INTENT_IDENTITY_CONFLICT");
		return { claimed: false, digest };
	}
}
module.exports = { writeExclusive, readJson, writeReceipt, claimIntent };
