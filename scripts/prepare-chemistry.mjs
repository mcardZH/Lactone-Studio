import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const desktopPublicEntries = Object.freeze([
  'appearance-previews', 'structure-library', 'favicon.svg',
]);
// Ship only the current thirteen choices. Retired previews and their source
// history remain in the development checkout, outside both delivery objects.
export const desktopAppearancePreviewFiles = Object.freeze([
  'manifest.json',
  'structure-original.png', 'structure-gallery-pastel.png',
  'structure-gallery-cpk-glossy.png', 'structure-gallery-vmd-glossy.png',
  'surface-gallery-orbital.png', 'surface-gallery-density.png',
  'surface-gallery-esp.png', 'surface-gallery-iri.png',
  'surface-gallery-igmh.png', 'surface-gallery-dual.png',
  'surface-gallery-hirshfeld.png', 'vector-standard.png', 'vector-teal.png',
]);
export const twoDLicenseEntries = Object.freeze(['npm', 'upstream', 'README.md', 'RECEIPT.json', 'BUNDLE_REACHABILITY.json']);

async function copyTwoDLicenseMaterials(root, destination) {
  const source = join(root, 'licenses/2d-components');
  const receipt = JSON.parse(await readFile(join(source, 'RECEIPT.json'), 'utf8'));
  if (receipt.schema !== 1 || !Array.isArray(receipt.materials) || !receipt.materials.length)
    throw new Error('2D licence receipt is missing or invalid');
  for (const material of receipt.materials) {
    if (typeof material.file !== 'string' || !/^(npm|upstream)\//.test(material.file) || material.file.split('/').some(part => !part || part === '.' || part === '..'))
      throw new Error('2D licence material path is invalid');
    const bytes = await readFile(join(source, material.file));
    if (bytes.length !== material.bytes || createHash('sha256').update(bytes).digest('hex') !== material.sha256)
      throw new Error(`2D licence material does not match receipt: ${material.file}`);
  }
  // Keep upstream NOTICE verbatim: a project-written summary cannot replace it.
  for (const entry of twoDLicenseEntries) await copyTree(join(source, entry), join(destination, 'ketcher/licenses', entry));
  await copyTree(join(source, 'upstream/ketcher-v3.18.0/NOTICE'), join(destination, 'ketcher/NOTICE.txt'));
}
async function copyTree(source, destination) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Runtime asset must not be a link: ${source}`);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) await copyTree(join(source, entry), join(destination, entry));
  } else if (info.isFile()) {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  } else throw new Error(`Unsupported runtime asset: ${source}`);
}

/** Fresh, selected desktop assets: never mutate/copy historical public/chemistry. */
export async function prepareDesktopPublicAssets(root = resolve(import.meta.dirname, '..')) {
  const cache = join(root, '.cache');
  await mkdir(cache, { recursive: true });
  if ((await lstat(cache)).isSymbolicLink()) throw new Error('Runtime asset cache must not be a link');
  const destination = await mkdtemp(join(cache, 'desktop-public-'));
  for (const entry of desktopPublicEntries) {
    if (entry === 'appearance-previews') {
      for (const file of desktopAppearancePreviewFiles)
        await copyTree(join(root, 'public', entry, file), join(destination, entry, file));
    } else await copyTree(join(root, 'public', entry), join(destination, entry));
  }
  const chemistry = join(destination, 'chemistry');
  await copyTree(join(root, 'node_modules/3dmol/LICENSE'), join(chemistry, '3DMOL-LICENSE.txt'));
  // Ketcher code, styles and its one worker are bundled by Vite. No full vendor
  // tree, alternative WASM variant, macro editor or legacy Kekule is copied.
  await copyTree(join(root, 'node_modules/indigo-ketcher/LICENSE'), join(destination, 'ketcher/indigo-ketcher-LICENSE.txt'));
  await copyTwoDLicenseMaterials(root, destination);
  // Publish only a complete generation; failures leave the previous pointer intact.
  const pointer = join(cache, 'desktop-public.json'), pending = `${destination}.json`;
  await writeFile(pending, JSON.stringify({ schema: 1, directory: destination }, null, 2) + '\n', 'utf8');
  await rename(pending, pointer);
  console.log(`Prepared selected desktop assets: ${destination}`);
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await prepareDesktopPublicAssets();
