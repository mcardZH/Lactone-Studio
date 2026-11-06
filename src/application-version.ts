import applicationPackage from '../package.json';

/** package.json is the source of both the tool-compatible and visible versions.
 * Machine identity isolates profiles; display identity follows the approved
 * internal-test naming and must accompany every visible/exported ES version. */
const machineVersion = applicationPackage.version;
const displayVersion = applicationPackage.displayVersion || machineVersion;
const releaseChannel = applicationPackage.releaseChannel;
const development = releaseChannel === 'development';

export const applicationVersion = Object.freeze({
  machineVersion, displayVersion, releaseChannel, development,
  label: `v${displayVersion}${development ? ' · 开发版 · 仅内测' : ''}`,
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
