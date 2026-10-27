import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBackupRepositoryUrl } from "../public/backup-form.js";

test("backup URL parser accepts clone transports and only normalizes explicit Bitbucket browser paths", () => {
  for (const value of ["git@bitbucket.org:personal/private-backup.git", "https://bitbucket.org/personal/private-backup.git", "ssh://git@bitbucket.org/personal/private-backup.git", "ssh://git@git.example.com:2222/team/backup.git", "git@example.com:backup.git", "https://git.example.com/team/backup.git"])
    assert.equal(normalizeBackupRepositoryUrl(value), value);
  assert.equal(normalizeBackupRepositoryUrl("https://bitbucket.org/personal/private-backup/src/main/"), "https://bitbucket.org/personal/private-backup.git");
  assert.equal(normalizeBackupRepositoryUrl("git clone git@bitbucket.org:personal/private-backup.git"), "git@bitbucket.org:personal/private-backup.git");
  assert.equal(normalizeBackupRepositoryUrl('git clone "https://bitbucket.org/personal/private-backup/src/main/"'), "https://bitbucket.org/personal/private-backup.git");
  const otherHost = "https://bitbucket.org.example.com/team/backup/src/main/";
  assert.equal(normalizeBackupRepositoryUrl(otherHost), otherHost, "a lookalike host is never rewritten to Bitbucket");
});

test("backup URL parser rejects credentials, commands, malformed targets and ambiguous browser links", () => {
  for (const value of ["", "https://user:password@bitbucket.org/team/backup", "https://user@bitbucket.org/team/backup", "ssh://git:password@bitbucket.org/team/backup", "git clone --mirror git@bitbucket.org:team/backup", "git clone git@bitbucket.org:team/backup local-folder", "git@bitbucket.org:team/backup;echo-bad", "git@bitbucket.org:team/$(whoami)", "git@bitbucket.org:team/backup\ngit-status", "https://bitbucket.org/team/../backup", "https://bitbucket.org/team/%2e%2e/backup", "https://bitbucket.org/team/backup?secret=x", "https://bitbucket.org/team/backup#main", "https://bitbucket.org/team/backup/src/main/file.txt", "https://bitbucket.org:444/team/backup/src/main", "file:///private/tmp/backup", "https://bitbucket.org:0/team/backup", "https://bad..host/team/backup", "https://bitbucket%2eorg/team/backup", "git@bitbucket.org:team/backup/src/main", "https://bitbucket.org/-/..", "https://bitbucket.org/team//backup"])
    assert.throws(() => normalizeBackupRepositoryUrl(value), { message: /valid HTTPS or SSH/ }, value);
});
