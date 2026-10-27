package com.argus.backup.service;

import static org.assertj.core.api.Assertions.*;

import java.util.List;
import org.junit.jupiter.api.Test;

class BackupRepositoryUrlTest {
  @Test
  void explicitBrowserLinksAndCopiedCloneCommandsNormalizeWithoutChoosingAnAccount() {
    for (String value :
        List.of(
            "git@bitbucket.org:personal/private-backup.git",
            "https://bitbucket.org/personal/private-backup.git",
            "ssh://git@bitbucket.org/personal/private-backup.git",
            "ssh://git@git.example.com:2222/team/backup.git",
            "git@example.com:backup.git",
            "https://git.example.com/team/backup.git"))
      assertThat(BackupRepositoryUrl.normalize(value)).isEqualTo(value);
    assertThat(
            BackupRepositoryUrl.normalize(
                "https://bitbucket.org/personal/private-backup/src/main/"))
        .isEqualTo("https://bitbucket.org/personal/private-backup.git");
    assertThat(
            BackupRepositoryUrl.normalize(
                "git clone git@bitbucket.org:personal/private-backup.git"))
        .isEqualTo("git@bitbucket.org:personal/private-backup.git");
    assertThat(
            BackupRepositoryUrl.normalize(
                "git clone \"https://bitbucket.org/personal/private-backup/src/main/\""))
        .isEqualTo("https://bitbucket.org/personal/private-backup.git");
    String otherHost = "https://bitbucket.org.example.com/team/backup/src/main/";
    assertThat(BackupRepositoryUrl.normalize(otherHost)).isEqualTo(otherHost);
  }

  @Test
  void credentialCommandPathAndHostileEncodingCasesFailBeforeAnyGitInvocation() {
    for (String value :
        List.of(
            "",
            "https://user:password@bitbucket.org/team/backup",
            "ssh://git:password@bitbucket.org/team/backup",
            "git clone --mirror git@bitbucket.org:team/backup",
            "git clone git@bitbucket.org:team/backup local-folder",
            "git@bitbucket.org:team/backup;echo-bad",
            "git@bitbucket.org:team/$(whoami)",
            "git@bitbucket.org:team/backup\ngit-status",
            "https://bitbucket.org/team/../backup",
            "https://bitbucket.org/team/%2e%2e/backup",
            "https://bitbucket.org/team/backup?secret=x",
            "https://bitbucket.org/team/backup#main",
            "https://bitbucket.org/team/backup/src/main/file.txt",
            "https://bitbucket.org:444/team/backup/src/main",
            "file:///private/tmp/backup",
            "https://bitbucket.org:0/team/backup",
            "https://bad..host/team/backup",
            "https://bitbucket%2eorg/team/backup",
            "git@bitbucket.org:team/backup/src/main",
            "https://bitbucket.org/-/..",
            "https://bitbucket.org/team//backup"))
      assertThatThrownBy(() -> BackupRepositoryUrl.normalize(value))
          .as(value)
          .isInstanceOf(IllegalArgumentException.class);
  }
}
