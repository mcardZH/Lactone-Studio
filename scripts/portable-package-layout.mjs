import assert from 'node:assert/strict';
import { join } from 'node:path';
import layoutModule from '../desktop/portable-layout.cjs';
const { layoutDescriptor } = layoutModule;

export function packageLayout(layoutVersion = 1, productVersion, compatibleHost) {
  assert([1, 2].includes(layoutVersion), 'Unknown portable layout version');
  const compact = layoutVersion === 2;
  const host = productVersion ? layoutDescriptor(productVersion, compatibleHost).host : 'sciyue-host.exe';
  function member(name) {
    assert(typeof name === 'string' && name && !name.startsWith('/') && !name.split('/').includes('..'));
    if (!compact) return name;
    if (name === 'sciyue.exe') return 'runtime/' + host;
    if (name === 'LICENSE') return 'licenses/electron/LICENSE';
    if (name === 'LICENSES.chromium.html') return 'licenses/chromium/LICENSES.chromium.html';
    if (name === 'PORTABLE-README.txt') return 'README.txt';
    if (name === 'VERSION.txt') return 'runtime/provenance/VERSION.txt';
    if (name.startsWith('licenses/') || name.startsWith('examples/') || name === 'CITATION.txt') return name;
    return 'runtime/' + name;
  }
  function original(name) {
    if (!compact) return name;
    if (name === 'runtime/' + host) return 'sciyue.exe';
    if (name === 'licenses/electron/LICENSE') return 'LICENSE';
    if (name === 'licenses/chromium/LICENSES.chromium.html') return 'LICENSES.chromium.html';
    if (name === 'README.txt') return 'PORTABLE-README.txt';
    if (name === 'runtime/provenance/VERSION.txt') return 'VERSION.txt';
    return name.startsWith('runtime/') ? name.slice(8) : name;
  }
  return Object.freeze({ layoutVersion, compact, member, original,
    statePrefix: compact ? 'runtime/state/' : '',
    receiptPath: compact ? 'runtime/provenance/delivery-receipt.json' : 'delivery-receipt.json',
    labelPath: compact ? 'runtime/provenance/OPENBLAS-EXPERIMENTAL.txt' : 'OPENBLAS-EXPERIMENTAL.txt',
    markerPath: compact ? 'runtime/portable-layout.json' : null,
    descriptor: version => compact ? layoutDescriptor(version, compatibleHost) : null,
    hostExecutable: output => join(output, member('sciyue.exe')),
    manifestFields: (version, output) => compact ? { portableLayout: layoutDescriptor(version, compatibleHost), hostExecutable: join(output, member('sciyue.exe')) } : {},
  });
}
export function manifestLayout(manifest) {
  const layout = packageLayout(manifest.portableLayout?.layoutVersion ?? 1, manifest.version, manifest.portableLayout?.host);
  if (layout.compact) {
    assert.deepEqual(manifest.portableLayout, layout.descriptor(manifest.version));
    assert.equal(manifest.hostExecutable, layout.hostExecutable(manifest.output));
  } else assert.equal(manifest.hostExecutable, undefined, 'Legacy layout cannot declare a compact host');
  return layout;
}
