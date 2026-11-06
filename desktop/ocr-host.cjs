'use strict';
const fs = require('node:fs/promises'), path = require('node:path');
const {assert, plain} = require('./security.cjs');
const {cleanTaskDirectory} = require('./task-cache.cjs');
const {sha256, safeDirectory:directory} = require('./ocr-runtime.cjs');
const molvec = require('./ocr/molvec.cjs');
const MAX_IMAGE_BYTES = 20 * 1024 ** 2, MAX_IMAGE_PIXELS = 24_000_000;
function requestIdentity(id) { assert(typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id), 'OCR_REQUEST: Invalid OCR request identity'); }
function imageBytes(value) {
  assert(value instanceof Uint8Array && value.byteLength > 0 && value.byteLength <= MAX_IMAGE_BYTES, 'OCR_IMAGE: 图片须为20MiB以内的PNG/JPEG。');
  const data = Buffer.from(value); let width, height, extension;
  if (data.length >= 33 && data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && data.toString('ascii',12,16) === 'IHDR') {
    width = data.readUInt32BE(16); height = data.readUInt32BE(20); extension = 'png';
  } else if (data[0] === 255 && data[1] === 216) {
    extension = 'jpg'; let index = 2;
    while (index + 4 <= data.length) {
      assert(data[index++] === 255, 'OCR_IMAGE: JPEG标记无效。');
      while (data[index] === 255) index++;
      const marker = data[index++];
      if (marker === 0xD9 || marker === 0xDA) break;
      if (marker >= 0xD0 && marker <= 0xD7 || marker === 1) continue;
      const length = data.readUInt16BE(index); assert(length >= 2 && index + length <= data.length, 'OCR_IMAGE: JPEG长度无效。');
      if ([0xC0,0xC1,0xC2,0xC3,0xC5,0xC6,0xC7,0xC9,0xCA,0xCB,0xCD,0xCE,0xCF].includes(marker)) { assert(length >= 8, 'OCR_IMAGE: JPEG尺寸无效。'); height = data.readUInt16BE(index+3); width = data.readUInt16BE(index+5); break; }
      index += length;
    }
  }
  assert(extension && width > 0 && height > 0 && width * height <= MAX_IMAGE_PIXELS && width <= 16000 && height <= 16000, 'OCR_IMAGE: 图片格式或尺寸不受支持（最多2400万像素）。');
  return {data, extension};
}
/** One window/request owns admission, native handles and its temporary files.
 * Cancellation receipt is emitted after actual process close and lease release. */
