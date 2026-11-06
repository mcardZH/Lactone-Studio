"""Bounded, stateful NDJSON chemistry session. No trajectories or input files.

RDKit supplies the unchanged explicit molecular potential; ASE supplies mature
integrators/optimizers. Coordinates are angstrom, energies eV and time fs.
The host owns window/document identity and kills abandoned sessions.
"""
from __future__ import annotations

import copy
import json
import math
import os
import queue
import sys
import threading
import time

import numpy as np
import ase
from ase import Atoms, units
from ase.calculators.calculator import Calculator, all_changes
from ase.constraints import FixAtoms
from ase.md.langevin import Langevin
from ase.md.velocitydistribution import MaxwellBoltzmannDistribution
from ase.optimize import LBFGS
from scipy.optimize import minimize

import engine

SCHEMA = 1
KCAL_MOL_TO_EV = units.kcal / units.mol
MAX_LINE_BYTES = 16 * 1024 * 1024


def number(value, code, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        engine.reject(code, f"{code} must be finite and between {low} and {high}.")
    return float(value)


def integer(value, code, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        engine.reject(code, f"{code} must be an integer between {low} and {high}.")
    return value


class RDKitCalculator(Calculator):
    implemented_properties = ["energy", "forces"]

    def __init__(self, structure, forcefield="auto"):
        super().__init__()
        if forcefield not in ("auto", "MMFF94", "MMFF94s", "UFF"):
            engine.reject("forcefield", "Unknown force-field selection.")
        if any(b.get("fractional") is True for b in structure.get("bonds", [])):
            engine.reject("fractional-parameterization", "Standard force fields and MD have no validated potential for explicit fractional connections; use the separate mechanical geometry mode.", engine.diagnostics.fractional_connections(structure))
        engine.require_resolved_perception(structure)
        self.mol = engine.molecule(structure)
        self.graph = engine.native_graph_signature(self.mol)
        self.warnings = []
        variant = "MMFF94s" if forcefield == "MMFF94s" else "MMFF94"
        self.ff = None
        self.forcefield = variant
        # Include all possible nonbonded pairs at setup: a pair initially far
        # apart must remain part of the same potential when MD brings it close.
        # Interfragment interactions are explicitly included for all methods.
        if forcefield != "UFF":
            if engine.AllChem.MMFFHasAllMoleculeParams(self.mol):
                props = engine.AllChem.MMFFGetMoleculeProperties(self.mol, mmffVariant=variant)
                if props is None:
                    engine.reject("parameterization", "MMFF properties failed after coverage was established.")
                self.ff = engine.AllChem.MMFFGetMoleculeForceField(
                    self.mol, props, nonBondedThresh=1e6, ignoreInterfragInteractions=False)
                if self.ff is None:
                    engine.reject("parameterization", "MMFF setup failed; fallback is permitted only for missing coverage.")
            else:
                self.warnings.append(variant + " lacks parameters; using UFF for the unchanged explicit graph.")
        if self.ff is None:
            self.forcefield = "UFF"
            if not engine.AllChem.UFFHasAllMoleculeParams(self.mol):
                engine.reject("parameterization", "UFF does not cover this explicit graph.", engine.diagnostics.uff_missing_types(self.mol, structure))
            self.ff = engine.AllChem.UFFGetMoleculeForceField(
                self.mol, vdwThresh=1e6, ignoreInterfragInteractions=False)
            if self.ff is None:
                engine.reject("parameterization", "UFF setup failed for this explicit graph.")
        self.ff.Initialize()
        if engine.native_graph_signature(self.mol) != self.graph:
            engine.reject("graph-change", "Force-field setup changed the explicit chemical graph.")

    def calculate(self, atoms=None, properties=("energy", "forces"), system_changes=all_changes):
        super().calculate(atoms, properties, system_changes)
        xyz = self.atoms.get_positions()
        if not np.all(np.isfinite(xyz)):
            engine.reject("coordinates", "Non-finite coordinates were rejected.")
        flat = xyz.ravel().tolist()
        energy = self.ff.CalcEnergy(flat) * KCAL_MOL_TO_EV
        forces = -np.asarray(self.ff.CalcGrad(flat)).reshape((-1, 3)) * KCAL_MOL_TO_EV
        if not math.isfinite(energy) or not np.all(np.isfinite(forces)):
            engine.reject("non-finite-forcefield", "Non-finite force-field energy or gradient was rejected.")
        self.results = dict(energy=energy, forces=forces)


class Stopped(Exception):
    pass


class Session:
    def __init__(self, request):
        self.request = copy.deepcopy(request)
        self.operation = request.get("operation")
        if self.operation not in ("md", "optimize"):
            engine.reject("operation", "A session supports md or optimize.")
        if self.operation == "md" and request.get("attachmentPorts"):
            engine.reject("md-open-ports", "An unfinished construction with open ports is not a validated MD molecular potential.")
        checked = copy.deepcopy(dict(request, operation="optimize"))
        cell = checked.get("structure", {}).get("cell")
        finite_box = isinstance(cell, dict) and isinstance(cell.get("pbc"), list) and len(cell["pbc"]) == 3 and all(v is False for v in cell["pbc"])
        if finite_box:
            # A finite visualization box does not turn a molecule periodic.
            # Remove it only from legacy validation, preserving the exact
            # original metadata in every session frame and export.
            checked["structure"].pop("cell")
        engine.validate(checked)
        self.structure = copy.deepcopy(request["structure"])
        if self.structure.get("dimension", 3) != 3:
            engine.reject("dimension", "A dynamics session requires actual three-dimensional coordinates.")
        self.max_steps = integer(request.get("maxSteps", 100000 if self.operation == "md" else 500), "maxSteps", 1, 9007199254740991)
        self.max_wall_seconds = None if request.get("maxWallTimeSeconds") is None else number(request["maxWallTimeSeconds"], "maxWallTimeSeconds", 0, sys.float_info.max)
        self.target_temperature = number(request.get("temperatureK", 300), "temperatureK", 0, 5000)
        self.seed = integer(request.get("seed", 731), "seed", 0, 2**32-1)
        self.friction = number(request.get("frictionPerFs", 0.01), "frictionPerFs", 0, 1)
        if request.get("dtFs", 1) != 1 or request.get("reportEvery", 10) != 10:
            engine.reject("integration-settings", "This session uses 1 fs MD steps and one candidate frame per 10 steps.")
        self.freezes = [c for c in request.get("constraints", []) if c["action"] == "freeze"]
        if self.operation == "md" and self.freezes:
            engine.reject("md-internal-constraints", "B/A/D momentum constraints have not been validated for MD; use XYZ freezes or constrained optimization.")
        self.calculator = RDKitCalculator(self.structure, request.get("forcefield", "auto"))
        self.atoms = Atoms(symbols=[a["element"] for a in self.structure["atoms"]],
                           positions=engine.coordinates(self.structure), pbc=False)
        movable = set(request["movableAtomIds"])
        self.fixed = [i for i, a in enumerate(self.structure["atoms"]) if a["id"] not in movable]
        self.initial_xyz = self.atoms.positions.copy()
        # An imported XYZ can carry genuine stereochemistry without redundant
        # app stereoParity metadata. Identify chemically stereogenic four-
        # neighbour centers once at startup; thereafter protect their actual
        # stable-ID-ordered signed volumes without reassigning static labels
        # on every thermally moving frame or changing public atom metadata.
        self.md_stereo_reference = copy.deepcopy(self.structure)
        self.md_tetrahedral_indices = set()
        for atom in self.calculator.mol.GetAtoms():
            if atom.HasProp("_CIPCode") and len(atom.GetNeighbors()) == 4:
                self.md_tetrahedral_indices.add(atom.GetIdx())
                self.md_stereo_reference["atoms"][atom.GetIdx()]["stereoParity"] = 1
        self.md_expected_tetra, self.md_expected_double = engine.stereo_geometry(self.md_stereo_reference)
        if self.fixed:
            self.atoms.set_constraint(FixAtoms(indices=self.fixed))
        self.atoms.calc = self.calculator
        self.rng = np.random.default_rng(self.seed)
        self.integrator = None
        self.step = 0
        self.paused = False
        self.stopped = False
        self.started_at = time.monotonic()
        self.pause_started = None
        self.paused_seconds = 0
        self.last_validated = None
        self.constraint_residuals = []
        if self.operation == "md":
            MaxwellBoltzmannDistribution(self.atoms, temperature_K=self.target_temperature, rng=self.rng)
            self.integrator = Langevin(self.atoms, timestep=units.fs, temperature_K=self.target_temperature,
                                       friction=self.friction / units.fs, fixcm=False, rng=self.rng, logfile=None)
        self.last_validated = self.snapshot()

    def pause(self):
        if not self.paused:
            self.pause_started = time.monotonic()
        self.paused = True

    def resume(self):
        if self.pause_started is not None:
            self.paused_seconds += time.monotonic()-self.pause_started
            self.pause_started = None
        self.paused = False

    def running_seconds(self):
        pending = time.monotonic()-self.pause_started if self.pause_started is not None else 0
        return time.monotonic()-self.started_at-self.paused_seconds-pending

    def set_temperature(self, value):
        if self.operation != "md":
            engine.reject("temperature-operation", "Temperature controls require an MD session.")
        self.target_temperature = number(value, "temperatureK", 0, 5000)
        self.integrator.set_temperature(temperature_K=self.target_temperature)

    def advance(self):
        if self.paused or self.stopped:
            return False
        if not self.request.get('untilStopped') and self.step >= self.max_steps:
            return False
        # ASE's public run(1) retains its integrator, RNG and velocities.
        self.integrator.run(1)
        self.step += 1
        self.last_validated = self.snapshot()
        return True

    def snapshot(self):
        xyz = self.atoms.get_positions()
        if not np.all(np.isfinite(xyz)):
            engine.reject("coordinates", "A candidate frame contains non-finite positions.")
        if self.fixed and not np.array_equal(xyz[self.fixed], self.initial_xyz[self.fixed]):
            engine.reject("fixed-atom-moved", "A fixed XYZ moved; the frame was rejected.")
        if self.calculator.graph != engine.native_graph_signature(self.calculator.mol):
            engine.reject("graph-change", "A candidate frame changed the chemical graph.")
        output = copy.deepcopy(self.structure)
        for atom, pos in zip(output["atoms"], xyz):
            atom.update(x=float(pos[0]), y=float(pos[1]), z=float(pos[2]))
        output.pop("molfile", None)
        if self.operation == "md":
            # Thermal motion is not an optimizer endpoint: test actual signed
            # geometry rather than reassigning RDKit's static stereo labels.
            geometry = dict(output, atoms=[dict(a, stereoParity=1) if i in self.md_tetrahedral_indices else a
                                           for i, a in enumerate(output["atoms"])])
            after_tetra, after_double = engine.stereo_geometry(geometry)
            if any(value != after_tetra.get(i) for i, value in self.md_expected_tetra.items()) or any(
                    value and value != after_double.get(i) for i, value in self.md_expected_double.items()):
                engine.reject("md-stereo-instability", "A molecular stereocenter or double-bond geometry inverted or became singular; the last validated frame is retained.")
        else:
            engine.check_stereo(self.structure, output)
        energy = float(self.atoms.get_potential_energy())
        kinetic = float(self.atoms.get_kinetic_energy())
        temperature = float(self.atoms.get_temperature())
        if not all(math.isfinite(v) for v in (energy, kinetic, temperature)):
            engine.reject("non-finite-state", "A candidate frame contains non-finite physical state.")
        return dict(stamp=self.request.get("stamp"), operation=self.operation, step=self.step,
                    timeFs=self.step if self.operation == "md" else 0,
                    structure=output, movableAtomIds=self.request["movableAtomIds"],
                    forcefield=self.calculator.forcefield, engine="RDKit+ASE",
                    engineVersion=engine.VERSION, aseVersion=ase.__version__,
                    energyEV=energy, kineticEnergyEV=kinetic, temperatureK=temperature,
                    targetTemperatureK=self.target_temperature, timestepFs=1,
                    units=dict(positions="angstrom", energy="eV", time="fs", temperature="K"),
                    warnings=self.calculator.warnings, constraintResiduals=self.constraint_residuals)

    def optimize(self, callback):
        if not self.freezes:
            optimizer = LBFGS(self.atoms, logfile=None, trajectory=None, maxstep=0.1)
            def accepted():
                self.step = optimizer.nsteps
                self.last_validated = self.snapshot()
                callback()
            optimizer.attach(accepted, interval=1)
            converged = optimizer.run(fmax=0.0044, steps=self.max_steps)
            return bool(converged)
        # Same precise Cartesian-variable SLSQP constraints as the original
        # native worker. No penalty potential and no optimize-then-restore XYZ.
        initial = self.initial_xyz.ravel().copy()
        variable = [3*i+j for i in range(len(self.atoms)) if i not in self.fixed for j in range(3)]
        ids = {a["id"]: i for i, a in enumerate(self.structure["atoms"])}
        rows = [(c, tuple(ids[a] for a in c["atomIds"])) for c in self.freezes]
        rows = [(c, ix, engine.internal_value(self.initial_xyz, c["type"], ix)) for c, ix in rows]
        def full(x):
            result = initial.copy()
            result[variable] = x
            return result.reshape((-1, 3))
        def energy(x):
            self.atoms.set_positions(full(x))
            return self.atoms.get_potential_energy()
        def gradient(x):
            self.atoms.set_positions(full(x))
            return -self.atoms.get_forces(apply_constraint=False).ravel()[variable]
        active, seen = [], set()
        for c, ix, target in rows:
            if not any(i not in self.fixed for i in ix):
                continue
            key = (c["type"], min(ix, ix[::-1]))
            if key in seen:
                continue
            seen.add(key)
            active.append(dict(type="eq", fun=lambda x, row=(c, ix, target): engine.coordinate_delta(
                engine.internal_value(full(x), row[0]["type"], row[1]), row[2], row[0]["type"])))
        def validate_residuals(x):
            residuals = []
            for c, ix, target in rows:
                value = engine.internal_value(full(x), c["type"], ix)
                residual = engine.coordinate_delta(value, target, c["type"])
                if abs(residual) > (1e-6 if c["type"] == "B" else 1e-5):
                    return None
                scale = 1 if c["type"] == "B" else 180/math.pi
                residuals.append(dict(id=c.get("id"), type=c["type"], target=target*scale,
                                      actual=value*scale, residual=residual*scale,
                                      unit="angstrom" if c["type"] == "B" else "degree"))
            return residuals
        def accepted(x):
            self.step += 1
            self.atoms.set_positions(full(x))
            residuals = validate_residuals(x)
            # An SLSQP accepted intermediate can still be infeasible. Poll
            # controls every iteration, but publish only a physically validated
            # constraint frame, never a transient broken frozen coordinate.
            if residuals is not None:
                self.constraint_residuals = residuals
                self.last_validated = self.snapshot()
            callback(publish=residuals is not None)
        result = minimize(energy, initial[variable], jac=gradient, constraints=active,
                          method="SLSQP", callback=accepted,
                          options=dict(maxiter=self.max_steps, ftol=1e-10, disp=False))
        if not result.success and result.status != 9:
            engine.reject("constraint-solver", "The exact constraint solver could not resolve this constraint set.")
        residuals = validate_residuals(result.x)
        if residuals is None:
            engine.reject("constraint-residual", "The final frozen internal coordinate exceeded its verified tolerance.")
        self.atoms.set_positions(full(result.x))
        self.constraint_residuals = residuals
        self.last_validated = self.snapshot()
        return bool(result.success)


def create_session(request, native_context=None):
    if request.get('method') is not None:
        if request.get('operation') != 'md' or not isinstance(native_context, dict):
            engine.reject('md-native-context', 'GFN MD需要桌面提供实际原生运行环境。')
        from dynamics_native_md import Session as NativeMDSession
        return NativeMDSession(request, native_context)
    if request.get("geometryMode") is not None:
        if request.get("operation") != "geometry" or request["geometryMode"] != "hybrid-local":
            engine.reject("geometry-mode", "The selected geometry mode is not supported for this operation; MD never uses partial UFF or local mechanical replacements.")
        from hybrid_geometry import Session as HybridSession
        return HybridSession(request)
    if request.get("operation") == "geometry":
        from geometry_clean import Session as GeometrySession
        return GeometrySession(request)
    return Session(request)


def main():
    incoming = queue.Queue(maxsize=64)
    def reader():
        pending = b""
        while True:
            # Read the raw fd: a blocked daemon must not own Python's buffered
            # stdin lock while the finite worker shuts down on Windows.
            block = os.read(sys.stdin.fileno(), 65536)
            if not block:
                incoming.put(None)
                return
            pending += block
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                try:
                    obj = json.loads(line, parse_constant=lambda _: engine.reject("request", "Non-finite JSON is unsupported."))
                    if not isinstance(obj, dict):
                        engine.reject("request", "A session command must be an object.")
                    incoming.put(obj)
                except Exception as exc:
                    incoming.put(exc)
                    return
    threading.Thread(target=reader, daemon=True).start()
    session = None
    session_id = None
    seq = 0
    last_event_at = time.monotonic()
    original_request = {}
    def emit(event, snapshot=None, **extra):
        nonlocal seq, last_event_at
        seq += 1
        last_event_at = time.monotonic()
        fallback = dict(stamp=original_request.get("stamp"), operation=original_request.get("operation"), step=0, timeFs=0)
        payload = dict(schema=SCHEMA, sessionId=session_id, event=event, seq=seq,
                       **(snapshot if snapshot is not None else (session.last_validated if session else fallback)), **extra)
        if session is not None and session.operation != "geometry":
            payload["targetTemperatureK"] = session.target_temperature
        sys.stdout.write(json.dumps(payload, allow_nan=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    def command(obj):
        if obj is None:
            raise Stopped()
        if isinstance(obj, Exception):
            raise obj
        if obj.get("schema") != SCHEMA or obj.get("sessionId") != session_id:
            engine.reject("session-identity", "The command schema or session identity does not match.")
        action = obj.get("command")
        if action == "stop":
            session.stopped = True
            raise Stopped()
        if session.operation == 'md' and original_request.get('untilStopped'):
            engine.reject('md-command', 'MD持续运行直到停止；不能暂停、恢复或修改运行温度。')
        if action == "pause":
            session.pause()
            emit("paused")
        elif action == "resume":
            if "temperatureK" in obj:
                session.set_temperature(obj["temperatureK"])
            session.resume()
            emit("resumed")
        elif action == "set-temperature":
            session.set_temperature(obj.get("temperatureK"))
            emit("temperature")
        else:
            engine.reject("command", "Unknown chemistry-session command.")
    def controls():
        while True:
            if session.max_wall_seconds is not None and session.running_seconds() > session.max_wall_seconds:
                engine.reject("walltime", "The bounded session walltime limit was reached.")
            if time.monotonic()-last_event_at >= 5:
                emit("heartbeat")
            try:
                obj = incoming.get(timeout=0.05) if session.paused else incoming.get_nowait()
                command(obj)
            except queue.Empty:
                if not session.paused:
                    return
    try:
        first = incoming.get()
        if isinstance(first, Exception):
            raise first
        if not first or first.get("schema") != SCHEMA or first.get("command") != "start":
            engine.reject("start", "The first command must start a schema-1 session.")
        session_id = first.get("sessionId")
        if not isinstance(session_id, str) or not session_id or len(session_id) > 256:
            engine.reject("session-identity", "A bounded nonempty session ID is required.")
        original_request = first.get("request", {})
        if not isinstance(original_request, dict):
            original_request = {}
            engine.reject("request", "A session start request must be an object.")
        emit("ready")
        session = create_session(original_request, first.get('nativeContext'))
        emit("started")
        if session.operation == "md":
            if original_request.get('method'):
                session.run(emit, controls)
                engine.reject('md-unexpected-completion', '连续MD意外完成。')
            while original_request.get('untilStopped') or session.step < session.max_steps:
                controls()
                session.advance()
                if session.step % 10 == 0:
                    emit("frame")
            emit("completed", converged=False, reason="step-limit")
        else:
            def accepted(publish=True):
                controls()
                if publish:
                    emit("frame")
            controls()
            converged = session.optimize(accepted)
            emit("completed", converged=converged, reason=getattr(session, 'completion_reason', None) or ("converged" if converged else "step-limit"))
        return 0
    except Stopped:
        emit("stopped", reason="cancelled-or-stdin-closed")
        return 0
    except Exception as exc:
        emit("error", error=engine.error_payload(exc, "The native session failed; its last validated frame is retained."))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
