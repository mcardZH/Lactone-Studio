"use strict";
const path = require("node:path");
const { quote, sha256, fail, basename } = require("./common.cjs");
const { commandScript } = require("../transports/posix.cjs");
const { cancellationClaim } = require("./claims.cjs");
function softwareCheck(identity, content) {
	const target = quote(identity.path);
	const stat = `TZ=UTC LC_ALL=C stat -Lc '%d:%i|%s|%y|%z' -- ${target}`;
	if (!content) return `test ! -L ${target} && test "$(${stat})" = ${quote(`${identity.fileId}|${identity.byteSize}|${identity.modifiedAt}|${identity.changeToken}`)}`;
	if (content.path !== identity.path || content.byteSize !== identity.byteSize || !/^[a-f0-9]{64}$/.test(content.sha256))
		fail("SLURM_SOFTWARE_CONTENT_UNVERIFIED");
	const noLinks = [];
	for (let current = identity.path; ; current = path.posix.dirname(current)) {
		noLinks.push(`test ! -L ${quote(current)}`);
		if (path.posix.dirname(current) === current) break;
	}
	const pathChecks = noLinks.join(" && ");
	return `( ${pathChecks} && test -f ${target} && before=$(${stat}) && test "$(stat -Lc %s -- ${target})" = ${quote(String(content.byteSize))} && digest=$(sha256sum -- ${target}) && test "\${digest%% *}" = ${quote(content.sha256)} && ${pathChecks} && after=$(${stat}) && test "$before" = "$after" )`;
}
/** Generate owned, immutable shell sources; only the explicit initialization field is code. */
function buildPosixRunner(manifest) {
	const root = manifest.workLocation.path,
		state = `${root}/.es-execution`,
		hash = sha256(Buffer.from(JSON.stringify(manifest)));
	if (manifest.command.cwd !== root) fail("WORK_LOCATION_MISMATCH");
	const base = {
		protocolVersion: 1,
		taskId: manifest.taskId,
		runId: manifest.runId,
		submissionIntentId: manifest.submissionIntentId,
		operationId: manifest.operationId,
		source: `es-posix-runner:1.0.0:${manifest.runId}`,
		payloadVersion: 1
	};
	const jsonPrefix = (type, sequence, operationId = manifest.operationId) =>
		JSON.stringify({
			...base,
			operationId,
			receiptId: `${manifest.submissionIntentId}:${type}:${sequence}`,
			eventId: `${manifest.submissionIntentId}:${type}:${sequence}`,
			eventType: type,
			sequence,
			evidenceRefs: [`${state}/${type}`]
		}).slice(0, -1);
	if (manifest.calculationScript) {
		if (manifest.calculationScript.kind !== "bash") fail("CALCULATION_SCRIPT_PLATFORM_MISMATCH");
		const actual = require("../engines/calculation-script.cjs").calculationScriptIdentity(
			manifest.calculationScript
		);
		if (
			actual.hash !== manifest.calculationScriptIdentity?.hash ||
			actual.byteSize !== manifest.calculationScriptIdentity?.byteSize
		)
			fail("CALCULATION_SCRIPT_IDENTITY_CHANGED");
	}
	const engine =
		manifest.calculationScript?.text ??
		`#!/usr/bin/env bash\nset -e\n${manifest.initialization || ""}\n${commandScript(manifest.command)}${manifest.command.stdinPath ? ` < ${quote(manifest.command.stdinPath)}` : ""}\n`;
	const runner = `#!/usr/bin/env bash
set -u
umask 077
cd -- ${quote(root)} || exit 70
state=${quote(state)}
# A claim is permanent. A missing receipt never permits another native launch.
publish() { local name="$1"; local text="$2"; local tmp="$state/$name.candidate.$$"; (set -C; printf '%s' "$text" > "$tmp") || return; sync -- "$tmp" && ln -- "$tmp" "$state/$name"; local rc=$?; rm -f -- "$tmp"; return "$rc"; }
if test -d "$state/claimed" && ! test -f "$state/intent-claim.json"; then exit 0; fi
claim_prefix=$(printf '%s' ${quote(JSON.stringify({ protocolVersion: 1, runId: manifest.runId, submissionIntentId: manifest.submissionIntentId, manifestHash: hash }).slice(0, -1))})
claim_now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if ! publish intent-claim.json "$(printf '%s,"claimedAt":"%s"}' "$claim_prefix" "$claim_now")"; then
  if test "$(cat -- "$state/intent-claim.json")" = ${quote(JSON.stringify(cancellationClaim(manifest)))}; then
    prefix=$(printf '%s' ${quote(jsonPrefix("run.ended", 2))});now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    publish end.json "$(printf '%s,"occurredAt":"%s","payload":{"notStarted":true,"exitCode":null,"signal":null,"endReason":"stopped","processTree":{"verified":true,"notStarted":true}}}' "$prefix" "$now")"
  fi
  exit 0
fi
${manifest.softwareIdentity ? [manifest.softwareIdentity.entry, ...manifest.softwareIdentity.members].map((identity, index) => {
	const content = manifest.slurmSoftwareContent?.software[index];
	if (manifest.slurmSoftwareContent && !content) fail("SLURM_SOFTWARE_CONTENT_UNVERIFIED");
	return `${softwareCheck(identity, content)} || exit 75`;
}).join("\n") : ""}
${(manifest.inputFiles || [])
	.map((input) => {
		const file = `${root}/${basename(input.name)}`;
		return `test ! -L ${quote(file)} && test "$(stat -Lc %s -- ${quote(file)})" = ${quote(String(input.byteSize))} && test "$(sha256sum -- ${quote(file)} | cut -d ' ' -f 1)" = ${quote(input.sha256)} || { prefix=$(printf '%s' ${quote(jsonPrefix("run.verification-required", 1))}); now=$(date -u +%Y-%m-%dT%H:%M:%SZ); publish runner-error.json "$(printf '%s,"occurredAt":"%s","payload":{"code":"PREPARED_INPUT_CHANGED","notStarted":true}}' "$prefix" "$now")"; exit 73; }`;
	})
	.join("\n")}
launched_uptime=$(awk '{print $1}' /proc/uptime)
setsid bash ${quote(`${state}/engine.sh`)} </dev/null &
native_pid=$!
boot_id=$(cat /proc/sys/kernel/random/boot_id)
user_id=$(id -u)
ticks=null
if test -r "/proc/$native_pid/stat"; then ticks=$(sed 's/.*) //' "/proc/$native_pid/stat" | awk '{print $20}'); fi
clock_ticks=$(getconf CLK_TCK 2>/dev/null || true)
if test "$ticks" != null && test -n "$clock_ticks" && test "$clock_ticks" -gt 0 2>/dev/null; then launched_uptime=$(LC_ALL=C awk -v ticks="$ticks" -v hz="$clock_ticks" 'BEGIN { if (hz>0) printf "%.6f", ticks/hz }'); fi
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
prefix=$(printf '%s' ${quote(jsonPrefix("run.launched", 1))})
cwd_json=$(printf '%s' ${quote(JSON.stringify(root))})
publish launch.json "$(printf '%s,"occurredAt":"%s","payload":{"pid":%s,"identity":{"kind":"linux","pid":%s,"userId":"%s","bootId":"%s","startTicks":%s,"cwd":%s},"manifestHash":"%s"}}' "$prefix" "$now" "$native_pid" "$native_pid" "$user_id" "$boot_id" "$ticks" "$cwd_json" ${quote(hash)})"
wait "$native_pid"
native_rc=$?
# The primary handle may close before an MPI child; do not publish a whole-run end early.
while true; do
  group_rows=$(ps -eo pgid=,stat=) || exit 72
  if ! printf '%s\\n' "$group_rows" | awk -v group="$native_pid" '$1 == group && $2 !~ /^Z/ { found=1 } END { exit !found }'; then break; fi
  sleep 0.1
done
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ended_uptime=$(awk '{print $1}' /proc/uptime)
reason=completed
if test "$native_rc" -ne 0; then reason=failed; fi
stop_result=''
${manifest.executionFeatures?.includes("posix-stop-dispatch-v1")
	? `if test "$native_rc" -ne 0 && test -f "$state/stop-intent.json"; then
  # The runner can reap the group before the control shell publishes its TERM proof.
  # Wait only for the same live dispatch owner, never a reused PID.
  if test ! -L "$state/stop-dispatch-owner" && {
    read -r dispatch_pid dispatch_ticks && read -r dispatch_binding && read -r dispatch_intent
  } < "$state/stop-dispatch-owner"; then
    expected_binding=$(printf '%s,"pid":%s,"bootId":"%s","startTicks":%s,"manifestHash":"%s"}' ${quote(JSON.stringify({ runId: manifest.runId, submissionIntentId: manifest.submissionIntentId }).slice(0, -1))} "$native_pid" "$boot_id" "$ticks" ${quote(hash)})
    if test "$dispatch_binding" = "$expected_binding" && [[ "$dispatch_pid:$dispatch_ticks" =~ ^[0-9]+:[0-9]+$ ]]; then
      while ! test -f "$state/stop-dispatched.json"; do
        dispatch_stat=$(sed 's/.*) //' "/proc/$dispatch_pid/stat" 2>/dev/null) || break
        if ! printf '%s\\n' "$dispatch_stat" | awk -v ticks="$dispatch_ticks" '$1 !~ /^Z/ && $20 == ticks {found=1} END {exit !found}'; then break; fi
        sleep 0.05
      done
      attempt="$state/stop-signal-attempt.$dispatch_pid.$dispatch_ticks.json"
      stop_op=$(printf '%s' "$dispatch_intent" | sed -nE 's/^\\{"operationId":"([A-Za-z0-9_.:-]+)".*/\\1/p')
      expected_intent=$(printf '{"operationId":"%s",%s,"pid":%s,"bootId":"%s","startTicks":%s}' "$stop_op" ${quote(JSON.stringify({ runId: manifest.runId, submissionIntentId: manifest.submissionIntentId }).slice(1, -1))} "$native_pid" "$boot_id" "$ticks")
      if test -n "$stop_op" && test "$dispatch_intent" = "$expected_intent" &&
        test ! -L "$attempt" && test ! -L "$state/stop-intent.json" && test ! -L "$state/stop-dispatched.json" &&
        test "$(cat -- "$attempt")" = "$expected_intent" &&
        test "$(cat -- "$state/stop-intent.json")" = "$expected_intent" &&
        test "$(cat -- "$state/stop-dispatched.json")" = "$expected_intent"; then
        reason=stopped
        stop_result=$(printf ',"nativeExitReason":"failed","stopOperationId":"%s"' "$stop_op")
      fi
    fi
  fi
fi`
	: 'if test -f "$state/stop-intent.json"; then reason=stopped; fi'}
prefix=$(printf '%s' ${quote(jsonPrefix("run.ended", 2))})
elapsed_seconds=$(LC_ALL=C awk -v start="$launched_uptime" -v finish="$ended_uptime" 'BEGIN { if (start!="" && finish!="" && finish>=start && start>=0) printf "%.3f", finish-start; else printf "null" }')
publish end.json "$(printf '%s,"occurredAt":"%s","payload":{"exitCode":%s,"endedAt":"%s","endReason":"%s","runtimeTiming":{"kind":"linux-boot-uptime-v1","clockDomain":"%s","elapsedSeconds":%s},"processTree":{"verified":true,"scope":"linux-session","pid":%s,"bootId":"%s","userId":"%s"}%s}}' "$prefix" "$now" "$native_rc" "$now" "$reason" "$boot_id" "$elapsed_seconds" "$native_pid" "$boot_id" "$user_id" "$stop_result")"
${buildPreparation(manifest, state, jsonPrefix)}
`;
	const preparation = `#!/usr/bin/env bash\nset -u\numask 077\ncd -- ${quote(root)} || exit 70\nstate=${quote(state)}\ntest -f "$state/end.json" -o -f "$state/recovered-end.json" || exit 74\npublish() { local name="$1"; local text="$2"; local tmp="$state/$name.candidate.$$"; (set -C; printf '%s' "$text" > "$tmp") || return; sync -- "$tmp" && ln -- "$tmp" "$state/$name"; local rc=$?; rm -f -- "$tmp"; return "$rc"; }\n${buildPreparation(manifest, state, jsonPrefix)}\n`;
	return {
		engine: Buffer.from(engine),
		runner: Buffer.from(runner),
		preparation: Buffer.from(preparation),
		manifestHash: hash
	};
}
function buildPreparation(manifest, state, jsonPrefix) {
	const preparation = manifest.resultPreparation;
	if (!preparation) return "";
	if (
		!preparation.operationId ||
		!preparation.toolIdentity ||
		!preparation.sourceArtifactId ||
		preparation.compatibleWithRun !== true
	)
		fail("PREPARATION_UNVERIFIED");
	const directory = `${state}/preparation`,
		source = `${directory}/${basename(preparation.sourceCopyName || path.posix.basename(preparation.sourcePath))}`,
		output = `${directory}/${basename(preparation.outputName)}`,
		publishedOutput = manifest.fileLayout === "task-relative-v1" ? `${manifest.workLocation.path}/${basename(preparation.outputName)}` : output;
	const replacements = {
		"{source}": source,
		"{sourceBase}": source.replace(/\.[^.]+$/, ""),
		"{output}": output
	};
	const command = {
		...preparation.command,
		cwd: directory,
		args: preparation.command.args.map((value) => replacements[value] || value),
		stdoutPath: `${directory}/conversion-stdout.txt`,
		stderrPath: `${directory}/conversion-stderr.txt`
	};
	const entry = preparation.toolIdentity.entryIdentity;
	const converter = manifest.slurmSoftwareContent?.converter;
	if (manifest.slurmSoftwareContent && (!converter || !entry || entry.path !== preparation.command.executable))
		fail("SLURM_CONVERTER_CONTENT_UNVERIFIED");
	const converterCheck = entry?.fileId ? softwareCheck({ ...entry, path: preparation.command.executable }, converter) : "";
	return `
# Runs synchronously before this wrapper (and a Slurm allocation) can finish.
preparation_ok=false
preparation_code=PREPARATION_SOURCE_UNVERIFIED
source_json=null
output_json=null
end_json=null
not_started=true
if mkdir -- ${quote(directory)}; then
  cancel_preparation() {
    if test -f "$state/stop-intent.json" || test -f "$state/preparation-stop-intent.json" || { test -f "$state/end.json" && grep -Eq '"notStarted"[[:space:]]*:[[:space:]]*true' "$state/end.json"; }; then
      prefix=$(printf '%s' ${quote(jsonPrefix("operation.preparation-ended", 4, preparation.operationId))}); now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      publish preparation-end.json "$(printf '%s,"occurredAt":"%s","payload":{"succeeded":false,"cancelled":true,"notStarted":true,"code":"PREPARATION_CANCELLED_BEFORE_START"}}' "$prefix" "$now")"
      return 0
    fi
    return 1
  }
  if cancel_preparation; then exit 0; fi
  ${converterCheck ? `${converterCheck} || { preparation_code=CONVERSION_TOOL_CHANGED; prefix=$(printf '%s' ${quote(jsonPrefix("operation.preparation-ended", 4, preparation.operationId))});now=$(date -u +%Y-%m-%dT%H:%M:%SZ);publish preparation-end.json "$(printf '%s,"occurredAt":"%s","payload":{"succeeded":false,"notStarted":true,"code":"CONVERSION_TOOL_CHANGED"}}' "$prefix" "$now")";exit 0; }` : ""}
  before=$(test ! -L ${quote(preparation.sourcePath)} && test -f ${quote(preparation.sourcePath)} && TZ=UTC LC_ALL=C stat -Lc '%d:%i|%s|%y|%z' -- ${quote(preparation.sourcePath)} 2>/dev/null)
  if test -n "$before" && cp --no-clobber -- ${quote(preparation.sourcePath)} ${quote(source)}; then
    source_hash=$(sha256sum -- ${quote(preparation.sourcePath)} | cut -d ' ' -f 1)
    copy_hash=$(sha256sum -- ${quote(source)} | cut -d ' ' -f 1)
    after=$(test ! -L ${quote(preparation.sourcePath)} && TZ=UTC LC_ALL=C stat -Lc '%d:%i|%s|%y|%z' -- ${quote(preparation.sourcePath)})
    if test "$before" = "$after" && test "$source_hash" = "$copy_hash"; then
      if cancel_preparation; then exit 0; fi
      setsid bash -c ${quote(`${preparation.initialization ?? manifest.initialization ?? ""}\n${commandScript(command)}`)} </dev/null &
      preparation_pid=$!
      not_started=false
      preparation_boot=$(cat /proc/sys/kernel/random/boot_id)
      preparation_user=$(id -u)
      preparation_ticks=null
      if test -r "/proc/$preparation_pid/stat"; then preparation_ticks=$(sed 's/.*) //' "/proc/$preparation_pid/stat" | awk '{print $20}'); fi
      prefix=$(printf '%s' ${quote(jsonPrefix("operation.preparation-launched", 3, preparation.operationId))})
      now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      source_prefix=$(printf '%s' ${quote(JSON.stringify({ sourcePath: preparation.sourcePath, copyPath: source, sourceArtifactId: preparation.sourceArtifactId }).slice(0, -1))})
      source_size=$(stat -Lc %s -- ${quote(source)})
      source_json=$(printf '%s,"sha256":"%s","byteSize":%s}' "$source_prefix" "$source_hash" "$source_size")
      preparation_cwd=$(printf '%s' ${quote(JSON.stringify(directory))})
      publish preparation-launch.json "$(printf '%s,"occurredAt":"%s","payload":{"source":%s,"sourceHash":"%s","identity":{"kind":"linux","pid":%s,"userId":"%s","bootId":"%s","startTicks":%s,"cwd":%s}}}' "$prefix" "$now" "$source_json" "$source_hash" "$preparation_pid" "$preparation_user" "$preparation_boot" "$preparation_ticks" "$preparation_cwd")"
      wait "$preparation_pid"
      conversion_rc=$?
      while true; do
        group_rows=$(ps -eo pgid=,stat=) || exit 72
        if ! printf '%s\\n' "$group_rows" | awk -v group="$preparation_pid" '$1 == group && $2 !~ /^Z/ { found=1 } END { exit !found }'; then break; fi
        sleep 0.1
      done
      ended_now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      end_json=$(printf '{"exitCode":%s,"signal":null,"endedAt":"%s","processTree":{"verified":true,"scope":"linux-session","pid":%s,"bootId":"%s","userId":"%s"}}' "$conversion_rc" "$ended_now" "$preparation_pid" "$preparation_boot" "$preparation_user")
      preparation_code=CONVERSION_FAILED
      if test "$conversion_rc" -eq 0 && test -s ${quote(output)} && test "$source_hash" = "$(sha256sum -- ${quote(preparation.sourcePath)} | cut -d ' ' -f 1)" ${publishedOutput !== output ? `&& test ! -e ${quote(publishedOutput)} && cp --no-clobber -- ${quote(output)} ${quote(publishedOutput)} && test "$(sha256sum -- ${quote(output)} | cut -d ' ' -f 1)" = "$(sha256sum -- ${quote(publishedOutput)} | cut -d ' ' -f 1)"` : ""}; then
        preparation_ok=true; preparation_code=CONVERSION_COMPLETE
        output_size=$(stat -Lc %s -- ${quote(publishedOutput)})
        output_digest=$(sha256sum -- ${quote(publishedOutput)} | cut -d ' ' -f 1)
        output_prefix=$(printf '%s' ${quote(JSON.stringify({ path: publishedOutput }).slice(0, -1))})
        output_json=$(printf '%s,"sha256":"%s","byteSize":%s}' "$output_prefix" "$output_digest" "$output_size")
      fi
    fi
  fi
else
  # Existing claim may own a live conversion. Do not overwrite its state or run it twice.
  exit 0
fi
prefix=$(printf '%s' ${quote(jsonPrefix("operation.preparation-ended", 4, preparation.operationId))})
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
tool_json=$(printf '%s' ${quote(JSON.stringify(preparation.toolIdentity))})
publish preparation-end.json "$(printf '%s,"occurredAt":"%s","payload":{"succeeded":%s,"notStarted":%s,"code":"%s","source":%s,"output":%s,"toolIdentity":%s,"end":%s}}' "$prefix" "$now" "$preparation_ok" "$not_started" "$preparation_code" "$source_json" "$output_json" "$tool_json" "$end_json")"
`;
}
function linuxProbeScript(identity, stop = false, nativeStop) {
	if (
		identity?.kind !== "linux" ||
		!Number.isSafeInteger(identity.pid) ||
		identity.pid < 1 ||
		!Number.isSafeInteger(identity.startTicks)
	)
		fail("EXECUTION_IDENTITY_UNVERIFIED");
	const pid = identity.pid;
	const binding = nativeStop && {
		runId: nativeStop.intent.runId,
		submissionIntentId: nativeStop.intent.submissionIntentId,
		pid, bootId: identity.bootId, startTicks: identity.startTicks,
		manifestHash: nativeStop.manifestHash
	};
	const endCheck = nativeStop ? `if test -f ${quote(nativeStop.end)}; then printf ended; exit 0; fi; ` : "";
	const signal = nativeStop ? `
umask 077
state=${quote(nativeStop.state)}
intent=${quote(JSON.stringify(nativeStop.intent))}
binding=${quote(JSON.stringify(binding))}
test "$(command realpath -e -- "$state")" = "$state" || { printf conflict; exit 0; }
test ! -L ${quote(nativeStop.manifest)} && test "$(sha256sum -- ${quote(nativeStop.manifest)} | cut -d ' ' -f 1)" = ${quote(nativeStop.manifestHash)} || { printf conflict; exit 0; }
test ! -L "$state/stop-dispatch.lock" || { printf conflict; exit 0; }
exec 9>>"$state/stop-dispatch.lock" || { printf unknown; exit 0; }
command flock -n 9 || { printf unknown; exit 0; }
publish_stop() {
  local name="$1" tmp="$state/$1.candidate.$$"
  (set -C; printf '%s\\n' "$2" > "$tmp") || return
  ln -- "$tmp" "$state/$name"
  local rc=$?
  rm -f -- "$tmp"
  return "$rc"
}
owner="$state/stop-dispatch-owner"
if test -f "$owner"; then
  {
    read -r old_pid old_ticks
    read -r old_binding
    read -r old_intent
  } < "$owner" || { printf unknown; exit 0; }
  test "$old_binding" = "$binding" || { printf conflict; exit 0; }
  if test -f "$state/stop-intent.json"; then
    test "$(cat -- "$state/stop-intent.json")" = "$old_intent" || { printf conflict; exit 0; }
  fi
  intent="$old_intent"
  case "$old_pid:$old_ticks" in *[!0-9:]*|:*|*:) printf conflict; exit 0;; esac
  if cmp -s -- "$state/stop-intent.json" "$state/stop-dispatched.json"; then printf requested; exit 0; fi
  if test -d "/proc/$old_pid"; then
    old_stat=$(sed 's/.*) //' "/proc/$old_pid/stat") || { printf unknown; exit 0; }
    if printf '%s\\n' "$old_stat" | awk -v ticks="$old_ticks" '$1 !~ /^Z/ && $20 == ticks {found=1} END {exit !found}'; then printf unknown; exit 0; fi
  fi
elif test -e "$state/stop-intent.json"; then
  printf conflict; exit 0
fi
${endCheck}
owner_ticks=$(sed 's/.*) //' "/proc/$$/stat" | awk '{print $20}')
test -n "$owner_ticks" || { printf unknown; exit 0; }
owner_tmp="$owner.candidate.$$"
(set -C; printf '%s %s\\n%s\\n%s\\n' "$$" "$owner_ticks" "$binding" "$intent" > "$owner_tmp") || { printf unknown; exit 0; }
mv -fT -- "$owner_tmp" "$owner" || { printf unknown; exit 0; }
if ! test -f "$state/stop-intent.json"; then
  publish_stop stop-intent.json "$intent" || { printf unknown; exit 0; }
fi
${endCheck}
check_identity
publish_stop "stop-signal-attempt.$$.$owner_ticks.json" "$intent" || { printf unknown; exit 0; }
${endCheck}
check_identity
kill -TERM -- -${pid} && publish_stop stop-dispatched.json "$intent" && printf requested || printf unknown` : `kill -TERM -- -${pid} && printf requested || printf unknown`;
	return `set -u
check_identity() {
  test "$(cat /proc/sys/kernel/random/boot_id)" = ${quote(identity.bootId)} || { printf conflict; exit 0; }
  if ! test -d /proc/${pid}; then printf dead; exit 0; fi
  test "$(stat -Lc %u /proc/${pid})" = ${quote(String(identity.userId))} || { printf conflict; exit 0; }
  tail=$(sed 's/.*) //' /proc/${pid}/stat) || { printf unknown; exit 0; }
  test "$(printf '%s' "$tail" | awk '{print $20}')" = ${quote(String(identity.startTicks))} || { printf conflict; exit 0; }
  test "$(readlink -f /proc/${pid}/cwd)" = ${quote(identity.cwd)} || { printf conflict; exit 0; }
  ${stop ? `printf '%s\\n' "$tail" | awk -v pid=${quote(String(pid))} '$1 !~ /^Z/ && $3 == pid && $4 == pid {found=1} END {exit !found}' || { printf conflict; exit 0; }` : ""}
}
${endCheck}
check_identity
${stop ? signal : "printf alive"}`;
}
module.exports = { buildPosixRunner, linuxProbeScript };
