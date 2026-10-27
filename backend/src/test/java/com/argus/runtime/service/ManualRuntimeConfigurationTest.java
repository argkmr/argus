package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.common.error.NotFoundException;
import com.argus.common.security.KeychainSecretStore;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ManualRuntimeConfigurationTest {
  @TempDir Path root;
  private WorkspaceService workspace;
  private LocalEnvironmentService local;
  private RuntimeConfigurationService service;

  @BeforeEach
  void setup() {
    workspace = mock(WorkspaceService.class);
    local = mock(LocalEnvironmentService.class);
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Custom app", root.toString(), "now"));
    when(workspace.runConfiguration(anyString())).thenThrow(new NotFoundException("not found"));
    when(workspace.saveRunConfiguration(anyMap())).thenAnswer(call -> copyMap(call.getArgument(0)));
    service =
        new RuntimeConfigurationService(
            workspace,
            new RuntimeDetector(null),
            null,
            local,
            new ApplicationConfigService(),
            mock(KeychainSecretStore.class),
            null,
            null);
  }

  @Test
  void unknownProjectGetsEditableTemplateAndCanSaveAnExplicitCommand() {
    assertThat(service.template("repo", ""))
        .containsEntry("detected", false)
        .containsEntry("executable", "")
        .containsEntry("args", List.of())
        .containsEntry("cwd", ".")
        .containsEntry("name", "Custom app")
        .containsKey("detectionWarning");
    var saved =
        service.save(
            object(
                "repositoryId",
                "repo",
                "executable",
                "go",
                "args",
                List.of("run", "."),
                "port",
                9000));
    assertThat(saved)
        .containsEntry("launchSource", "custom")
        .containsEntry("args", List.of("run", "."));
    assertThat(service.resolve(workspace.requireRepository("repo"), saved))
        .containsEntry("executable", "go");
  }

  @Test
  void manualConfigurationPreservesExistingEnvironmentAndAcceptsTheSetupFormFields() {
    var saved =
        object(
            "id",
            "saved",
            "repositoryId",
            "repo",
            "name",
            "Saved app",
            "executable",
            "go",
            "args",
            List.of("run", "."),
            "env",
            Map.of("KEEP", "value"),
            "secretKeys",
            List.of("TOKEN"),
            "environmentKeys",
            List.of("OLD"),
            "environmentFile",
            "private.env");
    doReturn(saved).when(workspace).runConfiguration("saved");
    var update =
        object(
            "id",
            "saved",
            "repositoryId",
            "repo",
            "executable",
            "go",
            "args",
            List.of("run", "./cmd/server"));
    assertThat(service.save(update))
        .containsEntry("env", Map.of("KEEP", "value"))
        .containsEntry("secretKeys", List.of("TOKEN"))
        .containsEntry("environmentFile", "private.env");
    when(local.write("saved", "PORT=9123", "dotenv"))
        .thenReturn(object("keys", List.of("PORT"), "format", "dotenv", "updatedAt", "now"));
    update.put("environmentInput", "PORT=9123");
    assertThat(service.save(update))
        .containsEntry("environmentKeys", List.of("PORT"))
        .containsEntry("environmentFormat", "dotenv");
    verify(local).write("saved", "PORT=9123", "dotenv");
  }

  @Test
  void malformedManualConfigurationIsRejectedBeforeAnyEnvironmentWrite() {
    for (var invalid :
        List.of(
            object("executable", ""),
            object("args", "run server"),
            object("args", List.of(12)),
            object("cwd", "../outside"),
            object("port", 70000))) {
      var request =
          object(
              "repositoryId",
              "repo",
              "executable",
              "go",
              "args",
              List.of("run", "."),
              "environmentInput",
              "PRIVATE=value");
      request.putAll(invalid);
      assertThatThrownBy(() -> service.save(request)).isInstanceOf(IllegalArgumentException.class);
    }
    verifyNoInteractions(local);
    verify(workspace, never()).saveRunConfiguration(anyMap());
  }

  @Test
  void templateCannotExposeAnotherRepositoryConfiguration() {
    doReturn(object("id", "foreign", "repositoryId", "other", "executable", "go"))
        .when(workspace)
        .runConfiguration("foreign");
    assertThatThrownBy(() -> service.template("repo", "foreign"))
        .hasMessageContaining("does not belong");
  }
}
