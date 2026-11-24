"""Compile the optional finite empirical accelerator against the frozen Python ABI."""
from pathlib import Path
import os
import subprocess

import common


SOURCE = 'desktop/chemistry/finite_empirical_accel.c'
NAME = '_finite_empirical_accel.pyd'
DIRECTORY = 'native-extensions'
COMPILER_ENV = 'SCIYUE_FINITE_ACCEL_GCC'
SDK_ENV = 'SCIYUE_FINITE_ACCEL_PYTHON_SDK'


def build_extension(config, run):
    compiler_input = os.environ.get(COMPILER_ENV)
    sdk_input = os.environ.get(SDK_ENV)
    if compiler_input is None and sdk_input is None:
        return None
    common.require(compiler_input and sdk_input, 'Configure both finite accelerator compiler and Python SDK')
    compiler, sdk = Path(compiler_input), Path(sdk_input)
    common.require(compiler.is_absolute() and sdk.is_absolute(), 'Finite accelerator build inputs must be absolute')
    common.require(config['toolchainLock']['pythonVersion'].startswith('3.12.'), 'Finite accelerator requires the Python 3.12 SDK')
    include = common.safe(sdk, sdk / 'include')
    python_dll = config['toolchainLockRoot'] / 'python/python312.dll'
    common.require(include.is_dir() and (include / 'Python.h').is_file()
                   and common.digest(common.safe(sdk, sdk / python_dll.name)) == common.digest(python_dll),
                   'Finite accelerator SDK does not match the frozen interpreter')
    source = common.ROOT / SOURCE
    output = common.safe(run, run / DIRECTORY / NAME)
    output.parent.mkdir()
    command = [str(compiler), '-O3', '-ffp-contract=off', '-shared', '-static-libgcc',
               '-I', str(include), str(source), str(python_dll), '-o', str(output)]
    environment = dict(os.environ, TEMP=str(run / 'temp'), TMP=str(run / 'temp'))
    compiler_identity = common.identity(compiler, compiler.parent)
    headers = common.inventory(include)
    source_identity = common.identity(source)
    python_identity = common.identity(python_dll, config['toolchainLockRoot'])
    result = subprocess.run(command, cwd=run, env=environment, capture_output=True, check=False)
    (output.parent / 'compiler.stdout.log').write_bytes(result.stdout)
    (output.parent / 'compiler.stderr.log').write_bytes(result.stderr)
    common.require(result.returncode == 0 and output.is_file(), 'Finite accelerator compilation failed')
    common.require(compiler_identity == common.identity(compiler, compiler.parent)
                   and headers == common.inventory(include) and source_identity == common.identity(source)
                   and python_identity == common.identity(python_dll, config['toolchainLockRoot']),
                   'Finite accelerator build inputs changed')
    receipt = {'command': command, 'compiler': compiler_identity, 'headers': headers, 'python': python_identity,
               'source': source_identity, 'extension': common.identity(output), 'returnCode': result.returncode}
    common.write_new(output.parent / 'receipt.json', receipt)
    return output, receipt
