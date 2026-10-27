package com.argus.runtime.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.workspace.domain.Repository;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ProcessPortOwnershipTest {
  @TempDir Path directory;

  @Test
  void exposesOnlyLiveOwnedProcessIdentitiesAndNoLaunchSecrets() {
    var processes = new ProcessManager();
    try {
      var configuration =
          RuntimeData.object(
              "id",
              "config",
              "name",
              "fixture",
              "executable",
              "/bin/sleep",
              "args",
              List.of("20"),
              "cwd",
              ".");
      var repository = new Repository("repo", "fixture", directory.toString(), "now", "main");
      var work = processes.start(configuration, repository, Map.of("PRIVATE_VALUE", "secret"));
      var roots = processes.ownedProcessRoots();
      assertThat(roots).hasSize(1);
      assertThat(roots.get(0).configurationId()).isEqualTo("config");
      assertThat(roots.get(0).repositoryId()).isEqualTo("repo");
      assertThat(roots.get(0).running()).isTrue();
      assertThat(roots.get(0).handle().isAlive()).isTrue();
      processes.stop(RuntimeData.text(work, "id"));
      assertThat(processes.ownedProcessRoots()).isEmpty();
    } finally {
      processes.stopAll();
    }
  }
}
