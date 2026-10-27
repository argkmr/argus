package com.argus.onboarding.service;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;

import com.argus.background.service.BackgroundJobService;
import com.argus.common.config.ArgusProperties;
import com.argus.common.process.LocalCommandRunner;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.workspace.controller.NativeWorkspaceController;
import com.argus.workspace.repository.WorkspaceRepository;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class RepositoryOnboardingDiscoveryTest {
  @TempDir Path root;
  private final LocalCommandRunner commands = new LocalCommandRunner();

  private void git(String... args) {
    commands.run("git", List.of(args), null, Duration.ofSeconds(10));
  }

  @Test
  void brokenAndEmptySiblingRowsDoNotHideValidReposAndSavedBranchIsRestored() throws Exception {
    Path valid = root.resolve("valid"),
        empty = root.resolve("empty"),
        broken = Files.createDirectory(root.resolve("broken"));
    git("init", "-q", "-b", "main", valid.toString());
    git(
        "-C",
        valid.toString(),
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--allow-empty",
        "-qm",
        "fixture");
    git("-C", valid.toString(), "branch", "release");
    git("init", "-q", "-b", "main", empty.toString());
    Files.writeString(broken.resolve(".git"), "gitdir: ../missing-metadata/worktrees/broken\n");
    var properties = new ArgusProperties(root.resolve("data"), root, "test", "");
    var json = new AtomicJsonStore(new ObjectMapper());
    var workspace = new WorkspaceService(new WorkspaceRepository(json, properties), commands);
    var connected = workspace.onboardRepository(valid.toString(), "release");
    var controller =
        new NativeWorkspaceController(
            workspace,
            new RepositoryDiscoveryService(commands),
            commands,
            new BackgroundJobService(json, properties),
            null);
    var result =
        list(controller.discover(Map.of("path", root.toString())).get("repositories")).stream()
            .map(item -> map(item))
            .toList();
    assertThat(result).hasSize(3);
    var validRow =
        result.stream().filter(row -> "valid".equals(row.get("name"))).findFirst().orElseThrow();
    assertThat(validRow)
        .containsEntry("eligible", true)
        .containsEntry("connected", true)
        .containsEntry("repositoryId", connected.id())
        .containsEntry("productionBranch", "release")
        .containsEntry("savedProductionBranch", "release");
    var emptyRow =
        result.stream().filter(row -> "empty".equals(row.get("name"))).findFirst().orElseThrow();
    assertThat(emptyRow).containsEntry("eligible", false);
    assertThat(text(emptyRow, "error")).contains("first commit");
    var brokenRow =
        result.stream().filter(row -> "broken".equals(row.get("name"))).findFirst().orElseThrow();
    assertThat(brokenRow).containsEntry("eligible", false);
    assertThat(text(brokenRow, "error")).contains("Git/worktree metadata");
    assertThat(Files.readString(broken.resolve(".git"))).contains("missing-metadata");
    assertThat(workspace.snapshot().repositories()).hasSize(1);
  }
}
