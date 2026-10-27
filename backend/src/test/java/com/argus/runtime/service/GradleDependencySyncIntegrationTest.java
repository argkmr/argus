package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.argus.workspace.domain.Repository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * No network/dependency installation: an existing Gradle resolves only an in-fixture Maven repo.
 */
class GradleDependencySyncIntegrationTest {
  @TempDir Path directory;

  @Test
  void resolvesExternalArtifactsAcrossModulesWithoutCompilingOrRunningProject() throws Exception {
    String gradle = System.getProperty("argus.test.gradle", "");
    assumeTrue(
        !gradle.isBlank() && Files.isExecutable(Path.of(gradle)),
        "No installed test Gradle selected");
    Files.createDirectories(directory.resolve("api"));
    Files.createDirectories(directory.resolve("library"));
    Files.writeString(
        directory.resolve("settings.gradle"),
        "rootProject.name='argus-sync-fixture'\ninclude 'api', 'library'\n");
    Files.writeString(
        directory.resolve("build.gradle"),
        """
        subprojects {
          apply plugin: 'java-library'
          repositories { maven { url = rootProject.uri('fixture-maven') } }
        }
        project(':library') { dependencies { api 'local.fixture:external-lib:1.0' } }
        project(':api') { dependencies { implementation project(':library') } }
        gradle.taskGraph.whenReady { graph ->
          if (graph.allTasks.any { it.name != 'argusResolveDependencies' }) {
            throw new GradleException('Sync must not schedule compilation, tests, or application tasks')
          }
        }
        """);
    Path artifact =
        Files.createDirectories(directory.resolve("fixture-maven/local/fixture/external-lib/1.0"));
    Files.writeString(
        artifact.resolve("external-lib-1.0.pom"),
        """
        <project xmlns="http://maven.apache.org/POM/4.0.0">
          <modelVersion>4.0.0</modelVersion><groupId>local.fixture</groupId>
          <artifactId>external-lib</artifactId><version>1.0</version><packaging>jar</packaging>
        </project>
        """);
    var processes = new ProcessManager();
    var repository = new Repository("fixture", "Fixture", directory.toString(), "now");
    var config =
        object(
            "id",
            "sync",
            "name",
            "Fixture sync",
            "cwd",
            ".",
            "executable",
            gradle,
            "args",
            List.of(
                ":argusResolveDependencies",
                "--offline",
                "--refresh-dependencies",
                "--max-workers=1",
                "-Dorg.gradle.vfs.watch=false"),
            "task",
            "sync",
            "stage",
            "syncing",
            "label",
            "Sync fixture");
    var environment =
        Map.of(
            "GRADLE_USER_HOME",
            directory.resolve("gradle-user-home").toString(),
            "JAVA_HOME",
            System.getProperty("java.home"));
    String script = new ProjectStructureService(null, null, null).gradleSyncScript();
    try {
      // A missing artifact must fail: merely resolving POM metadata is not a dependency sync.
      var missing = processes.runGradleTask(config, repository, environment, script);
      processes.completion(text(missing, "id")).get(55, TimeUnit.SECONDS);
      assertThat(processes.list().get(0)).containsEntry("status", "failed");
      assertThat(processes.logs(text(missing, "id"), 0).toString())
          .contains("external-lib-1.0.jar");
      try (var jar =
          new JarOutputStream(Files.newOutputStream(artifact.resolve("external-lib-1.0.jar")))) {
        jar.putNextEntry(new JarEntry("fixture.txt"));
        jar.write(
            "argus local dependency fixture".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        jar.closeEntry();
      }
      var synced = processes.runGradleTask(config, repository, environment, script);
      processes.completion(text(synced, "id")).get(55, TimeUnit.SECONDS);
      assertThat(processes.list().get(1))
          .withFailMessage(
              "Dependency sync did not complete: %s", processes.logs(text(synced, "id"), 0))
          .containsEntry("status", "completed")
          .containsEntry("exitCode", 0);
      assertThat(processes.logs(text(synced, "id"), 0).toString())
          .contains(
              "Argus sync resolved 1 external artifact(s): :api / runtimeClasspath",
              "Argus sync resolved 1 external artifact(s): :library / runtimeClasspath");
      assertThat(directory.resolve("api/build/classes")).doesNotExist();
      assertThat(directory.resolve("library/build/classes")).doesNotExist();
    } finally {
      processes.stopAll();
    }
  }
}
