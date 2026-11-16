"""Run one selected build command in a bounded Windows Job.

No installer or global configuration changes. Child is assigned before resume;
CPU affinity, memory, wall deadline and tree lifetime are enforced.
"""
from __future__ import annotations

import ctypes as c
from ctypes import wintypes as w
import datetime, hashlib, json, math, os, sys, threading, time
from pathlib import Path


class BASIC(c.Structure):
    _fields_=[('PerProcessUserTimeLimit',c.c_int64),('PerJobUserTimeLimit',c.c_int64),
              ('LimitFlags',w.DWORD),('MinimumWorkingSetSize',c.c_size_t),('MaximumWorkingSetSize',c.c_size_t),
              ('ActiveProcessLimit',w.DWORD),('Affinity',c.c_size_t),('PriorityClass',w.DWORD),('SchedulingClass',w.DWORD)]


class IO(c.Structure):
    _fields_=[(name,c.c_uint64) for name in ('ReadOperationCount','WriteOperationCount','OtherOperationCount',
                                          'ReadTransferCount','WriteTransferCount','OtherTransferCount')]


class EXT(c.Structure):
    _fields_=[('BasicLimitInformation',BASIC),('IoInfo',IO),('ProcessMemoryLimit',c.c_size_t),
              ('JobMemoryLimit',c.c_size_t),('PeakProcessMemoryUsed',c.c_size_t),('PeakJobMemoryUsed',c.c_size_t)]


class ACCOUNTING(c.Structure):
    _fields_=[(name,c.c_int64) for name in ('TotalUserTime','TotalKernelTime','ThisPeriodTotalUserTime','ThisPeriodTotalKernelTime')]+[
              (name,w.DWORD) for name in ('TotalPageFaultCount','TotalProcesses','ActiveProcesses','TotalTerminatedProcesses')]


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def require(value,message):
    if not value:raise ValueError(message)


