package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.common.process.CommandResult;
import com.argus.workspace.domain.Repository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class PythonProjectRuntimeTest {
  @TempDir Path root;

  private Repository repository() {
    return new Repository("repo", "Python fixture", root.toString(), "now");
  }

  private ProjectStructureService structures() {
    return new ProjectStructureService(
        null, null, (executable, args, cwd, timeout) -> new CommandResult("fixture", "", 0));
  }

  @Test
  void localEnvironmentIsUsedByRunSyncTestsAndLaunchEnvironment() throws Exception {
    Files.writeString(root.resolve("main.py"), "# fixture");
    Files.writeString(root.resolve("requirements.txt"), "pytest\n");
    Path python = root.resolve(".venv/bin/python3");
    Files.createDirectories(python.getParent());
    Files.writeString(python, "fixture, never executed");
    python.toFile().setExecutable(true);
    var service = structures();
    assertThat(service.maintenance(repository(), "sync"))
        .containsEntry("executable", python.toString())
        .containsEntry("args", List.of("-m", "pip", "install", "-r", "requirements.txt"));
    assertThat(service.maintenance(repository(), "test"))
        .containsEntry("executable", python.toString())
        .containsEntry("args", List.of("-m", "pytest"));
    assertThat(new RuntimeDetector(null).detect(root, "Fixture"))
        .containsEntry("executable", python.toString())
        .containsEntry("port", null);
    var runtime =
        new RuntimeConfigurationService(null, null, null, null, null, null, null, null)
            .projectRuntime(
                repository(), object("executable", "python3", "args", List.of("main.py")));
    assertThat(map(runtime.get("configuration"))).containsEntry("executable", python.toString());
    assertThat(map(runtime.get("environment")))
        .containsEntry("VIRTUAL_ENV", root.resolve(".venv").toString());
    var explicit =
        new RuntimeConfigurationService(null, null, null, null, null, null, null, null)
            .projectRuntime(
                repository(), object("executable", "./custom/python", "args", List.of("main.py")));
    assertThat(map(explicit.get("configuration"))).containsEntry("executable", "./custom/python");
    assertThat(map(explicit.get("environment"))).isEmpty();
  }

  @Test
  void eachManagerRunsTestsAndApplicationsInItsOwnEnvironment() throws Exception {
    Files.writeString(root.resolve("main.py"), "# fixture");
    Files.createDirectories(root.resolve("tests"));
    for (String[] manager :
        new String[][] {{"uv.lock", "uv"}, {"poetry.lock", "poetry"}, {"Pipfile", "pipenv"}}) {
      Path lock = root.resolve(manager[0]);
      Files.writeString(lock, "");
      assertThat(structures().maintenance(repository(), "sync"))
          .containsEntry("executable", manager[1])
          .containsEntry("args", List.of(manager[1].equals("uv") ? "sync" : "install"));
      assertThat(structures().maintenance(repository(), "test"))
          .containsEntry("executable", manager[1])
          .containsEntry("args", List.of("run", "python", "-m", "pytest"));
      assertThat(new RuntimeDetector(null).detect(root, "Fixture"))
          .containsEntry("executable", manager[1])
          .containsEntry("args", List.of("run", "python", "main.py"));
      Files.delete(lock);
    }
  }

  @Test
  void freshPipSyncPlansALocalEnvironmentWithoutCreatingOrInstallingAnything() throws Exception {
    Files.writeString(root.resolve("requirements.txt"), "pytest\n");
    var command = structures().maintenance(repository(), "sync");
    assertThat(command).containsEntry("executable", "python3");
    assertThat(strings(command.get("args")))
        .startsWith("-c")
        .endsWith("-m", "pip", "install", "-r", "requirements.txt");
    assertThat(strings(command.get("args")).get(1))
        .contains("venv.EnvBuilder", "os.execv", "'.venv'");
    assertThat(root.resolve(".venv")).doesNotExist();
    Path outside = Files.createDirectory(root.resolveSibling(root.getFileName() + "-outside"));
    Files.createSymbolicLink(root.resolve(".venv"), outside);
    try {
      assertThatThrownBy(() -> PythonProjectRuntime.sync(root))
          .hasMessageContaining("escaping symbolic links");
    } finally {
      Files.delete(root.resolve(".venv"));
      Files.delete(outside);
    }
  }

  @Test
  void djangoGeneratedCommandUsesRunserverAndSavedPortWhileCustomArgumentsRemainExact()
      throws Exception {
    Files.writeString(root.resolve("manage.py"), "# fixture");
    var detected = new RuntimeDetector(null).detect(root, "Fixture");
    assertThat(detected).containsEntry("args", List.of("manage.py", "runserver", "127.0.0.1:8000"));
    var local = mock(LocalEnvironmentService.class);
    when(local.resolve("saved")).thenReturn(Map.of());
    var service =
        new RuntimeConfigurationService(
            null,
            new RuntimeDetector(null),
            null,
            local,
            new ApplicationConfigService(),
            null,
            null,
            null);
    detected.putAll(
        object("id", "saved", "repositoryId", "repo", "launchSource", "detected", "port", 9100));
    assertThat(service.resolve(repository(), detected))
        .containsEntry("args", List.of("manage.py", "runserver", "127.0.0.1:9100"));
    when(local.resolve("saved")).thenReturn(Map.of("PORT", "9200"));
    assertThat(service.resolve(repository(), detected))
        .containsEntry("args", List.of("manage.py", "runserver", "127.0.0.1:9200"));
    detected.put("launchSource", "custom");
    detected.put("args", List.of("manage.py", "check"));
    assertThat(service.resolve(repository(), detected))
        .containsEntry("args", List.of("manage.py", "check"));
  }
}
