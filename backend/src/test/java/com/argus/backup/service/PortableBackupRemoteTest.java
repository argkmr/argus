package com.argus.backup.service;

import static org.assertj.core.api.Assertions.*;

import java.util.List;
import org.junit.jupiter.api.Test;

class PortableBackupRemoteTest {
  @Test
  void acceptsStandardCloneAddressesAcrossGitHosts() {
    for (String remote :
        List.of(
            "git@github.com:me/argus.git",
            "https://gitlab.com/team/subgroup/argus.git",
            "git@bitbucket.org:team/argus.git",
            "git@ssh.dev.azure.com:v3/org/project/argus",
            "https://org@dev.azure.com/org/My%20Project/_git/argus",
            "ssh://git@git.internal:2222/argus.git"))
      assertThat(BackupRepositoryUrl.normalize(remote)).isEqualTo(remote);
  }
}