function createOcrHost({runtime, spawn, admit, terminate, jobRoot, platform = process.platform, watch = true, wallMs = 60000}) {
  const sessions = new Map(), closedOwners = new Set(); let disposed = false;
  const key = (owner,id) => owner + ':' + id;
  function stop(session, reason) {
    if (session.reason) return;
    session.reason = reason; session.abort.abort();
    if (session.child && !session.childClosed) { session.stopping = Promise.resolve(terminate(session.child)); session.stopping.catch(error => { session.failure ??= error; }); }
  }
  function active(session) { assert(!session.reason && !disposed && !closedOwners.has(session.owner), 'OCR_CANCELLED: 图片识别已取消。'); }
  async function recognize(owner, request) {
    assert(Number.isSafeInteger(owner) && owner >= 0 && !disposed && !closedOwners.has(owner), 'OCR_OWNER: 识别窗口已关闭。');
    assert(plain(request) && Object.keys(request).every(name => ['requestId','engine','imageBytes'].includes(name)), 'OCR_REQUEST: Invalid request fields');
    requestIdentity(request.requestId); assert(request.engine === 'molvec', 'OCR_UNSUPPORTED: 本版本未接入该识别引擎。');
    const image = imageBytes(request.imageBytes);
    assert(![...sessions.values()].some(session => session.owner === owner), 'OCR_BUSY: 请等待当前图片识别实际结束。');
    const session = {owner, id:request.requestId, abort:new AbortController(), peak:0};
    session.finished = new Promise(resolve => { session.resolve = resolve; }); sessions.set(key(owner,session.id),session);
    const started = performance.now();
    try {
      let component = await runtime.resolve(request.engine); active(session);
      session.release = await admit(owner, {requestId:session.id, engine:request.engine}, {signal:session.abort.signal}); active(session);
      component = await runtime.resolve(request.engine); active(session);
      const resources = session.release.resources;
      assert(resources && Number.isSafeInteger(resources.threads) && resources.threads >= 1 && Number.isSafeInteger(resources.memoryBudgetBytes) && resources.memoryBudgetBytes > 0, 'OCR_RESOURCES: 缺少真实资源grant。');
      await fs.mkdir(jobRoot, {recursive:true}); await directory(jobRoot);
      session.job = await fs.mkdtemp(path.join(jobRoot,'ocr-')); await directory(session.job); active(session);
      const input = path.join(session.job,'input.'+image.extension), output = path.join(session.job,'candidate.mol');
      await fs.writeFile(input,image.data,{flag:'wx'}); active(session);
      const command = molvec.command(component,input,output,resources,session.job);
      const env = {SystemRoot:process.env.SystemRoot, WINDIR:process.env.WINDIR, TEMP:session.job, TMP:session.job, PATH:path.dirname(command.executable), ...command.environment};
      session.child = spawn(command.executable,command.args,{cwd:session.job,env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
      let outputBytes = 0, stderr = '';
      for (const stream of [session.child.stdout,session.child.stderr]) stream?.on('data',chunk => { outputBytes += chunk.length; if (stream === session.child.stderr && stderr.length < 8192) stderr += chunk.toString().slice(0,8192-stderr.length); if (outputBytes > 1024*1024) stop(session,'OCR_OUTPUT_LIMIT: 识别输出超过上限。'); });
      const closed = new Promise(resolve => {
        session.child.once('error',error => { session.failure = error; });
        session.child.once('close',(code,signal) => { session.childClosed = true; resolve({code,signal}); });
      });
      session.childFinished = closed;
      session.timer = setTimeout(() => stop(session,'OCR_TIMEOUT: 单图识别超过60秒。'),wallMs);
      let watcher, watcherClosed;
      if (platform === 'win32' && watch && session.child.pid) {
        watcher = spawn(path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'ocr','watch-process.ps1'),'-OwnedProcessId',String(session.child.pid),'-ThreadGrant',String(resources.threads)],{cwd:session.job,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
        let tail = '', monitorBytes = 0;
        watcher.stdout?.on('data',chunk => {
          monitorBytes += chunk.length; if (monitorBytes > 1024*1024) { stop(session,'OCR_MONITOR: 资源监控输出异常。'); return; }
          tail += chunk.toString(); let newline;
          while ((newline = tail.indexOf('\n')) >= 0) { const line = tail.slice(0,newline); tail = tail.slice(newline+1); try { const row = JSON.parse(line); assert(Number.isSafeInteger(row.workingSetBytes) && row.workingSetBytes >= 0 && Number.isSafeInteger(row.affinityCpuCount) && row.affinityCpuCount > 0 && row.affinityCpuCount <= resources.threads, 'Invalid process resource observation'); session.affinityCpuCount=row.affinityCpuCount;session.peak = Math.max(session.peak,row.peakWorkingSetBytes ?? row.workingSetBytes); if (row.workingSetBytes > resources.memoryBudgetBytes) stop(session,'OCR_MEMORY_LIMIT: 识别达到当前内存预算。'); } catch { stop(session,'OCR_MONITOR: 资源监控数据无效。'); } }
        });
        watcher.stderr?.on('data',() => {});
        watcher.once('error',error => { session.failure ??= error; stop(session,'OCR_MONITOR: 资源监控启动失败。'); });
        watcherClosed = new Promise(resolve => watcher.once('close',code => { if (code && !session.childClosed) stop(session,'OCR_MONITOR: 资源监控失败。'); resolve(); }));
      }
      const exit = await closed; clearTimeout(session.timer);
      await session.stopping;
      // The watcher only reads this exact child; wait for its own real exit too.
      if (watcherClosed) await watcherClosed;
      if (session.reason) throw Error(session.reason);
      active(session); if (session.failure) throw session.failure;
      assert(exit.code === 0 && !exit.signal, 'OCR_FAILED: 识别组件退出失败。' + stderr.slice(0,1000));
      if (/Max number of labels reached|truncating search|OutOfMemoryError|Exception in thread/i.test(stderr)) {
        let rawMolblock;
        try { const info=await fs.lstat(output);if(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.size<=4*1024*1024)rawMolblock=await fs.readFile(output,'utf8'); } catch { /* Keep the actual diagnostic even when no MOL was produced. */ }
        await fs.writeFile(path.join(session.job,'run-result.json'),JSON.stringify({schema:1,status:'incomplete',engine:component.engine,version:component.version,componentSHA256:component.componentSHA256,imageSHA256:sha256(image.data),stderr,rawMolblock},null,2)+'\n',{flag:'wx'});
        await fs.writeFile(path.join(session.job,'.retain-recovery.json'),JSON.stringify({schema:1,reason:'OCR_INCOMPLETE',evidence:'run-result.json'})+'\n',{flag:'wx'});
        session.retainEvidence=true;
        throw Error('OCR_INCOMPLETE: 识别组件报告搜索截断或执行异常，请缩小框选或换用清晰图片。');
      }
      const stat = await fs.lstat(output); assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 4*1024*1024, 'OCR_OUTPUT: MOL输出无效。');
      const candidate = molvec.parse(await fs.readFile(output,'utf8')); active(session);
      return {requestId:session.id,engine:component.engine,version:component.version,componentSHA256:component.componentSHA256,imageSHA256:sha256(image.data),...candidate,elapsedMs:performance.now()-started,effectiveResources:structuredClone(resources),...(session.peak?{peakWorkingSetBytes:session.peak}:{}),...(session.affinityCpuCount?{affinityCpuCount:session.affinityCpuCount}:{})};
    } finally {
      clearTimeout(session.timer);
      if (session.child && !session.childClosed) { stop(session,'OCR_CANCELLED: 识别未完成。'); await session.childFinished; await session.stopping; }
      try { if (session.job && !session.retainEvidence) await cleanTaskDirectory(session.job); }
      finally { try { await session.release?.(); } finally { sessions.delete(key(owner,session.id)); session.resolve(); } }
    }
  }
  async function cancel(owner,id) { requestIdentity(id); const session = sessions.get(key(owner,id)); if (!session) return {requestId:id,cancelled:false,settled:true}; stop(session,'OCR_CANCELLED: 图片识别已取消。'); await session.finished; return {requestId:id,cancelled:true,settled:true}; }
  return {recognize,cancel,closeOwner(owner) { closedOwners.add(owner); for (const session of sessions.values()) if (session.owner === owner) stop(session,'OCR_CANCELLED: 识别窗口已关闭。'); },activeCount:() => sessions.size,settle:() => Promise.all([...sessions.values()].map(session => session.finished)),dispose() { disposed = true; for (const session of sessions.values()) stop(session,'OCR_CANCELLED: 应用退出。'); }};
}
module.exports = {createOcrHost,imageBytes,requestIdentity};
