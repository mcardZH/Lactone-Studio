'use strict';
const { createInterface } = require('node:readline');
const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');

const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
const newSecret = () => randomBytes(32).toString('hex');
const isSecret = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isId = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const isToolName = value => typeof value === 'string' && /^[\w.-]{1,128}$/.test(value);
const isToolDescriptor = tool => isRecord(tool) && isToolName(tool.name) && tool.name !== 'es_connect' &&
  typeof tool.description === 'string' && isRecord(tool.inputSchema) && tool.inputSchema.type === 'object';

function failure(code, message, data) {
  return Object.assign(new Error(message), { code, data });
}
function errorRecord(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'operation_failed',
    message: typeof error?.message === 'string' ? error.message : 'ES 操作失败。',
    ...(error?.data === undefined ? {} : { data: error.data }),
  };
}
function proof(secret, role, instanceId, serverNonce, clientNonce) {
  return createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(JSON.stringify([1, role, instanceId, serverNonce, clientNonce])).digest('hex');
}
function verifyProof(actual, expected) {
  return isSecret(actual) && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
function readMessages(input, receive, malformed) {
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); }
    catch { malformed(); return; }
    receive(message);
  });
  return lines;
}
function sendMessage(output, message) {
  if (!output.destroyed && output.writable) output.write(`${JSON.stringify(message)}\n`);
}

module.exports = { isRecord, isSecret, isId, isToolName, isToolDescriptor, newSecret, failure, errorRecord, proof, verifyProof, readMessages, sendMessage };
