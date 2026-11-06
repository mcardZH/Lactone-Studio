"""Fixed serial NDJSON transport for the existing empirical perception function."""
import json
import re
import sys



def main(*, run, error_payload):
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return 0
        request_id = None
        try:
            if not line.endswith(b"\n"):
                raise ValueError("Empirical request exceeds the native line limit")
            envelope = json.loads(line.decode("utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))
            if not isinstance(envelope, dict) or set(envelope) != {"id", "request"}:
                raise ValueError("Invalid empirical envelope")
            request_id = envelope["id"]
            if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", request_id):
                raise ValueError("Invalid empirical request identity")
            request = envelope["request"]
            if not isinstance(request, dict) or request.get("operation") != "perceive-bonds":
                raise ValueError("Worker accepts existing empirical perception only")
            response = {"id": request_id, "ok": True, "result": run(request)}
        except Exception as error:
            response = {"id": request_id, "ok": False, "error": error_payload(error, "Empirical perception failed; the source is unchanged.")}
        sys.stdout.write(json.dumps(response, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()
        if not line.endswith(b"\n"):
            return 1
        # Retain no previous molecular input while the worker is idle.
        line = envelope = request = response = None
