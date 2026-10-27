package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.common.security.KeychainSecretStore;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class RuntimeEntryPointConfigurationTest {
  @TempDir Path directory;

  private RuntimeConfigurationService service() {
    var local = mock(LocalEnvironmentService.class);
    when(local.resolve("saved")).thenReturn(Map.of("SERVER_PORT", "9191", "KEPT", "fixture"));
    var workspace = mock(WorkspaceService.class);
    when(workspace.runConfiguration("saved"))
        .thenReturn(
            object("id", "saved", "env", Map.of("LEGACY", "present", "SERVER_PORT", "8080")));
    var secrets = mock(KeychainSecretStore.class);
    when(secrets.getLocal("saved", "__environment_bundle__")).thenReturn("");
    return new RuntimeConfigurationService(
        workspace,
        new RuntimeDetector(null),
        null,
        local,
        new ApplicationConfigService(),
        secrets,
        null,
        null);
  }

  private Repository repository() {
    return new Repository("repo", "Fixture", directory.toString(), "now");
  }

  private void app(String module, String name) throws Exception {
    Path source = directory.resolve(module).resolve("src/main/java/example/" + name + ".java");
    Files.createDirectories(source.getParent());
    Files.writeString(
        source,
        "package example; @SpringBootApplication public class "
            + name
            + " { public static void main(String[] args) { SpringApplication.run("
            + name
            + ".class,args); }}");
    Files.writeString(directory.resolve("gradlew"), "fixture");
  }

  @Test
  void repairsPreviouslyGuessedModuleUsingRealEntryWithoutLosingSavedSettings() throws Exception {
    app("", "Application");
    var saved =
        object(
            "id",
            "saved",
            "repositoryId",
            "repo",
            "executable",
            "./gradlew",
            "args",
            List.of(":web-service:bootRun"),
            "cwd",
            ".",
            "name",
            "Saved app",
            "port",
            8082,
            "managementPort",
            10105,
            "env",
            Map.of("MODE", "kept"));
    saved.put("launchSource", "detected");
    var resolved = service().resolve(repository(), saved);
    assertThat(resolved)
        .containsEntry("id", "saved")
        .containsEntry("name", "Saved app")
        .containsEntry("args", List.of(":bootRun"))
        .containsEntry("mainClass", "example.Application")
        .containsEntry("port", 9191)
        .containsEntry("managementPort", 10105)
        .containsEntry("env", Map.of("MODE", "kept"));
    assertThat(saved).containsEntry("args", List.of(":web-service:bootRun"));
  }

  @Test
  void explicitSavedCommandAndArgumentsRemainAuthoritative() throws Exception {
    app("", "Application");
    var saved =
        object(
            "id",
            "saved",
            "repositoryId",
            "repo",
            "executable",
            "./gradlew",
            "args",
            List.of(":custom:bootRun", "--args=--spring.profiles.active=local"),
            "cwd",
            ".");
    assertThat(service().resolve(repository(), saved)).containsEntry("args", saved.get("args"));
  }

  @Test
  void unmarkedOneArgumentAndCustomWorkingDirectoryAreNotTreatedAsGenerated() throws Exception {
    app("", "Application");
    for (String cwd : List.of(".", "service")) {
      var saved =
          object(
              "id",
              "saved",
              "repositoryId",
              "repo",
              "executable",
              "./gradlew",
              "args",
              List.of(":custom:bootRun"),
              "cwd",
              cwd);
      var result = service().resolve(repository(), saved);
      assertThat(result)
          .containsEntry("args", saved.get("args"))
          .containsEntry("cwd", cwd)
          .containsKey("detectionWarning")
          .containsKey("detectedEntryPoint")
          .doesNotContainKeys("mainClass", "entryPointFile", "modulePath");
    }
  }

  @Test
  void legacyGeneratedYamlCommandCanBeRepairedButExplicitMarkerAlwaysWins() throws Exception {
    app("", "Application");
    var legacy =
        object(
            "id",
            "saved",
            "repositoryId",
            "repo",
            "executable",
            "./gradlew",
            "args",
            List.of(":web-service:bootRun"),
            "cwd",
            ".",
            "environmentFile",
            ".argus-data/environments/saved.env",
            "env",
            Map.of(),
            "secretKeys",
            List.of(),
            "configFile",
            "web-service/src/main/resources/application.yml");
    assertThat(service().resolve(repository(), legacy))
        .containsEntry("args", List.of(":bootRun"))
        .containsEntry("launchSource", "detected");
    legacy.put("launchSource", "custom");
    assertThat(service().resolve(repository(), legacy))
        .containsEntry("args", legacy.get("args"))
        .containsEntry("launchSource", "custom");
  }

  @Test
  void mappedGradleModulesPreserveEvenSimpleExplicitCommandsAndReportUnknownDiscovery()
      throws Exception {
    app("services/api", "Application");
    Files.writeString(
        directory.resolve("settings.gradle"),
        "include ':api'\nproject(':api').projectDir = file('services/api')\n");
    var saved =
        object(
            "id",
            "saved",
            "repositoryId",
            "repo",
            "executable",
            "./gradlew",
            "args",
            List.of(":api:bootRun"),
            "cwd",
            ".");
    var result = service().resolve(repository(), saved);
    assertThat(result)
        .containsEntry("args", List.of(":api:bootRun"))
        .containsEntry("cwd", ".")
        .hasEntrySatisfying(
            "detectionWarning",
            value -> assertThat(value.toString()).contains("custom project directories"));
    assertThatThrownBy(() -> service().resolve(repository(), null))
        .hasMessageContaining("will not guess task paths");
  }

  @Test
  void simpleSetupStoresDetectedProvenanceButKeepsExistingCustomSelection() throws Exception {
    app("", "Application");
    var workspace = mock(WorkspaceService.class);
    when(workspace.requireRepository("repo")).thenReturn(repository());
    when(workspace.runConfiguration(anyString()))
        .thenThrow(new com.argus.common.error.NotFoundException("not found"));
    when(workspace.saveRunConfiguration(anyMap())).thenAnswer(call -> copyMap(call.getArgument(0)));
    var local = mock(LocalEnvironmentService.class);
    when(local.resolve(anyString())).thenReturn(Map.of());
    var selected =
        new RuntimeConfigurationService(
            workspace,
            new RuntimeDetector(null),
            null,
            local,
            new ApplicationConfigService(),
            null,
            null,
            null);
    assertThat(selected.save(object("simpleSetup", true, "repositoryId", "repo")))
        .containsEntry("launchSource", "detected");
    var custom =
        object(
            "id",
            "saved",
            "repositoryId",
            "repo",
            "executable",
            "./gradlew",
            "args",
            List.of(":custom:bootRun"),
            "cwd",
            ".",
            "launchSource",
            "custom");
    doReturn(custom).when(workspace).runConfiguration("saved");
    assertThat(selected.save(object("simpleSetup", true, "repositoryId", "repo", "id", "saved")))
        .containsEntry("launchSource", "custom")
        .containsEntry("args", List.of(":custom:bootRun"));
    custom.put("env", Map.of("KEEP", "value"));
    assertThat(
            selected.save(
                object(
                    "simpleSetup",
                    true,
                    "repositoryId",
                    "repo",
                    "id",
                    "saved",
                    "launchSource",
                    "detected")))
        .containsEntry("launchSource", "detected")
        .containsEntry("args", List.of(":bootRun"))
        .containsEntry("cwd", ".")
        .containsEntry("env", Map.of("KEEP", "value"));
    assertThat(
            selected.save(
                object(
                    "repositoryId",
                    "repo",
                    "executable",
                    "./gradlew",
                    "args",
                    List.of("bootRun"),
                    "launchSource",
                    "detected")))
        .containsEntry("launchSource", "custom");
  }

  @Test
  void ambiguousDiscoveryKeepsExplicitSavedSelectionAndExplainsIt() throws Exception {
    app("one", "One");
    app("two", "Two");
    var saved =
        object(
            "id",
            "saved",
            "repositoryId",
            "repo",
            "executable",
            "./gradlew",
            "args",
            List.of(":one:bootRun"),
            "cwd",
            ".");
    assertThat(service().resolve(repository(), saved))
        .containsEntry("args", saved.get("args"))
        .hasEntrySatisfying(
            "detectionWarning",
            warning ->
                assertThat(warning.toString()).contains("Multiple application entry points"));
    assertThat(service().maintenanceEnvironment("saved"))
        .containsEntry("KEPT", "fixture")
        .containsEntry("LEGACY", "present")
        .containsEntry("SERVER_PORT", "9191");
  }
}
