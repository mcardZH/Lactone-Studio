"""NDJSON orbital worker: one scheduler, many analysis sessions, one grid cache.

Requests: {id, operation, sessionId, ...}. Replies echo id; unsolicited events
have event='progress'|'state'|'error'|'native-idle'. Grid payload is base64 little-endian
Float64 (z fastest). Only field/export-cube transfers a completed grid. The host
must terminate this owned worker on app exit; EOF also releases every session.
"""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
from analysis_result_wire import managed_result
import sys
import threading
import time
from multiwfn_resources import resolve_resources, native_static_image_bytes

try:
    from orbitals import MultiwfnSession, OrbitalError, inspect_wavefunction, plan_grid
except ModuleNotFoundError:
    from .orbitals import MultiwfnSession, OrbitalError, inspect_wavefunction, plan_grid


class OrbitalWorker:
    def __init__(self, emit):
        self.emit=emit; self.sessions={}; self.lock=threading.RLock(); self.wake=threading.Event()
        self.closed=False; self.current=None; self.current_item=None; self.sequence=0; self.event_sequence=0
        self.thread=threading.Thread(target=self._schedule,daemon=True); self.thread.start()

    def _reply(self,request,**payload):
        identity={key:request[key] for key in ('sessionId','sourceRevision','gridKey') if key in request}
        generation=request.get('generation',0)
        with self.lock:
            item=self.sessions.get(request.get('sessionId'))
            if item: identity.update(item['identity']); generation=item['generation']
        self.emit(dict(id=request.get('id'),ok=True,generation=generation,**identity,**payload))

    def _event(self,session_id,item,generation,**payload):
        with self.lock:
            if self.sessions.get(session_id) is not item: return
            self.event_sequence+=1
            self.emit(dict(seq=self.event_sequence,generation=generation,**item['identity'],**payload))

    @staticmethod
    def _completed(session):
        ids=list(session.cache)
        return dict(completed=len(ids),completedIds=ids,total=len(session.metadata['orbitals']))

    @staticmethod
    def _next_generation(request,item):
        generation=request.get('generation',item['generation']+1)
        if isinstance(generation,bool) or not isinstance(generation,int) or generation!=item['generation']+1:
            raise OrbitalError('stale-generation','Orbital control request does not follow the current generation.')
        return generation

    def handle(self,request):
        try:
            if not isinstance(request,dict): raise OrbitalError('request','Expected an orbital request object.')
            operation=request.get('operation')
            if operation=='resources':
                resources,_=resolve_resources(request.get('executable'),request.get('threads'),request.get('memoryBudgetBytes'))
                self._reply(request,resources=resources);return
            if operation=='inspect':
                self._reply(request,metadata=inspect_wavefunction(request['sourcePath'])); return
            if operation=='plan':
                metadata=inspect_wavefunction(request['sourcePath'])
                mode=request.get('mode','all')
                current=self.sessions.get(request.get('sessionId'))
                cached=len(current['session'].cache) if current and current.get('mode','all')==mode and current['session'].grid==request['grid'] else 0
                plan=plan_grid(metadata,request['grid'],request.get('memoryBudgetBytes'),mode,cached,native_static_image_bytes(request.get('executable')))
                with self.lock:
                    combined=sum(item['session'].plan['estimatedPeakBytes'] for key,item in self.sessions.items() if key!=request.get('sessionId'))+plan['estimatedPeakBytes']
                plan.update(combinedEstimatedPeakBytes=combined,requiresMemoryConfirmation=combined>request['memoryBudgetBytes'])
                self._reply(request,plan=plan); return
            session_id=request.get('sessionId')
            if not isinstance(session_id,str) or not session_id or len(session_id)>200:
                raise OrbitalError('session-id','Expected a bounded analysis session id.')
            if operation=='open':
                with self.lock:
                    if session_id in self.sessions: raise OrbitalError('session-exists','This analysis already has an orbital session.')
                mode=request.get('mode','all')
                session=MultiwfnSession(request['executable'],request['sourcePath'],request['grid'],request.get('threads'),request.get('memoryBudgetBytes'),request['workspacePath'],mode,request.get('settingsRevision'))
                with self.lock:
                    combined=sum(item['session'].plan['estimatedPeakBytes'] for item in self.sessions.values())+session.plan['estimatedPeakBytes']
                    identity=dict(sessionId=session_id,sourceRevision=request.get('sourceRevision',session.metadata['sourceSha256']),
                                  gridKey=request.get('gridKey',hashlib.sha256(json.dumps(session.grid,sort_keys=True).encode()).hexdigest()))
                    if identity['sourceRevision']!=session.metadata['sourceSha256']:
                        session.close(); raise OrbitalError('source-changed','Source revision differs from the opened wavefunction.')
                    self.sessions[session_id]=dict(session=session,state='idle',priority=[],sequence=0,identity=identity,generation=0,mode=mode,requested=[],configuredBudget=session.plan['memoryBudgetBytes'])
                self._reply(request,metadata=session.metadata,plan=session.plan,combinedEstimatedPeakBytes=combined,resources=session.resources); return
            with self.lock:
                item=self.sessions.get(session_id)
                if item is None: raise OrbitalError('session-missing','This analysis orbital session is absent or closed.')
                for key in ('sourceRevision','gridKey'):
                    if key in request and request[key]!=item['identity'][key]:
                        raise OrbitalError('stale-session','Orbital request belongs to a different source or grid revision.')
                session=item['session']
            if operation in ('generate', 'continue', 'generate-one'):
                if request.get('resourceGrant') is not None:
                    if item['state'] in ('queued','running'):
                        raise OrbitalError('resource-active','A running orbital task retains its resource grant.')
                    session.apply_resources(request['resourceGrant'])
                    item['configuredBudget']=session.plan['memoryBudgetBytes']
                budget=request.get('nativeMemoryBudgetBytes',item['configuredBudget'])
                if isinstance(budget,bool) or not isinstance(budget,int) or not 0<budget<=item['configuredBudget']:
                    raise OrbitalError('memory-budget','Invalid shared native operation memory grant.')
                session.plan['memoryBudgetBytes']=budget
            if operation=='generate-one':
                if item.get('mode','all')!='selected': raise OrbitalError('mode','generate-one requires an explicit selected-mode plan.')
                key=request.get('orbitalId')
                if key not in {o['id'] for o in session.metadata['orbitals']}: raise OrbitalError('orbital-id','Selected orbital is absent from the source.')
                with self.lock:
                    generation=self._next_generation(request,item)
                    if item['state'] in ('queued','running'): session.stop()
                    item['generation']=generation; item['state']='stopped'; item['requested']=[key]
                    proposed=session.reserve_selected(key)
                    combined=sum(other['session'].plan['estimatedPeakBytes'] for other in self.sessions.values() if other is not item)+proposed['estimatedPeakBytes']
                    # Stop is kept set until the scheduler finishes the old
                    # iterator. A new request must not revive the cancelled one.
                    session.plan=proposed
                    item['state']='complete' if key in session.cache else 'queued'
                    self.sequence+=1; item['sequence']=self.sequence
                self._reply(request,state=item['state'],**self._completed(session))
                if item['state']=='complete':
                    self._event(session_id,item,generation,event='state',state='complete',**self._completed(session))
                    process=session.process; session.stop()
                    self._event(session_id,item,generation,event='native-idle',nativeSettled=process is None or process.poll() is not None)
                else: self.wake.set()
                return
            if operation in ('generate','continue','prioritize'):
                if item.get('mode','all')=='selected': raise OrbitalError('mode','Selected mode accepts generate-one, not legacy all-orbital commands.')
                priority=request.get('priorityIds',[])
                if not isinstance(priority,list) or any(not isinstance(key,str) for key in priority): raise OrbitalError('orbital-id','priorityIds must be source orbital keys.')
                ids={o['id'] for o in session.metadata['orbitals']}
                if any(key not in ids for key in priority): raise OrbitalError('orbital-id','Requested orbital is absent from the source.')
                with self.lock:
                    item['priority']=list(dict.fromkeys(priority+item['priority']))
                    # Selecting an uncached field may reprioritize a stopped session,
                    # but only explicit generate/continue resumes its work.
                    if operation!='prioritize':
                        generation=self._next_generation(request,item)
                        session.resume(); item['state']='queued'; item['generation']=generation
                    self.sequence+=1; item['sequence']=self.sequence
                self._reply(request,state=item['state'],**self._completed(session)); self.wake.set(); return
            if operation=='stop':
                with self.lock:
                    generation=self._next_generation(request,item)
                    item['state']='stopped'; item['generation']=generation
                    dispatched=self.current_item is item
                process=session.process
                session.stop()
                if item.get('mode')=='selected': session.plan=session.reserve_selected(); item['requested']=[]
                self._reply(request,state='stopped',**self._completed(session))
                # A queued item stopped before dispatch never enters the
                # scheduler's finally. Confirm its real native state here;
                # an already dispatched item must still settle in finally.
                if not dispatched:
                    self._event(session_id,item,generation,event='native-idle',nativeSettled=process is None or process.poll() is not None)
                return
            if operation=='field':
                key=request.get('orbitalId'); values=session.cache.get(key)
                if values is None: raise OrbitalError('field-pending','Requested orbital has not completed; prioritize it or continue generation.')
                self._reply(request,orbitalId=key,grid=session.grid,encoding='float64-le-base64',valueUnit='bohr^-3/2',
                            dataBase64=base64.b64encode(values.astype('<f8',copy=False).tobytes()).decode('ascii'),backend=session.backend); return
            if operation=='export-cube':
                self._reply(request,text=session.export_cube(request.get('orbitalId'))); return
            if operation=='status':
                self._reply(request,state=item['state'],completedIds=list(session.cache),total=len(session.metadata['orbitals']),backend=session.backend); return
            if operation=='close':
                with self.lock: self.sessions.pop(session_id,None); item['state']='closed'; item['generation']+=1
                session.close(); self._reply(request,state='closed'); return
            raise OrbitalError('operation','Unsupported orbital operation.')
        except Exception as exc:
            identity={key:request[key] for key in ('sessionId','sourceRevision','gridKey') if isinstance(request,dict) and key in request}
            self.emit(dict(id=request.get('id') if isinstance(request,dict) else None,ok=False,generation=request.get('generation',0) if isinstance(request,dict) else 0,**identity,error=dict(code=getattr(exc,'code','orbital-failure'),message=str(exc),**({'diagnostics':exc.diagnostics} if getattr(exc,'diagnostics',None) is not None else {}))))

    def _schedule(self):
        while not self.closed:
            self.wake.wait(.2); self.wake.clear()
            while not self.closed:
                with self.lock:
                    pending=[(key,item) for key,item in self.sessions.items() if item['state'] in ('queued','running')]
                    if not pending: break
                    # A current explicit request wins; otherwise continue the newest analysis.
                    session_id,item=max(pending,key=lambda pair:pair[1]['sequence'])
                    session=item['session']; item['state']='running'; self.current=session_id; self.current_item=item
                    selected=item.get('mode','all')=='selected'
                    priority=list(item['requested'] if selected else item['priority'])
                    generation=item['generation']
                    # Only idle native processes yield; completed scientific
                    # arrays stay owned by their original session.
                    idle_others=[other['session'] for other in self.sessions.values() if other is not item]
                    session.resume()
                iterator=None; settled_others=True
                try:
                    for other in idle_others:
                        previous=other.process; other.stop()
                        if previous is not None and previous.poll() is None:
                            settled_others=False
                            raise OrbitalError('native-close','An idle Multiwfn process did not confirm exit; no second process was started.')
                    session.progress_callback=lambda packet,sid=session_id,owned=item,epoch=generation: self._event(sid,owned,epoch,event='task-progress',progress=packet)
                    iterator=session.generate(priority,selected_only=True) if selected else session.generate(priority)
                    field=next(iterator,None)
                    with self.lock:
                        still_owned=self.sessions.get(session_id) is item
                        if (field is None or selected) and still_owned and item['state']=='running' and generation==item['generation']: item['state']='complete'
                        state=item['state']
                    if field is not None and still_owned:
                        self._event(session_id,item,generation,event='progress',state=state,orbital=field['orbital'],completed=field['completed'],completedIds=list(session.cache),total=field['total'],backend=field['backend'],elapsedSeconds=field['elapsedSeconds'])
                    if (field is None or selected) and still_owned:
                        self._event(session_id,item,generation,event='state',state=state,**self._completed(session))
                except Exception as exc:
                    with self.lock:
                        still_owned=self.sessions.get(session_id) is item
                        stopped=item['state'] in ('stopped','closed') or generation!=item['generation']
                        if still_owned and not stopped: item['state']='error'
                    if still_owned and not stopped:
                        self._event(session_id,item,generation,event='error',error=dict(code=getattr(exc,'code','orbital-failure'),message=str(exc),**({'diagnostics':exc.diagnostics} if getattr(exc,'diagnostics',None) is not None else {})))
                finally:
                    if iterator is not None: iterator.close()
                    with self.lock:
                        terminal=item['state'] not in ('queued','running') or self.sessions.get(session_id) is not item
                        if terminal:
                            process=session.process
                            session.stop()
                            settled=settled_others and (process is None or process.poll() is not None)
                            self._event(session_id,item,item['generation'],event='native-idle',nativeSettled=settled)
                        # Stop observes either this active item (and awaits
                        # this finally) or a fully cleared dispatch boundary.
                        if self.current_item is item:
                            self.current=None; self.current_item=None

    def close(self):
        self.closed=True; self.wake.set()
        with self.lock:
            sessions=list(self.sessions.values()); self.sessions.clear()
        for item in sessions: item['session'].close()
        if self.thread is not threading.current_thread(): self.thread.join(timeout=5)


