import fs from 'node:fs';
import path from 'node:path';

/** All private paths are derived at runtime, independent of the source checkout. */
export function prepareStoragePaths({ userData }) {
  if (!path.isAbsolute(userData)) throw new Error('Application data location must be absolute');
  const paths = {
    data: userData,
    collections: path.join(userData, 'api-collections'),
    backup: path.join(path.dirname(userData), 'Argus Personal Backup Repository'),
  };
  for (const directory of [paths.data, paths.collections]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
  }
  return Object.freeze(paths);
}
