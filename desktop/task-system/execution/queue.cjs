"use strict";
/** Bounds control/file work. Native jobs have their own persistent owners, not these slots. */
function createExecutionQueue({ concurrency = 2 } = {}) {
	if (!Number.isSafeInteger(concurrency) || concurrency < 1)
		throw new Error("INVALID_QUEUE_CONCURRENCY");
	const pending = [],
		activeKeys = new Set();
	let active = 0;
	function pump() {
		while (active < concurrency) {
			const index = pending.findIndex((item) => !activeKeys.has(item.key));
			if (index < 0) return;
			const item = pending.splice(index, 1)[0];
			active++;
			activeKeys.add(item.key);
			Promise.resolve()
				.then(item.work)
				.then(item.resolve, item.reject)
				.finally(() => {
					active--;
					activeKeys.delete(item.key);
					pump();
				});
		}
	}
	return {
		run(key, work) {
			return new Promise((resolve, reject) => {
				pending.push({ key, work, resolve, reject });
				pump();
			});
		},
		status: () => ({ active, pending: pending.length })
	};
}
module.exports = { createExecutionQueue };
