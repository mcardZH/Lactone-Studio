"use strict";
const fs = require("node:fs"),
	path = require("node:path"),
	crypto = require("node:crypto"),
	{ DatabaseSync } = require("node:sqlite");
const { fail, noLinks } = require("./global-settings.cjs");
/** OS-owned shared/exclusive transactions; separate from task metadata and portable roots. */
function createIOAdmission({ directory, libraryId }) {
	if (!path.isAbsolute(directory) || typeof libraryId !== "string" || !libraryId)
		throw fail("IO_ADMISSION_COMPOSITION_REQUIRED");
	noLinks(directory);
	fs.mkdirSync(directory, { recursive: true });
	const file = path.join(
		directory,
		crypto.createHash("sha256").update(libraryId).digest("hex") + ".sqlite"
	);
	function acquire(mode) {
		if (!["read", "write"].includes(mode)) throw fail("IO_ADMISSION_MODE_INVALID");
		noLinks(file);
		let db;
		try {
			db = new DatabaseSync(file);
			db.exec("PRAGMA busy_timeout=0;");
			const exists = db
				.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='anchor'")
				.get();
			if (!exists)
				db.exec(
					"PRAGMA journal_mode=DELETE;CREATE TABLE anchor(singleton INTEGER PRIMARY KEY,value TEXT NOT NULL);INSERT INTO anchor VALUES(1,'io-admission-v1');"
				);
			db.exec(mode === "write" ? "BEGIN EXCLUSIVE" : "BEGIN");
			if (
				db.prepare("SELECT value FROM anchor WHERE singleton=1").get()?.value !== "io-admission-v1"
			)
				throw fail("IO_ADMISSION_FORMAT_UNSUPPORTED");
			let released = false;
			return {
				mode,
				release() {
					if (released) return;
					released = true;
					try {
						db.exec("ROLLBACK");
					} finally {
						db.close();
					}
				}
			};
		} catch (error) {
			try {
				db?.close();
			} catch {}
			if (error.code === "IO_ADMISSION_FORMAT_UNSUPPORTED") throw error;
			throw fail("TASK_SOURCE_IO_BUSY", { mode });
		}
	}
	async function run(mode, work, { wait = false, signal } = {}) {
		let lease;
		for (;;) {
			if (signal?.aborted) throw fail("TASK_SOURCE_IO_CANCELLED");
			try {
				lease = acquire(mode);
				break;
			} catch (error) {
				if (!wait || error.code !== "TASK_SOURCE_IO_BUSY") throw error;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
		try {
			return await work();
		} finally {
			lease.release();
		}
	}
	return { acquire, run, file };
}
module.exports = { createIOAdmission };