def run(request_path):
    require(os.name=='nt','Windows runner required')
    import _winapi, msvcrt, subprocess
    request_bytes=Path(request_path).read_bytes();spec=json.loads(request_bytes.decode('utf-8-sig'))
    command=spec['command'];cwd=Path(spec['cwd']);env=spec['env']
    require(isinstance(command,list) and command and all(isinstance(x,str) and '\x00' not in x for x in command),'command must be an argv array')
    require(Path(command[0]).is_absolute() and Path(command[0]).is_file(),'command executable must be an existing absolute file')
    require(cwd.is_absolute() and cwd.is_dir(),'cwd must be an existing absolute directory')
    require(isinstance(env,dict) and all(isinstance(k,str) and k and '=' not in k and isinstance(v,str)
            and '\x00' not in k+v for k,v in env.items()),'env must be an explicit string map')
    threads=spec['threads'];memory=spec['memoryGiB'];timeout=spec['timeoutSeconds']
    require(type(threads) is int and 1<=threads<=8,'threads must be 1..8 logical CPUs')
    require(type(memory) in (int,float) and math.isfinite(memory) and 0<memory<=16,'memoryGiB must be >0 and <=16')
    require(type(timeout) in (int,float) and math.isfinite(timeout) and 0<timeout<=5400,'timeoutSeconds must be >0 and <=5400')
    paths={name:Path(spec[name]) for name in ('stdout','stderr','receipt')}
    require(len({os.path.normcase(str(p.absolute())) for p in paths.values()})==3,'output paths must be distinct')
    for path in paths.values():
        require(path.is_absolute() and path.parent.is_dir() and not path.exists(),'outputs require existing parents and fresh absolute filenames')
        for parent in (path.parent,*path.parent.parents):
            require(not parent.is_symlink() and not getattr(parent,'is_junction',lambda:False)(),'linked output parent refused')
    k=c.WinDLL('kernel32',use_last_error=True)
    def bind(name,args,result=w.BOOL):
        function=getattr(k,name);function.argtypes=args;function.restype=result;return function
    create_job=bind('CreateJobObjectW',[c.c_void_p,w.LPCWSTR],w.HANDLE)
    set_job=bind('SetInformationJobObject',[w.HANDLE,c.c_int,c.c_void_p,w.DWORD])
    query_job=bind('QueryInformationJobObject',[w.HANDLE,c.c_int,c.c_void_p,w.DWORD,c.c_void_p])
    assign=bind('AssignProcessToJobObject',[w.HANDLE,w.HANDLE])
    terminate_job=bind('TerminateJobObject',[w.HANDLE,w.UINT]);close=bind('CloseHandle',[w.HANDLE])
    terminate_process=bind('TerminateProcess',[w.HANDLE,w.UINT])
    resume=bind('ResumeThread',[w.HANDLE],w.DWORD)
    wait=bind('WaitForSingleObject',[w.HANDLE,w.DWORD],w.DWORD)
    exit_code=bind('GetExitCodeProcess',[w.HANDLE,c.POINTER(w.DWORD)])
    affinity=bind('GetProcessAffinityMask',[w.HANDLE,c.POINTER(c.c_size_t),c.POINTER(c.c_size_t)])
    current=bind('GetCurrentProcess',[],w.HANDLE)
    def check(value,action):
        if not value:raise c.WinError(c.get_last_error(),action)
    def query(job,kind,structure):
        result=structure();check(query_job(job,kind,c.byref(result),c.sizeof(result),None),'QueryInformationJobObject');return result
    process_mask=c.c_size_t();system_mask=c.c_size_t()
    check(affinity(current(),c.byref(process_mask),c.byref(system_mask)),'GetProcessAffinityMask')
    available=process_mask.value & system_mask.value
    cpus=[i for i in range(c.sizeof(c.c_size_t)*8) if available & (1<<i)]
    require(len(cpus)>=threads,'caller affinity has fewer CPUs than the explicit grant')
    mask=sum(1<<i for i in cpus[:threads]);memory_bytes=int(memory*1024**3)
    receipt={'schema':'sy-windows-bounded-command/v1','status':'configuring','createdAtUtc':utc(),
             'request':{'path':str(Path(request_path).resolve()),'sha256':hashlib.sha256(request_bytes).hexdigest()},
             'command':command,'cwd':str(cwd),'envKeys':sorted(env),'environmentSha256':hashlib.sha256(json.dumps(env,sort_keys=True).encode()).hexdigest(),
             'threads':threads,'affinityMask':mask,'cpuIndices':cpus[:threads],'jobMemoryLimitBytes':memory_bytes,
             'timeoutSeconds':timeout,'stdout':str(paths['stdout']),'stderr':str(paths['stderr']),
             'processCreated':False,'assignedBeforeResume':False,'resumed':False,'timedOut':False,'error':None,
             'resourceLimitsAreHard':True,'invocationOwner':'caller'}
    def save():
        pending=paths['receipt'].with_name(paths['receipt'].name+'.pending')
        with pending.open('x',encoding='utf-8',newline='\n') as stream:
            json.dump(receipt,stream,indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())
        os.replace(pending,paths['receipt'])
    with paths['receipt'].open('x',encoding='utf-8') as stream:json.dump(receipt,stream)
    job=None;hp=None;ht=None;timer=None;closed=threading.Event();expired=threading.Event();timeout_error=[]
    started=time.monotonic()
    try:
        job=create_job(None,None);check(job,'CreateJobObjectW')
        limits=EXT();limits.BasicLimitInformation.LimitFlags=0x2000|0x200|0x10
        limits.BasicLimitInformation.Affinity=mask;limits.JobMemoryLimit=memory_bytes
        check(set_job(job,9,c.byref(limits),c.sizeof(limits)),'SetInformationJobObject')
        observed=query(job,9,EXT)
        require(observed.JobMemoryLimit==memory_bytes and observed.BasicLimitInformation.Affinity==mask
                and observed.BasicLimitInformation.LimitFlags & (0x2000|0x200|0x10)==(0x2000|0x200|0x10),'Job limits readback differs')
        receipt['jobLimitsReadBack']=True;receipt['killOnClose']=True;save()
        def watchdog():
            if not closed.is_set():
                expired.set()
                if not terminate_job(job,124):timeout_error.append(c.get_last_error())
        timer=threading.Timer(timeout,watchdog);timer.daemon=True;timer.start()
        with paths['stdout'].open('xb') as out,paths['stderr'].open('xb') as err,open(os.devnull,'rb') as stdin:
            handles=[msvcrt.get_osfhandle(stream.fileno()) for stream in (stdin,out,err)]
            startup=subprocess.STARTUPINFO();startup.dwFlags=subprocess.STARTF_USESTDHANDLES
            startup.hStdInput,startup.hStdOutput,startup.hStdError=handles
            startup.lpAttributeList={'handle_list':handles}
            for handle in handles:os.set_handle_inheritable(handle,True)
            try:
                hp,ht,pid,tid=_winapi.CreateProcess(command[0],subprocess.list2cmdline(command),None,None,True,
                                                   0x00000004|subprocess.CREATE_NO_WINDOW,env,str(cwd),startup)
            finally:
                for handle in handles:os.set_handle_inheritable(handle,False)
            receipt.update(processCreated=True,pid=pid,threadId=tid,status='suspended',processCreatedAtUtc=utc());save()
            check(assign(job,hp),'AssignProcessToJobObject (child remains suspended on failure)')
            receipt['assignedBeforeResume']=True
            require(not expired.is_set(),'wall deadline elapsed before resume')
            require(resume(ht)==1,'ResumeThread did not resume exactly one suspended main thread')
            close(ht);ht=None;receipt.update(resumed=True,status='running',resumedAtUtc=utc());save()
            while True:
                accounting=query(job,1,ACCOUNTING)
                state=wait(hp,0);require(state in (0,258),'WaitForSingleObject failed')
                if state==0 and accounting.ActiveProcesses==0:break
                if state==0:
                    root_code=w.DWORD()
                    check(exit_code(hp,c.byref(root_code)),'GetExitCodeProcess after root exit')
                    if root_code.value!=0:
                        receipt['failedRootOwnedChildrenTermination']=True
                        check(terminate_job(job,root_code.value),'Terminate owned job after failed root exit')
                        break
                if expired.is_set():
                    check(terminate_job(job,124),'TerminateJobObject after wall deadline')
                    break
                time.sleep(0.025)
    except BaseException as error:
        receipt['error']=repr(error)
    finally:
        closed.set()
        if timer is not None:timer.cancel();timer.join()
        receipt['timedOut']=expired.is_set();receipt['timeoutTerminationErrors']=timeout_error
        if job:
            try:
                accounting=query(job,1,ACCOUNTING)
                if accounting.ActiveProcesses:check(terminate_job(job,124 if expired.is_set() else 1),'Terminate remaining owned job')
                if hp and not receipt['assignedBeforeResume']:check(terminate_process(hp,1),'Terminate unassigned suspended process')
                cleanup_deadline=time.monotonic()+5
                while query(job,1,ACCOUNTING).ActiveProcesses and time.monotonic()<cleanup_deadline:time.sleep(0.01)
                accounting=query(job,1,ACCOUNTING);stats=query(job,9,EXT)
                receipt.update(activeProcessesAtClose=accounting.ActiveProcesses,totalProcesses=accounting.TotalProcesses,
                               jobTreeEnded=accounting.ActiveProcesses==0,peakJobMemoryBytes=stats.PeakJobMemoryUsed,
                               peakProcessMemoryBytes=stats.PeakProcessMemoryUsed,
                               jobUserCpuSeconds=accounting.TotalUserTime/1e7,jobKernelCpuSeconds=accounting.TotalKernelTime/1e7)
                if hp:
                    receipt['mainProcessEnded']=wait(hp,5000)==0
                    code=w.DWORD();check(exit_code(hp,c.byref(code)),'GetExitCodeProcess');receipt['exitCode']=code.value
            except BaseException as error:receipt['cleanupError']=repr(error)
            finally:close(job)
        if ht:close(ht)
        if hp:close(hp)
        receipt.update(closedAtUtc=utc(),wallSeconds=time.monotonic()-started)
        passed=receipt.get('exitCode')==0 and receipt.get('jobTreeEnded') and receipt.get('mainProcessEnded')
        passed=bool(passed and not receipt['timedOut'] and not receipt['error'] and not receipt.get('cleanupError'))
        receipt.update(passed=passed,status='passed' if passed else ('timed-out' if receipt['timedOut'] else 'failed'));save()
    return receipt


if __name__=='__main__':
    require(len(sys.argv)==2,'usage: python -B bounded-runner.py request.json')
    result=run(sys.argv[1])
    print(json.dumps({key:result.get(key) for key in ('status','pid','exitCode','wallSeconds','peakJobMemoryBytes','jobTreeEnded','error','cleanupError')}),flush=True)
    raise SystemExit(0 if result['passed'] else (124 if result['timedOut'] else 1))
