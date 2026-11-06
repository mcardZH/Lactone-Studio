"""Native isolated GFN0 E/G using the existing owned xTB process transport.

No TBLite substitution, FF topology, native MD, implicit solvent or optimizer.
Each geometry starts from its own clean directory with --norestart.
"""
import re
from conformer_gfnff import IsolatedGfnffCalculator, require
from xtb_periodic import finite_number


class IsolatedGfn0Calculator(IsolatedGfnffCalculator):
    method = 'gfn0'

    def method_arguments(self):
        settings = self.request['calculator']
        # The locked parser accepts --gfn0 but recommends canonical --gfn 0.
        return ['--gfn', '0', '--uhf', str(self.request['uhf']),
                '--acc', str(settings['accuracy']), '--etemp', str(settings['electronicTemperatureK'])]

    def prepare_seed(self, directory):
        return False

    def accept_seed(self, directory, output, seeded):
        require(not seeded and not (directory/'gfnff_topo').exists(), 'GFN0 cannot carry an FF topology')

    def topology_evidence(self, seeded):
        return dict(topologyReadFromOwnedSeed=False)

    def native_status(self, output, errors):
        combined = output+'\n'+errors
        version = re.search(r'\bxtb version\s+(\d+\.\d+\.\d+(?:pre)?)', output, re.I)
        require('normal termination of xtb' in errors.lower() and version is not None
                and version.group(1) == self.runtime['version'], 'Native GFN0 version/termination mismatch')
        # The citation inventory lists all GFN methods regardless of the actual
        # Hamiltonian. Only the boxed method heading identifies this run.
        headings = [re.sub(r'\s+', '', title).upper() for title in
                    re.findall(r'^\s*\|\s*([^|\r\n]+?)\s*\|\s*$', output, re.M)]
        methods = [title for title in headings if re.fullmatch(r'GFN(?:\d+-XTB|-FF)', title)]
        require(methods == ['GFN0-XTB']
                and not re.search(r'Periodic properties|GEOMETRY OPTIMIZATION|Fast Inertial Relaxation Engine|RF solver', output, re.I),
                'Expected only an isolated native GFN0 gradient')
        require(not re.search(r'ABNORMAL TERMINATION|\[ERROR\]|FATAL ERROR|Single point calculation terminated|FAILED TO CONVERGE', combined, re.I),
                'Native isolated GFN0 calculation failed')
        energies = re.findall(r'\|\s*TOTAL ENERGY\s+([-+\d.eEdD]+)\s+Eh\s*\|', output)
        require(len(energies) == 1, 'Native GFN0 total energy is absent or ambiguous')
        return finite_number(energies[0])

    def evidence(self):
        return dict(engine='native-xtb', method='gfn0', version=self.runtime['version'], evaluations=self.evaluations,
                    spinTreatment='native-uhf', coordinateTransform=dict(kind='identity', offsetAngstrom=[0, 0, 0]),
                    calculatorSettings=dict(accuracy=self.request['calculator']['accuracy'],
                                            electronicTemperatureK=self.request['calculator']['electronicTemperatureK'],
                                            maxIterationsApplicable=False), lastEvaluation=self.last_evidence)
