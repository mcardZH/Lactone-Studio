"""Serialized NDJSON main-20 worker. Control/observer messages never become science."""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor
import json
from analysis_result_wire import managed_result
import sys
import threading

from interaction_analysis import InteractionAnalysisSession, InteractionError, bounded_id
from multiwfn_resources import resolve_resources


class InteractionWorker:
    def __init__(self, emit):
        self.emit = emit; self.sessions = {}; self.lock = threading.RLock()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='interaction-native')
        self.closed = False; self.active = None; self.futures = set()

    def reply(self, request, result=None, error=None, native_settled=None, retained_bytes=None):
        packet = dict(id=request.get('id'), sessionId=request.get('sessionId'), ok=error is None)
        if native_settled is not None:
            packet['nativeSettled'] = native_settled
        if retained_bytes is not None:
            packet['retainedMemoryBytes'] = retained_bytes
        if error is None:
            packet['result'] = result
        else:
            packet['error'] = dict(code=getattr(error, 'code', 'interaction-worker'), message=str(error))
        self.emit(packet)

    def handle(self, request):
        try:
            if not isinstance(request, dict) or not bounded_id(request.get('sessionId')):
                raise InteractionError('interaction-request', 'Expected a bounded owned session request.')
            operation = request.get('operation'); session_id = request['sessionId']
            if operation == 'resources':
                resources, _ = resolve_resources(request['executable'])
                self.reply(request, resources); return
            if operation == 'open':
                with self.lock:
                    if self.closed or session_id in self.sessions:
                        raise InteractionError('interaction-session', 'Worker is closed or session id is duplicated/over limit.')
                    session = InteractionAnalysisSession(request); self.sessions[session_id] = session
                self.reply(request, session.capabilities(), retained_bytes=session.retained_memory_bytes()); return
            with self.lock:
                session = self.sessions.get(session_id)
                if session is None or self.closed:
                    raise InteractionError('interaction-session', 'This owned interaction session is absent or closed.')
                epoch = session.epoch
            if operation == 'capabilities':
                self.reply(request, session.capabilities(), retained_bytes=session.retained_memory_bytes()); return
            if operation in ('cancel', 'close'):
                if operation == 'cancel':
                    session.cancel()
                else:
                    session.close()
                    with self.lock:
                        self.sessions.pop(session_id, None)
                self.reply(request, dict(sessionId=session_id, status='cancelled' if operation == 'cancel' else 'closed', nativeSettled=True, activeNativeCount=0), native_settled=True, retained_bytes=session.retained_memory_bytes()); return
            if operation == 'evidence':
                self.reply(request, session.evidence(), retained_bytes=session.retained_memory_bytes()); return
            methods = {'generate': session.generate, 'contributions': session.contributions,
                       'restore-fields': session.restore_fields, 'export-cube': session.export_cube}
            if operation not in methods:
                raise InteractionError('interaction-operation', 'Unsupported operation; arbitrary native menus are not exposed.')
            scientific = operation in ('generate', 'contributions')
            def execute():
                result = None; failure = None; settled = None
                try:
                    with self.lock:
                        if self.closed or self.sessions.get(session_id) is not session or session.epoch != epoch:
                            raise InteractionError('interaction-cancelled', 'Queued interaction request was cancelled before start.')
                        session.cancelled.clear()
                        if scientific or operation in ('restore-fields', 'export-cube'):
                            session.apply_resources(request.get('resources'))
                        if scientific:
                            for other in self.sessions.values():
                                if other is not session:
                                    other.stop_native()
                        self.active = session
                    if scientific:
                        def progress(packet):
                            with self.lock:
                                if session.epoch != epoch or session.closed or self.sessions.get(session_id) is not session:
                                    return
                            self.emit(dict(event='task-progress', id=request.get('id'), sessionId=session_id, progress=packet))
                        session.progress_callback = progress
                    result = methods[operation](request['request'])
                    if session.epoch != epoch or session.closed:
                        raise InteractionError('interaction-cancelled', 'Interaction response no longer belongs to the active source/request.')
                except Exception as error:
                    failure = error
                finally:
                    if scientific:
                        try:
                            session.stop_native(); settled = True
                        except Exception as error:
                            failure = error; settled = False
                        session.progress_callback = None
                    with self.lock:
                        if self.active is session:
                            self.active = None
                self.reply(request, result, failure, settled, session.retained_memory_bytes())
            future = self.executor.submit(execute)
            with self.lock:
                self.futures.add(future)
            def discard(done):
                with self.lock:
                    self.futures.discard(done)
            future.add_done_callback(discard)
        except Exception as error:
            self.reply(request if isinstance(request, dict) else {}, error=error)

    def close(self):
        with self.lock:
            self.closed = True
            sessions = list(self.sessions.values()); self.sessions.clear()
        for session in sessions:
            session.close()
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
    worker = InteractionWorker(emit)
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
                emit(dict(id=None, ok=False, error=dict(code='interaction-wire', message=str(error))))
    finally:
        worker.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
