'use strict';
const { randomUUID } = require('node:crypto');
const { assert, plain, string } = require('./security.cjs');
const keys = ['ownerId', 'analysisId', 'sessionId', 'runId', 'sourceId', 'sourceRevision', 'jobIndex', 'sourceFrameIndex', 'generation', 'operation'];
function progressIdentity(raw, source) {
  if (raw === undefined && (!source.sourceId || !source.sourceRevision)) return null;
  const value = raw === undefined ? { ownerId: source.analysisId ?? source.sessionId, analysisId: source.analysisId ?? source.sessionId, sessionId: source.sessionId, runId: randomUUID(), sourceId: source.sourceId, sourceRevision: source.sourceRevision, operation: source.operation } : raw;
  assert(plain(value) && Object.keys(value).every(key => keys.includes(key)), 'Invalid Multiwfn progress identity');
  for (const key of ['ownerId', 'analysisId', 'sessionId', 'runId', 'sourceId', 'operation']) assert(string(value[key], 512), 'Incomplete Multiwfn progress identity');
  assert(value.sessionId === source.sessionId && value.sourceId === source.sourceId && value.sourceRevision === source.sourceRevision, 'Multiwfn progress source changed');
  for (const key of ['jobIndex', 'sourceFrameIndex', 'generation']) if (value[key] !== undefined && value[key] !== null) assert(Number.isSafeInteger(value[key]) && value[key] >= 0, 'Invalid Multiwfn progress ordinal');
  return structuredClone(value);
}
function validMeasure(value) {
  if (!plain(value)) return undefined;
  if (value.kind === 'percent' && Number.isFinite(value.value) && value.value >= 0 && value.value <= 100) return { kind: 'percent', value: value.value };
  if (value.kind === 'items' && Number.isSafeInteger(value.completed) && value.completed >= 0 && Number.isSafeInteger(value.total) && value.total > 0 && value.completed <= value.total && (value.unit === undefined || string(value.unit, 32))) return { kind: 'items', completed: value.completed, total: value.total, ...(value.unit ? { unit: value.unit } : {}) };
}
/** Owns display sequence/time only. It cannot run/cancel native work. */
function createMultiwfnProgress(identity, send = () => {}, { now = () => performance.now() } = {}) {
  if (!identity) return { identity: null, report: () => {}, getSnapshot: () => undefined };
  const started = now(); let seq = 0, terminal = false, stopping = false, snapshot, lastSent=-Infinity;
  function report(phase, extra = {}) {
    if (terminal || !['queued', 'reading', 'running', 'write', 'parse', 'render', 'stopping', 'stopped', 'failed'].includes(phase)) return;
    if (stopping && !['stopping', 'stopped', 'failed'].includes(phase)) return;
    if (['stopped', 'failed'].includes(phase) && !['not-started', 'cancelled-before-start', 'native-settled'].includes(extra.settlement)) return;
    if (phase === 'stopped' && extra.settlement === 'not-started') return;
    const measure = validMeasure(extra.measure);
    const time=now(),sameStage=snapshot?.phase===phase&&snapshot?.stageId===extra.stageId&&snapshot?.stageLabel===extra.stageLabel;
    // No payload cloning or renderer dispatch for repeated observations within
    // this window. Real stage transitions, stop and terminal receipts are instant.
    if(sameStage&&!['stopping','stopped','failed'].includes(phase)&&time-lastSent<250&&!(measure?.kind==='percent'&&measure.value===100))return snapshot;
    lastSent=time;
    snapshot = { identity: structuredClone(identity), seq: ++seq, phase, elapsedMs: Math.max(0, time - started),
      ...(string(extra.stageId, 256) ? { stageId: extra.stageId } : {}), ...(string(extra.stageLabel, 256) ? { stageLabel: extra.stageLabel } : {}),
      ...(string(extra.message, 2048) ? { message: extra.message } : {}), ...(measure ? { measure } : {}),
      ...(extra.settlement ? { settlement: extra.settlement } : {}), ...(extra.validated === true ? { validated: true } : {}) };
    terminal = phase === 'stopped' || phase === 'failed';
    stopping ||= phase === 'stopping';
    try { send(structuredClone(snapshot)); } catch { /* Observation cannot fail scientific work. */ }
    return snapshot;
  }
  return { identity, report, getSnapshot: () => snapshot };
}
/** Numerical workers retain their one-result stdout protocol; observations use stderr. */
function createNativeProgressReader(report) {
  let tail = '';
  return chunk => {
    tail += chunk.toString('utf8');
    const lines = tail.split(/[\r\n]/); tail = lines.pop().slice(-16384);
    for (const line of lines) {
      if (!line.startsWith('SCIYUE_MULTIWFN_PROGRESS\t') || line.length > 16384) continue;
      try { const event = JSON.parse(line.slice(25)); if (plain(event) && ['reading', 'running', 'write', 'parse'].includes(event.phase)) report(event.phase, event); } catch { /* Unknown output is not progress/completion. */ }
    }
  };
}
module.exports = { progressIdentity, createMultiwfnProgress, createNativeProgressReader };
