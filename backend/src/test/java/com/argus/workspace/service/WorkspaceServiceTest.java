package com.argus.workspace.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.argus.common.config.ArgusProperties;
import com.argus.common.process.LocalCommandRunner;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.workspace.repository.WorkspaceRepository;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class WorkspaceServiceTest {
  private Path temporary;

  @BeforeEach
  void temporaryDirectory() throws Exception {
    temporary =
        Files.createDirectories(
            Path.of("target", "test-sandboxes", java.util.UUID.randomUUID().toString()));
  }

  @Test
  void persistsRepositoriesAndActivationUsingTheExistingWorkspaceSchema() throws Exception {
    Path first = gitRepository("first");
    Path second = gitRepository("second");
    WorkspaceService service = service();
    var firstRepository = service.addRepository(first.toString());
    var secondRepository = service.addRepository(second.toString());
    service.activate(firstRepository.id());

    WorkspaceService reloaded = service();
    assertThat(reloaded.snapshot().repositories())
        .extracting("name")
        .containsExactly("first", "second");
    assertThat(reloaded.snapshot().activeRepositoryId()).isEqualTo(firstRepository.id());
    assertThat(secondRepository.path()).isEqualTo(second.toRealPath().toString());
  }

  @Test
  void javaStartupAndSnapshotDoNotInitializeTheNodeOwnedWorkspace() throws Exception {
    Path path = temporary.resolve("data/workspace.json");
    WorkspaceService service = service();
    assertThat(service.snapshot().repositories()).isEmpty();
    assertThat(Files.exists(path)).isFalse();
    Files.createDirectories(path.getParent());
    Files.writeString(
        path,
        """
        {"version":1,"activeRepositoryId":"node-repo","preferences":{"gitView":"history"},"repositories":[{"id":"node-repo","name":"Node repo","path":"/fixture","addedAt":"now","productionBranch":"main"}],"runConfigurations":[],"apiRequests":[],"javaProjectSettings":{}}
        """);
    assertThat(service.snapshot().activeRepositoryId()).isEqualTo("node-repo");
    assertThat(service.snapshot().preferences()).containsEntry("gitView", "history");
  }

  @Test
  void repeatedOnboardingPreservesExistingBranchIdentityAndTabGroups() throws Exception {
    Path first = gitRepository("first"), second = gitRepository("second");
    var service = service();
    var existing = service.onboardRepository(first.toString(), "release");
    var other = service.onboardRepository(second.toString(), "main");
    var group =
        service.createRepositoryTabGroup("Services", java.util.List.of(existing.id(), other.id()));
    var repeated = service.onboardRepository(first.toString(), "main");
    assertThat(repeated.id()).isEqualTo(existing.id());
    assertThat(repeated.productionBranch()).isEqualTo("release");
    assertThat(service.snapshot().repositories()).hasSize(2);
    assertThat(service.snapshot().preferences().get("repositoryTabGroups"))
        .isEqualTo(java.util.List.of(group));
    assertThat(service().requireRepository(existing.id()).productionBranch()).isEqualTo("release");
    assertThat(service().snapshot().preferences().get("repositoryTabGroups"))
        .isEqualTo(java.util.List.of(group));
  }

  private WorkspaceService service() {
    ArgusProperties properties =
        new ArgusProperties(temporary.resolve("data"), temporary, "test", "token");
    return new WorkspaceService(
        new WorkspaceRepository(new AtomicJsonStore(new ObjectMapper()), properties),
        new LocalCommandRunner());
  }

  @Test
  void runtimeStateUsesTheSameSavedConfigurationsAndExcludesUnrelatedPayloads() throws Exception {
    var service = service();
    var repo = service.addRepository(gitRepository("synced").toString());
    service.saveRunConfiguration(
        java.util.Map.of(
            "id", "run", "repositoryId", repo.id(), "executable", "npm", "port", 3000));
    var before = service.runtimeState();
    assertThat(before).containsOnlyKeys("repositories", "runConfigurations");
    service.updateRunConfiguration("run", java.util.Map.of("port", 3400));
    assertThat(service.runtimeState().get("runConfigurations"))
        .isEqualTo(service.snapshot().runConfigurations());
    assertThat(before.get("runConfigurations").toString()).contains("3000");
    service.disconnect(repo.id());
    assertThat(service.runtimeState().get("runConfigurations")).isEqualTo(java.util.List.of());
  }

  @Test
  void disconnectArchivesIdentityAndAllSettingsWithoutAutomaticallyReconnecting() throws Exception {
    var service = service();
    var first = service.onboardRepository(gitRepository("retained").toString(), "main");
    var other = service.addRepository(gitRepository("active").toString());
    service.saveRunConfiguration(
        java.util.Map.of(
            "id",
            "saved-run",
            "repositoryId",
            first.id(),
            "name",
            "Saved",
            "executable",
            "java",
            "args",
            java.util.List.of("Main")));
    var group =
        service.createRepositoryTabGroup("Keep group", java.util.List.of(first.id(), other.id()));
    var before =
        new ObjectMapper().readTree(Files.readString(temporary.resolve("data/workspace.json")));
    service.disconnect(first.id());
    var reloaded = service();
    assertThat(reloaded.snapshot().repositories()).extracting("id").containsExactly(other.id());
    assertThat(reloaded.snapshot().runConfigurations()).isEmpty();
    assertThat(reloaded.runConfiguration("saved-run")).containsEntry("repositoryId", first.id());
    assertThat(reloaded.snapshot().preferences().get("repositoryTabGroups"))
        .isEqualTo(java.util.List.of(group));
    var stored =
        new ObjectMapper().readTree(Files.readString(temporary.resolve("data/workspace.json")));
    assertThat(stored.get("disconnectedRepositories").get(0).get("id").asText())
        .isEqualTo(first.id());
    assertThat(stored.get("runConfigurations")).isEqualTo(before.get("runConfigurations"));
    assertThat(stored.get("preferences")).isEqualTo(before.get("preferences"));
    var explicit = reloaded.onboardRepository(first.path(), "different-branch");
    assertThat(explicit.id()).isEqualTo(first.id());
    assertThat(explicit.productionBranch()).isEqualTo(first.productionBranch());
    assertThat(reloaded.snapshot().runConfigurations()).hasSize(1);
    assertThat(reloaded.snapshot().preferences().get("repositoryTabGroups"))
        .isEqualTo(java.util.List.of(group));
  }

  @Test
  void persistsRunConfigurationLaunchProvenanceAcrossReloads() throws Exception {
    var service = service();
    var repository = service.addRepository(gitRepository("launch-provenance").toString());
    for (String source : java.util.List.of("detected", "custom")) {
      service.saveRunConfiguration(
          java.util.Map.of(
              "id",
              source,
              "repositoryId",
              repository.id(),
              "name",
              source,
              "executable",
              "./gradlew",
              "args",
              java.util.List.of(":bootRun"),
              "launchSource",
              source));
      assertThat(service().runConfiguration(source)).containsEntry("launchSource", source);
    }
  }

  @Test
  void preservesUnknownWorkspaceAndRepositoryFieldsAndNullablePreferences() throws Exception {
    Path file = temporary.resolve("data/workspace.json");
    Files.createDirectories(file.getParent());
    Files.writeString(
        file,
        """
      {"version":1,"activeRepositoryId":"r","preferences":{"nullable":null,"extra":{"nested":true}},"repositories":[{"id":"r","name":"Repository","path":"/fixture","addedAt":"now","productionBranch":"main","futureField":{"a":1}}],"runConfigurations":[],"apiRequests":[],"javaProjectSettings":{},"futureRoot":{"model":"custom","items":[1,2]}}
      """);
    var service = service();
    assertThat(service.snapshot().preferences()).containsEntry("nullable", null);
    service.preferences(java.util.Map.of("theme", "light"));
    var json = new ObjectMapper();
    var stored = json.readTree(Files.readString(file));
    assertThat(stored.get("futureRoot").get("model").asText()).isEqualTo("custom");
    assertThat(stored.get("repositories").get(0).get("futureField").get("a").asInt()).isEqualTo(1);
    assertThat(json.valueToTree(service.snapshot()).get("futureRoot").get("items").size())
        .isEqualTo(2);
  }

  private Path gitRepository(String name) throws Exception {
    Path path = Files.createDirectory(temporary.resolve(name));
    new ProcessBuilder("git", "init", "-q", path.toString()).start().waitFor();
    return path;
  }
}
