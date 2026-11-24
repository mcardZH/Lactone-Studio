"""Resident task-owned energy and force calculators for ordinary ASE MD."""
from __future__ import annotations

import hashlib
import json
import time

import numpy as np
from ase import Atoms, units
from ase.calculators.calculator import Calculator, all_changes

from pes_core import atom_numbers, initial_positions


class _EvaluationContext:
    def __init__(self, check):
        self.check_cancelled = check

    def emit(self, _event, _details):
        # The MD session owns progress and publication.
        pass


def _normalized_request(request, context):
    structure = request['structure']
    charge = request.get('charge', structure.get('charge') or 0)
    settings = request.get('calculator', {})
    calculation = dict(
        operation='md', method=request['method'], structure=structure,
        charge=charge, threads=context['threads'],
        memoryBudgetBytes=context.get('memoryBudgetBytes'),
        parameters=dict(accuracy=settings.get('accuracy', 2.0), maxSccIterations=settings.get('maxIterations', 250),
                        electronicTemperatureK=settings.get('electronicTemperatureK', 300.0)),
    )
    if request.get('solvation'):
        calculation['solvation'] = request['solvation']
    if request['method'] == 'gfnff':
        reference = {**structure, 'charge': charge}
        reference_id = hashlib.sha256(json.dumps(reference, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        calculation['ffModel'] = dict(schemaVersion=1, method='gfnff', modelId=f'md-{reference_id}',
            reference=reference, atomOrder=[atom['id'] for atom in structure['atoms']],
            solvation=calculation.get('solvation'))
    else:
        calculation['uhf'] = request.get('uhf', (structure.get('multiplicity') or 1) - 1)
    return calculation


class _ResidentCalculator(Calculator):
    implemented_properties = ['energy', 'forces']

    def __init__(self, request, context, check):
        super().__init__()
        self.backend, self.method = context['backend'], request['method']
        self.check = check
        self.evaluations = 0
        self.elapsed_seconds = 0.0
        self.provider_seconds = 0.0
        self.physical_atoms = None
        parameters = _normalized_request(request, context)
        self.electronic = {}
        self.electronic['accuracy'] = parameters['parameters']['accuracy']
        if self.method in ('gfn1', 'gfn2'):
            for name in ('maxSccIterations', 'electronicTemperatureK'):
                self.electronic[name] = parameters['parameters'][name]
        if self.backend == 'libxtb':
            from pes_libxtb import LibXtbEvaluator
            self.evaluator = LibXtbEvaluator(parameters, context['libxtb'], context['workspacePath'])
            self.version = self.evaluator.api.identity['version']
        elif self.backend == 'tblite':
            from pes_libxtb import TbliteEvaluator
            self.evaluator = TbliteEvaluator(parameters, context['tblite'])
            self.version = self.evaluator.version
        else:
            raise ValueError('Unknown resident MD evaluator')
        if self.backend != 'tblite':
            self.evaluator.bind(_EvaluationContext(check))

    def calculate(self, atoms=None, properties=('energy', 'forces'), system_changes=all_changes):
        started = time.perf_counter()
        if atoms is not None:
            # Retain an unconstrained geometry snapshot through ASE's cache
            # invalidation. The normal fixed-cell step changes positions only.
            if self.physical_atoms is None or any(change != 'positions' for change in system_changes):
                self.physical_atoms = Atoms(numbers=atoms.numbers, positions=atoms.positions, cell=atoms.cell, pbc=atoms.pbc)
            else:
                self.physical_atoms.positions[:] = atoms.positions
            self.atoms = self.physical_atoms
        self.check()
        provider_started = time.perf_counter()
        observation = self.evaluator.evaluate_node(self.atoms.positions)
        self.provider_seconds += time.perf_counter() - provider_started
        energy = observation['energyHartree'] * units.Hartree
        forces = -np.asarray(observation['gradientHartreePerBohr']) * (units.Hartree / units.Bohr)
        if forces.shape != (len(self.atoms), 3) or not np.isfinite(energy) or not np.isfinite(forces).all():
            raise RuntimeError('MD evaluator returned invalid energy or forces')
        self.elapsed_seconds += time.perf_counter() - started
        self.evaluations += 1
        self.results = {'energy': energy, 'forces': forces}

    def evidence(self):
        if self.backend == 'libxtb':
            evaluator = self.evaluator
            identity = {**evaluator.parameter_identity, 'settingsId': evaluator.settings_id,
                'coldStarts': evaluator.cold_starts, 'warmStarts': evaluator.warm_starts}
            if evaluator.ff_model is not None:
                identity['ffModelId'] = evaluator.ff_model['modelId']
        else:
            identity = self.evaluator.evidence()
        if self.electronic:
            identity = {**identity, 'electronicSettings': self.electronic}
        return dict(engine=self.backend, method=self.method, version=self.version,
                    evaluations=self.evaluations, seconds=self.elapsed_seconds,
                    providerSeconds=self.provider_seconds, identity=identity)

    def close(self):
        self.evaluator.close()


def create_calculator(request, ase_context, check):
    return _ResidentCalculator(request, ase_context, check)
