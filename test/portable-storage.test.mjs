import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareStoragePaths } from '../desktop/storage-paths.mjs';
import { normalizeBackupRepositoryUrl } from '../public/backup-form.js';
test('fresh installation creates private writable directories without a source checkout or Documents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'argus-storage-test-'));
  const userData = path.join(root, 'Different User', 'Application Support', 'Argus Personal');
  const paths = prepareStoragePaths({ userData });
  for (const directory of [paths.data, paths.collections]) {
    assert.equal((await fs.stat(directory)).isDirectory(), true);
    assert.equal(directory.startsWith(userData), true);
  }
  assert.deepEqual(prepareStoragePaths({userData}), paths);
  await fs.rm(root, { recursive: true });
});
test('standard Git remotes remain provider independent', () => {
  for (const url of ['git@github.com:me/argus.git', 'https://gitlab.com/team/group/argus.git', 'git@bitbucket.org:team/argus.git',
    'git@ssh.dev.azure.com:v3/org/project/argus', 'https://org@dev.azure.com/org/My%20Project/_git/argus'])
    assert.equal(normalizeBackupRepositoryUrl(url), url);
  for (const url of ['https://token:secret@dev.azure.com/org/repo', 'https://git.example/team/%2e%2e/repo'])
    assert.throws(() => normalizeBackupRepositoryUrl(url));
});
