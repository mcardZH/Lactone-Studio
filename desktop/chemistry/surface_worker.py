"""NDJSON surface worker, one serialized native operation across all sessions."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
from analysis_result_wire import managed_result
import sys
import threading

from surface_analysis import SurfaceAnalysisSession, SurfaceError
from hirshfeld_session import HirshfeldAnalysisSession
from multiwfn_resources import resolve_resources


class SurfaceWorker:
    def __init__(self, emit):
        self.emit = emit; self.sessions = {}; self.lock = threading.RLock()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='surface-native')
        self.closed = False; self.active = None; self.futures = set()

    def reply(self, request, result=None, error=None, native_settled=None, retained_bytes=None):
        payload = dict(id=request.get('id'), sessionId=request.get('sessionId'), ok=error is None)
        if native_settled is not None:
            payload['nativeSettled'] = native_settled
        if retained_bytes is not None:
            payload['retainedMemoryBytes'] = retained_bytes
        if error:
            payload['error'] = dict(code=getattr(error, 'code', 'surface-worker'), message=str(error))
        else:
            payload['result'] = result
        self.emit(payload)

    def handle(self, request):
        try:
            if not isinstance(request, dict):
                raise SurfaceError('surface-request', 'Expected a bounded surface request object.')
            operation = request.get('operation'); session_id = request.get('sessionId')
            if not isinstance(session_id, str) or not session_id or len(session_id) > 200:
                raise SurfaceError('surface-session', 'Expected a bounded owned session id.')
            if operation == 'resources':
                resources, _ = resolve_resources(request['executable'], request.get('threads'), request.get('memoryBudgetBytes'))
                self.reply(request, resources); return
            if operation == 'open':
                with self.lock:
                    if self.closed or session_id in self.sessions:
                        raise SurfaceError('surface-session', 'Surface worker is closed or session id is duplicate/over limit.')
                    session = (HirshfeldAnalysisSession(request) if request.get('source', {}).get('kind') == 'hirshfeld-cluster'
                               else SurfaceAnalysisSession(request))
                    self.sessions[session_id] = session
                self.reply(request, session.capabilities()); return
            with self.lock:
                session = self.sessions.get(session_id)
                if session is None:
                    raise SurfaceError('surface-session', 'Surface session is absent or closed.')
                epoch = session.epoch
            if operation == 'capabilities':
                self.reply(request, session.capabilities()); return
            if operation == 'cancel':
                session.cancel()
                self.reply(request, dict(sessionId=session_id, status='cancelled', nativeSettled=True, activeNativeCount=0)); return
            if operation == 'close':
                session.close()
                with self.lock:
                    self.sessions.pop(session_id, None)
                self.reply(request, dict(sessionId=session_id, status='closed')); return
            if operation == 'evidence':
                self.reply(request, session.evidence()); return
            if getattr(session, 'family', None) == 'hirshfeld':
                methods = {'hirshfeld-analyze': session.analyze, 'hirshfeld-restore': session.restore, 'hirshfeld-export': session.export_cube}
            else:
                methods = {'analyze': session.analyze, 'region': session.region, 'distribution': session.distribution,
                           'generate': session.generate, 'restore-fields': session.restore_fields, 'export-cube': session.export_cube}
            if operation not in methods:
                raise SurfaceError('surface-operation', 'Unsupported surface operation; arbitrary native menus are not exposed.')
            def execute():
                scientific = operation not in ('restore-fields', 'export-cube', 'hirshfeld-restore', 'hirshfeld-export')
                result = None; failure = None; native_settled = None
                try:
                    with self.lock:
                        if self.closed or self.sessions.get(session_id) is not session or session.epoch != epoch:
                            raise SurfaceError('surface-cancelled', 'Queued surface request was cancelled before it started.')
                        session.cancelled.clear()
                        if scientific:
                            session.apply_resources(request.get('resources'))
                            for other in self.sessions.values():
                                if other is not session:
                                    other.stop_native()
                        self.active = session
                    if scientific:
                        def progress(packet):
                            with self.lock:
                                if session.epoch!=epoch or session.closed or self.sessions.get(session_id) is not session: return
                            self.emit(dict(event='task-progress',id=request.get('id'),sessionId=session_id,progress=packet))
                        session.progress_callback=progress
                    result = methods[operation](request['request'])
                    if session.epoch != epoch or session.closed:
                        raise SurfaceError('surface-cancelled', 'Surface response is no longer current.')
                except Exception as error:
                    failure = error
                finally:
                    if scientific:
                        try:
                            session.stop_native(); native_settled = True
                        except Exception as error:
                            failure = error; native_settled = False
                    with self.lock:
                        if self.active is session:
                            self.active = None
                self.reply(request, result, failure, native_settled, session.retained_memory_bytes())
            future = self.executor.submit(execute)
            with self.lock:
                self.futures.add(future)
            future.add_done_callback(lambda done: self.futures.discard(done))
        except Exception as error:
            self.reply(request if isinstance(request, dict) else {}, error=error)

    def close(self):
        with self.lock:
            self.closed = True
            for session in self.sessions.values():
                session.close()
            self.sessions.clear()
        self.executor.shutdown(wait=True, cancel_futures=False)


def main():
    output_lock = threading.Lock()
    roots = {}
    def emit(packet):
        root = roots.get(packet.get('sessionId'))
        if root is not None and packet.get('ok') is True and 'result' in packet:
            try: packet = dict(packet, result=managed_result(packet['result'], root))
            except Exception as error:
                packet = {key:value for key,value in packet.items() if key!='result'}
                packet.update(ok=False,error=dict(code='analysis-result-storage',message=str(error)))
        text = json.dumps(packet, allow_nan=False, separators=(',', ':'))
        with output_lock:
            sys.stdout.write(text + '\n'); sys.stdout.flush()
    worker = SurfaceWorker(emit)
    try:
        for raw in sys.stdin.buffer:
            try:
                request = json.loads(raw.decode('utf-8'), parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite JSON number.')))
                if request.get('workspacePath') is not None:
                    roots[request.get('sessionId')] = request['workspacePath']
                worker.handle(request)
                if request.get('operation') == 'close':
                    roots.pop(request.get('sessionId'), None)
            except Exception as error:
                emit(dict(id=None, ok=False, error=dict(code='surface-wire', message=str(error))))
    finally:
        worker.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
