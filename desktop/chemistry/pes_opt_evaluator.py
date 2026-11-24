"""Physical gradients for fixed-cell tblite and externally configured g-xTB."""

import hashlib
from pathlib import Path
import re

import numpy as np

from conformer_gfnff import isolated_coordinate_input, ordinary_directory, ordinary_file, parse_isolated_engrad
from pes_core import (BOHR_ANGSTROM, NativeGfnEvaluator, PesCancelled, PesError, native_electronic_failure,
                      native_scc_started, native_shared_failure, number, require, sparse_bond_orders)
from task_files import clean_evaluation


_NUMBER = r'[-+\d.eEdD]+'


class NativeOptEvaluator(NativeGfnEvaluator):
    """Reuse the existing owned process and cancellation for these CLI routes."""

    def __init__(self, request, runtime, workspace, *, cancelled=None):
        self.gxtb = request['method'] == 'gxtb'
        self.cell = request['structure'].get('cell')
        require(not request.get('solvation'), 'This xTB gradient route requires no implicit solvent')
        if self.gxtb:
            require(request.get('operation') == 'opt' and not self.cell
                    and runtime.get('engineIdentity', {}).get('runtimeVariant') == 'gxtb',
                    'g-xTB requires its configured molecular runtime')
            for key in ('executable', 'directory', 'dataDirectory'):
                require(isinstance(runtime.get(key), str) and Path(runtime[key]).is_absolute(),
                        'Trusted host must resolve g-xTB runtime paths')
            self.request, self.runtime, self.workspace = request, runtime, ordinary_directory(Path(workspace))
            self.scc_limit = request.get('parameters', {}).get('maxSccIterations', 250)
            require(type(self.scc_limit) is int and self.scc_limit > 0, 'Invalid g-xTB SCC limit')
            self.evaluations = self.native_invocations = self.hessian_attempts = self.hessian_evaluations = 0
            self.last = self.solvation = self.last_hessian = None
            self.hessian_fallbacks = []
            self.bond_order_used = False
        else:
            require(self.cell and self.cell.get('pbc') == [True, True, True]
                    and request['method'] in ('gfn1', 'gfn2')
                    and request.get('operation') in ('opt', 'scan', 'path', 'ts', 'hessian', 'irc'),
                    'Expected a fixed 3D cell and periodic GFN1 or GFN2 energy/gradient task')
            super().__init__(request, runtime, workspace)
            self.lattice = np.asarray(self.cell['vectors'], dtype=float) / BOHR_ANGSTROM
            self.reciprocal = np.linalg.inv(self.lattice)

    def evidence(self):
        result = super().evidence()
        if self.gxtb:
            result.update(engine='g-xTB', gxtbRelease=self.runtime.get('gxtbRelease'))
            if self.last:
                result.update(version=self.last['hostVersion'], spinTreatment=self.last['spinTreatment'])
        else:
            result.update(provider='tblite', providerInterface='xtb-cli', fixedCell=True, sourceCell=self.cell)
        return result


    def _coordinates(self, atoms, bohr):
        molecular = isolated_coordinate_input(atoms, bohr)
        if self.gxtb:
            return molecular
        lattice = [' '.join(format(float(value), '.17g') for value in row) for row in self.lattice]
        return '\n'.join([*molecular.splitlines()[:-1], '$periodic 3', '$lattice bohr', *lattice, '$end', ''])

    def _arguments(self, operation):
        require(operation == '--grad', 'This xTB route provides physical gradients')
        request = self.request
        identity = ['--gxtb', '--verbose'] if self.gxtb else ['--gfn', request['method'][-1], '--tblite']
        accuracy = (request.get('parameters', {}).get('accuracy', 1.) if self.gxtb else
                    .1 if request.get('operation') in ('ts', 'hessian', 'irc') else 1.)
        require(type(accuracy) in (int, float) and np.isfinite(accuracy) and accuracy > 0,
                'Invalid xTB accuracy')
        self.last_requested_electronic_settings = dict(accuracy=accuracy, maxSccIterations=self.scc_limit,
                                                       sourceField='CLI:argv')
        argv = [self.runtime['executable'], 'input.coord', *identity, operation, '--norestart',
                '--chrg', str(request['charge']), '--parallel', str(request['threads']),
                '--acc', format(accuracy, '.17g'), '--iterations', str(self.scc_limit)]
        if request['uhf'] or not self.gxtb:
            argv += ['--uhf', str(request['uhf'])]
        return argv

    def _terminal(self, output, errors, exit_code):
        log = output + '\n' + errors
        version = re.search(r'\bxtb version\s+(\d+\.\d+\.\d+(?:pre)?)', output, re.I)
        version_matches = version and self.runtime['version'] in ('unknown', version[1])
        expected_route = self.gxtb or re.search(r'\bPeriodic properties\b', output, re.I)
        if version_matches and expected_route and not native_shared_failure(log):
            failure = native_electronic_failure(log, has_scc=True)
            if failure:
                code, detail = failure
                raise PesError(detail, code)
            if re.search(r'not (?:fully )?converged|did not converge|FAILED TO CONVERGE', log, re.I):
                raise PesError('Native gradient evaluation did not converge', 'PES_XTB_SCC')
            batch = self.request.get('parameters', {}).get('batchFinalOnly') is True
            native_protection_fault = exit_code == -11 or exit_code & 0xffffffff == 0xC0000005
            if ((self.gxtb or batch) and (exit_code == 1 or self.gxtb and native_protection_fault)
                    and native_scc_started(output)):
                raise PesError(f'Native xTB stopped during this structure’s electronic evaluation (exit code {exit_code})',
                               'PES_XTB_EVALUATION')
        require(exit_code == 0 and re.search(r'normal termination of xtb', log, re.I)
                and not re.search(r'ABNORMAL TERMINATION|\[ERROR\]|FATAL ERROR|GEOMETRY OPTIMIZATION|RF solver', log, re.I),
                'Native xTB gradient did not terminate normally', 'PES_XTB_FAILED')
        require(version_matches,
                'Native gradient version does not match the selected runtime', 'PES_XTB_OUTPUT')
        energies = re.findall(r'\|\s*TOTAL ENERGY\s+(' + _NUMBER + r')\s+Eh\s*\|', output)
        require(len(energies) == 1, 'Missing native gradient energy', 'PES_XTB_OUTPUT')
        post = re.search(r'^\s*Post processing:', output, re.M | re.I)
        require(post, 'Missing native electronic postprocessing', 'PES_XTB_OUTPUT')
        cycle = re.search(r'cycle\s+total energy\s+energy error\s+density error', output[:post.start()], re.I)
        iterations = [] if cycle is None else re.findall(
            r'^\s*(\d+)\s+(' + _NUMBER + r')\s+(' + _NUMBER + r')\s+(' + _NUMBER + r')\s*$',
            output[cycle.end():post.start()], re.M)
        require(iterations and [int(row[0]) for row in iterations] == list(range(1, len(iterations) + 1)) and
                len(iterations) <= self.scc_limit, 'Missing native electronic iteration evidence', 'PES_XTB_OUTPUT')
        detail = dict(hostVersion=version[1], sccIterations=len(iterations))
        if self.gxtb:
            def reported(label, unit):
                rows = re.findall(r'^\s*' + label + r'\s+(' + _NUMBER + r')\s+' + unit + r'\s*$', output, re.M | re.I)
                require(rows, 'Missing g-xTB electronic state evidence', 'PES_XTB_OUTPUT')
                return number(rows[-1])
            spin = re.findall(r'^\s*wavefunction\s+(restricted|unrestricted)\s*$', output, re.M | re.I)
            require(spin and (self.request['uhf'] == 0 or spin[-1].lower() == 'unrestricted') and
                    abs(reported('molecular charge', 'e') - self.request['charge']) < 1e-7 and
                    abs(reported('number of unpaired electrons', 'e') - self.request['uhf']) < 1e-7,
                    'g-xTB charge or spin evidence differed from the request', 'PES_XTB_OUTPUT')
            last = iterations[-1]
            require(abs(number(last[2])) <= reported('energy convergence', 'Eh') and
                    0 <= number(last[3]) <= reported('density convergence', 'e'),
                    'g-xTB did not reach the reported SCF thresholds', 'PES_XTB_SCC')
            detail.update(spinTreatment=spin[-1].lower())
        else:
            method = self.request['method'].upper() + '-xTB'
            require('Periodic properties' in output and re.search(r'::\s*' + method + r' energy', output, re.I),
                    'Native gradient did not use the requested periodic tblite method', 'PES_XTB_OUTPUT')
        return number(energies[0]), detail

    def __call__(self, positions, *, need_bond_orders=False):
        self.evaluations += 1
        directory = self.workspace / f'eg-{self.evaluations:08d}'
        directory.mkdir()
        atoms = self.request['structure']['atoms']
        bohr = positions / BOHR_ANGSTROM
        coordinate_input = self._coordinates(atoms, bohr)
        source = directory / 'input.coord'
        with source.open('x', encoding='ascii', newline='\n') as stream:
            stream.write(coordinate_input)
        try:
            stdout, stderr, receipt = self._invoke(self._arguments('--grad'), self._environment(directory), directory)
            summary, details = self._terminal(stdout, stderr, receipt['code'])
            require(ordinary_file(source).read_text(encoding='ascii') == coordinate_input,
                    'Native xTB modified the gradient input', 'PES_XTB_OUTPUT')
            outputs = list(directory.glob('*.engrad'))
            require(len(outputs) == 1, 'Expected one native gradient file', 'PES_XTB_OUTPUT')
            content = ordinary_file(outputs[0]).read_bytes()
            text = content.decode('ascii')
            if self.cell:
                # The CLI wraps input coordinates. Permit lattice translations
                # only; atom indices and gradient order remain exactly native.
                rows = [row.split() for row in text.splitlines() if row.strip() and not row.lstrip().startswith('#')]
                reported = np.asarray([[number(value) for value in row[1:]] for row in rows[-len(atoms):]])
                require(reported.shape == bohr.shape, 'Invalid periodic gradient positions', 'PES_XTB_OUTPUT')
                bohr = bohr + np.rint((reported - bohr) @ self.reciprocal) @ self.lattice
            energy, gradient, _ = parse_isolated_engrad(text, atoms, bohr)
            require(abs(summary - energy) <= 1e-9, 'Gradient energy did not match the native summary', 'PES_XTB_OUTPUT')
            result = dict(energyHartree=energy, gradientHartreePerBohr=gradient)
            if need_bond_orders:
                require(self.gxtb, 'Periodic bond orders require image identities', 'PES_BOND_ORDERS_INVALID')
                self.bond_order_used = True
                result.update(bondOrders=sparse_bond_orders(ordinary_file(directory / 'wbo').read_text(encoding='ascii'), len(atoms)),
                              bondOrderMissingPairUpperBound=.1)
            self.last = dict(receipt, **details, energyHartree=energy,
                             inputSha256=hashlib.sha256(coordinate_input.encode('ascii')).hexdigest(),
                             engradSha256=hashlib.sha256(content).hexdigest())
        except PesCancelled:
            raise
        except (ValueError, OSError) as error:
            raise PesError(str(error), getattr(error, 'code', 'PES_XTB_FAILED'), {'directory': str(directory)}) from error
        try:
            clean_evaluation(directory)
        except (ValueError, OSError) as error:
            self.last['retainedNativeEvidence'] = {'directory': str(directory), 'reason': str(error)}
        return result
