'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { assert, plain, string } = require('./security.cjs');
/** A user-selected local executable is the only persisted external capability. */
function createOrbitalBackendStore(root) {
  const location = path.join(root, 'orbital-backend.json');
  async function checked(executable) {
    if(string(executable,4096)&&path.isAbsolute(executable)){const selected=await fs.lstat(executable).catch(()=>null);if(selected?.isDirectory()&&!selected.isSymbolicLink())executable=path.join(executable,process.platform==='win32'?'Multiwfn.exe':'Multiwfn');}
    assert(string(executable,4096) && path.isAbsolute(executable) && /^Multiwfn(?:\.exe)?$/i.test(path.basename(executable)), 'Select a local Multiwfn executable');
    const stat=await fs.lstat(executable); assert(stat.isFile() && !stat.isSymbolicLink(), 'Multiwfn executable must be a regular file');
    return fs.realpath(executable);
  }
  async function info() {
    try { const stat=await fs.lstat(location); assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16384, 'Invalid orbital backend configuration'); const value=JSON.parse(await fs.readFile(location,'utf8')); assert(plain(value) && value.schema===1,'Invalid orbital backend configuration'); return { configured:true,path:await checked(value.path) }; }
    catch { return { configured:false,message:'请选择本机 Multiwfn 程序或所在文件夹，用于轨道与数值分析。' }; }
  }
  async function select(executable) { const selected=await checked(executable); const temporary=location+'.'+randomUUID()+'.tmp'; await fs.writeFile(temporary,JSON.stringify({schema:1,path:selected})+'\n',{encoding:'utf8',flag:'wx'}); try { await fs.rename(temporary,location); } catch(error) { await fs.unlink(temporary).catch(()=>{}); throw error; } return { configured:true,path:selected }; }
  return { info, select };
}
module.exports={createOrbitalBackendStore};
