import applicationPackage from '../package.json';

/** package.json is the source of both the tool-compatible and visible versions.
 * Machine identity isolates profiles; display identity follows the approved
 * internal-test naming and must accompany every visible/exported ES version. */
const machineVersion = applicationPackage.version;
const displayVersion = applicationPackage.displayVersion || machineVersion;
const releaseChannel = applicationPackage.releaseChannel;
const development = releaseChannel === 'development';
const productName = applicationPackage.productName || 'Lactone Studio';

export const modificationNotice = Object.freeze({
  unofficialModification: true as const,
  unofficialLabel: applicationPackage.modificationNotice?.unofficialLabel || '非官方修改版',
  productName,
  shortName: applicationPackage.modificationNotice?.shortName || 'LS',
  modifiedVersion: applicationPackage.modificationNotice?.modifiedVersion || `${displayVersion}-lactone.1`,
  modifier: applicationPackage.modificationNotice?.modifier || 'mcardZH',
  sourceRepository: applicationPackage.modificationNotice?.sourceRepository || 'https://github.com/mcardZH/Lactone-Studio',
  upstreamName: applicationPackage.modificationNotice?.upstreamName || 'Ester Studio (ES)',
  upstreamVersion: applicationPackage.modificationNotice?.upstreamVersion || displayVersion,
  upstreamAuthor: applicationPackage.modificationNotice?.upstreamAuthor || 'Zixuan Zhang',
  upstreamRepository: applicationPackage.modificationNotice?.upstreamRepository || 'https://github.com/Ahey1/Ester-Studio',
});

export const applicationVersion = Object.freeze({
  productName,
  shortName: modificationNotice.shortName,
  machineVersion,
  displayVersion,
  releaseChannel,
  development,
  label: `v${displayVersion}${development ? ' · 开发版 · 仅内测' : ''}`,
  modificationNotice,
});

/** Historical/project-supplied version identities remain historical. */
export function displayApplicationVersion(version: string): string {
  return version === machineVersion ? displayVersion : version;
}

export function applicationVersionNote(version: string): string | undefined {
  return development && (version === machineVersion || version === displayVersion)
    ? `开发版；仅内测。machineVersion=${machineVersion}; displayVersion=${displayVersion}; releaseChannel=${releaseChannel}`
    : undefined;
}
