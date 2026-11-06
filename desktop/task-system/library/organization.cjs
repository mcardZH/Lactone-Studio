"use strict";
const crypto = require("node:crypto");
const { fail } = require("../platform/global-settings.cjs");
const { listAll } = require("../operation-guards.cjs");
const CAP = "es:task-multigroup-v1";
const membershipId = (taskId, groupId) =>
	"membership-" +
	crypto
		.createHash("sha256")
		.update(JSON.stringify([taskId, groupId]))
		.digest("hex");
const base = () => ({ schemaVersion: 1, revision: 1, requiredCapabilities: [CAP] });
function memberships(store, taskId) {
	return listAll(store, "groupMembership")
		.filter((row) => !row.deleted && (!taskId || row.taskId === taskId));
}
function groupIds(store, task) {
	const records = memberships(store, task.taskId);
	const ids = records.map((row) => row.groupId);
	if (!task.requiredCapabilities?.includes(CAP) && task.groupId) ids.push(task.groupId);
	return [...new Set(ids)].filter((id) => {
		const group = store.read("group", id);
		return group && !group.deleted;
	});
}
function membershipMutations(store, taskIds, groupId, remove = false) {
	const group = store.read("group", groupId);
	if (!group || group.deleted) throw fail("GROUP_NOT_FOUND");
	return [...new Set(taskIds)].flatMap((taskId) => {
		if (!store.read("task", taskId)) throw fail("TASK_NOT_FOUND");
		const id = membershipId(taskId, groupId),
			old = store.read("groupMembership", id);
		if (old && Boolean(old.deleted) === remove) return [];
		return [
			{
				kind: "groupMembership",
				id,
				expectedRevision: old?.revision ?? null,
				value: {
					...(old || base()),
					membershipId: id,
					taskId,
					groupId,
					deleted: remove,
					revision: (old?.revision || 0) + 1
				}
			}
		];
	});
}
function migrate(store, manager) {
	const mutations = [];
	for (const task of listAll(store, "task")) {
		if (task.requiredCapabilities?.includes(CAP)) continue;
		if (task.groupId && store.read("group", task.groupId))
			mutations.push(...membershipMutations(store, [task.taskId], task.groupId));
		mutations.push({
			kind: "task",
			id: task.taskId,
			expectedRevision: task.revision,
			value: {
				...task,
				revision: task.revision + 1,
				requiredCapabilities: [...new Set([...(task.requiredCapabilities || []), CAP])]
			}
		});
	}
	if (mutations.length) store.commit({ manager, mutations });
}
function descendants(store, groupId) {
	const result = new Set([groupId]),
		groups = listAll(store, "group").filter((row) => !row.deleted);
	let changed = true;
	while (changed) {
		changed = false;
		for (const group of groups)
			if (result.has(group.parentGroupId) && !result.has(group.groupId)) {
				result.add(group.groupId);
				changed = true;
			}
	}
	return result;
}
module.exports = { membershipId, memberships, groupIds, membershipMutations, migrate, descendants };
