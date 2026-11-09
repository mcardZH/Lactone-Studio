"""Shared conformer ALPB capability and strict native stdout readback.

The JSON is a packaging data dependency, never a second set of input parameters.
Only native xTB chooses its calculation parameter set.
"""
import json
from pathlib import Path
import re
import sys

def _resolve_capability_path():
    if getattr(sys, 'frozen', False):
        return Path(sys._MEIPASS) / 'conformer-solvation.json'
    here = Path(__file__).resolve()
    for candidate in (
        here.parents[2] / 'src/data/conformer-solvation.json',
        here.parent / 'conformer-solvation.json',
        here.parents[1] / 'app/src/data/conformer-solvation.json',
    ):
        if candidate.is_file():
            return candidate
    return here.parents[2] / 'src/data/conformer-solvation.json'


_path = _resolve_capability_path()
CAPABILITY = json.loads(_path.read_text(encoding='utf-8'))
assert CAPABILITY['schema'] == 'ester-conformer-solvation/v1'
PRESETS = {row['id']: row for row in CAPABILITY['presets']}


def native_alpb_supported(method, operation, solvent):
    return method in CAPABILITY['nativeMethods'] and operation in CAPABILITY['nativeOperations'] and solvent in PRESETS


def native_solvation(output, request):
    """Read the one real setup block, never the ALPB literature reference."""
    output = output.replace('\r\n', '\n')
    markers = list(re.finditer(r'^[ \t]*\*[ \t]+Solvation model:[ \t]+([^\n]+)$', output, re.M))
    wanted = request.get('solvation')
    def require(condition, message):
        if not condition:
            raise ValueError(message)
    if wanted is None:
        require(not re.search(r'^[ \t]*\*?[ \t]*Solvation model:', output, re.M), 'Gas-phase native MD unexpectedly used solvation')
        return None
    require(len(markers) == 1, 'Native MD solvation setup is missing or ambiguous')
    tail = output[markers[0].start():markers[0].start()+8192]
    end = re.search(r'^[ \t]+Grid points[ \t]+\d+[ \t]+per atom[ \t]*$', tail, re.M)
    require(end is not None, 'Native MD solvation setup is truncated')
    block = tail[:end.start()]
    def field(label):
        rows = [line for line in block.splitlines() if line.startswith('        ') and line[8:39].rstrip() == label]
        require(len(rows) == 1, 'Native MD solvation field missing or ambiguous: '+label)
        return rows[0][39:].strip()
    method = {'gfnff':'GFN-FF', 'gfn1':'GFN1-xTB', 'gfn2':'GFN2-xTB'}.get(request['method'])
    parameter_set = 'internal '+str(method)+'/'+wanted['model'].upper()
    kernel = 'p16' if wanted['model'] == 'alpb' else 'still'
    require(markers[0][1].strip() == wanted['model'].upper() and field('Solvent') == wanted['solvent'], 'Native MD actual solvent/model differs')
    require(method is not None and field('Parameter file') == parameter_set, 'Native MD actual solvent parameter set differs')
    require(field('Interaction kernel') == ('P16' if kernel == 'p16' else 'Still') and field('Reference state') == 'gsolv [1 M gas/solution]', 'Native MD solvent kernel/reference state differs')
    temperature = field('Temperature').split()
    target = request['metadynamics' if request['operation'] == 'metadynamics' else 'molecularMD']['temperatureK']
    actual_temperature = float(temperature[0].replace('D','e').replace('d','e')) if len(temperature) == 2 else None
    require(len(temperature) == 2 and temperature[1] == 'K' and actual_temperature == float(format(target, '.4e')), 'Native MD solvation temperature differs')
    dielectric = float(field('Dielectric constant').replace('D','e').replace('d','e'))
    require(0 < dielectric < float('inf'), 'Native MD dielectric readback is invalid')
    if wanted['model'] == 'alpb' and native_alpb_supported(request['method'], request['operation'], wanted['solvent']):
        require(abs(dielectric-PRESETS[wanted['solvent']]['nativeDielectric'][request['method']]) <= .000051, 'Native MD ALPB dielectric does not match the method parameter set')
    return dict(model=wanted['model'], solvent=field('Solvent'), kernel=kernel, referenceState='gsolv', temperatureKelvin=actual_temperature,
                parameterSet=field('Parameter file'), dielectricConstant=dielectric, sourceField='stdout:solvation-model')
