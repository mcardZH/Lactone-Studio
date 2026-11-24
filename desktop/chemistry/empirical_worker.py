"""Fixed serial NDJSON transport for the existing empirical perception function."""
import json
import re
import sys

PROJECTION_MODE = "bond-projection-v1"
ATOM_FIELDS = ("id", "element", "x", "y", "z")
PROJECTION_FIELDS = {"bonds", "bondSource", "bondPerceptionIssues", "notes"}


def unpack_projection_request(request):
    if (request.get("bondPerceptionPolicy") != "composite-v1"
            or "bondOrderEvidence" in request or "stamp" in request):
        raise ValueError("Projection transport accepts empirical composite perception only")
    structure = request["structure"]
    decoded = []
    for row in structure["atoms"]:
        if not isinstance(row, list) or len(row) not in (5, 6):
            raise ValueError("Invalid empirical atom row")
        atom = dict(zip(ATOM_FIELDS, row))
        if len(row) == 6:
            attributes = row[5]
            if not isinstance(attributes, dict) or atom.keys() & attributes.keys():
                raise ValueError("Invalid empirical atom attributes")
            atom.update(attributes)
        decoded.append(atom)
    structure["atoms"] = decoded


def pack_projection_result(request, result):
    source, output = request["structure"], result["structure"]
    if (result["stamp"] is not None or result["movableAtomIds"] != request["movableAtomIds"]
            or any(output.get(key) != source.get(key) for key in source.keys() | output.keys()
                   if key not in PROJECTION_FIELDS)
            or (source.keys() ^ output.keys()) - PROJECTION_FIELDS):
        raise ValueError("Empirical perception changed frame identity or source geometry")
    result["projection"] = {key: value for key, value in output.items() if key in PROJECTION_FIELDS}
    for key in ("structure", "stamp", "movableAtomIds"):
        del result[key]
    return result


def main(*, run, error_payload):
    from finite_empirical import FiniteEmpiricalSession
    finite_session = FiniteEmpiricalSession()
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return 0
        request_id = None
        try:
            if not line.endswith(b"\n"):
                raise ValueError("Empirical request exceeds the native line limit")
            envelope = json.loads(line.decode("utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))
            if not isinstance(envelope, dict) or (
                    set(envelope) != {"id", "request"} and
                    (set(envelope) != {"id", "request", "mode"} or envelope["mode"] != PROJECTION_MODE)):
                raise ValueError("Invalid empirical envelope")
            request_id = envelope["id"]
            if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", request_id):
                raise ValueError("Invalid empirical request identity")
            request = envelope["request"]
            if not isinstance(request, dict) or request.get("operation") != "perceive-bonds":
                raise ValueError("Worker accepts existing empirical perception only")
            compact = envelope.get("mode") == PROJECTION_MODE
            if compact:
                unpack_projection_request(request)
            result = run(request, finite_session=finite_session) if compact else run(request)
            if compact:
                result = pack_projection_result(request, result)
            response = {"id": request_id, "ok": True, "result": result}
        except Exception as error:
            response = {"id": request_id, "ok": False, "error": error_payload(error, "Empirical perception failed; the source is unchanged.")}
        sys.stdout.write(json.dumps(response, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()
        if not line.endswith(b"\n"):
            return 1
        # Release the frame envelope; the session owns only bounded candidate and chemistry scratch.
        line = envelope = request = response = result = None