def main():
    write_lock=threading.Lock()
    roots={}
    def emit(payload):
        root=roots.get(payload.get('sessionId'))
        if root is not None and payload.get('ok') is True:
            payload={key:managed_result(value,root,key) if key in ('metadata','dataBase64','text') else value for key,value in payload.items()}
        with write_lock:
            sys.stdout.write(json.dumps(payload,separators=(',',':'),allow_nan=False)+'\n'); sys.stdout.flush()
    worker=OrbitalWorker(emit)
    try:
        # The NDJSON wire format is UTF-8, independent of a frozen Windows
        # executable's locale/default TextIOWrapper encoding.
        stream=sys.stdin.buffer
        while True:
            raw=stream.readline()
            if not raw: break
            try: decoded=raw.decode('utf-8')
            except UnicodeDecodeError:
                emit(dict(ok=False,error=dict(code='request-encoding',message='Orbital requests must be valid UTF-8.'))); continue
            try: request=json.loads(decoded)
            except (ValueError,TypeError): emit(dict(ok=False,error=dict(code='request-json',message='Invalid orbital request JSON.'))); continue
            if isinstance(request,dict):
                if request.get('workspacePath') is not None:
                    roots[request.get('sessionId')]=request['workspacePath']
                elif request.get('sourcePath') is not None and request.get('sessionId') not in roots:
                    roots[request.get('sessionId')]=str(Path(request['sourcePath']).parent)
            worker.handle(request)
            if isinstance(request,dict) and request.get('operation')=='close':roots.pop(request.get('sessionId'),None)
    finally: worker.close()


if __name__=='__main__': main()
