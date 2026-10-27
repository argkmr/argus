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

class ProjectStructureServiceTest {
  @TempDir Path root;

  ProjectStructureService service() {
    return new ProjectStructureService(
        null,
        null,
        (command, args, cwd, timeout) ->
            new CommandResult(command.equals("python3") ? "Python 3.12.0\n" : "1.0.0\n", "", 0));
  }

  Repository repository() {
    return new Repository("r", "fixture", root.toString(), "now", "main");
  }

  @Test
  void pythonMetadataAndMaintenanceDoNotRunRepositoryCode() throws Exception {
    Files.writeString(
        root.resolve("requirements.txt"), "fastapi==1\npytest>=8\n# comment\n-r local.txt\n");
    Files.writeString(root.resolve("main.py"), "from fastapi import FastAPI\napp=FastAPI()\n");
    Files.createDirectories(root.resolve("tests"));
    var service = service();
    var project = service.inspect(repository(), Map.of());
    assertThat(project).containsEntry("analyzer", "python").containsEntry("framework", "FastAPI");
    assertThat(map(project.get("dependencies"))).containsEntry("production", 2);
    assertThat(service.maintenance(repository(), "test"))
        .containsEntry("executable", "python3")
        .containsEntry("args", List.of("-m", "pytest"));
    assertThat(service.command(repository(), "script", "run")).isEqualTo("python3 'main.py'");
    assertThatThrownBy(() -> service.command(repository(), "script", "run; rm"))
        .hasMessageContaining("detected");
  }

  @Test
  void genericAnalyzerIgnoresGeneratedAndExternalSource() throws Exception {
    Files.createDirectories(root.resolve("src"));
    Files.writeString(root.resolve("src/main.go"), "package main\n");
    Files.createDirectories(root.resolve("vendor"));
    Files.writeString(root.resolve("vendor/noise.java"), "class Noise {}");
    Path outside = Files.createTempDirectory(root, "external-");
    Files.writeString(outside.resolve("hidden.swift"), "struct Hidden {}");
    Files.createSymbolicLink(root.resolve("src/external"), outside);
    var result = service().inspect(repository(), Map.of());
    assertThat(result).containsEntry("analyzer", "generic");
    assertThat(
            list(map(result.get("runtime")).get("languages")).stream()
                .map(RuntimeData::map)
                .filter(item -> "Go".equals(item.get("name")))
                .findFirst()
                .orElseThrow())
        .containsEntry("count", 1);
    assertThatThrownBy(() -> service().maintenance(repository(), "test"))
        .hasMessageContaining("not available");
  }

  @Test
  void javaSyncResolvesDependenciesNotJustGradleHelpAndIncludesMavenPlugins() throws Exception {
    var javaProjects = mock(JavaProjectService.class);
    Files.writeString(root.resolve("build.gradle"), "plugins { id 'java' }");
    when(javaProjects.inspect(any(), anyMap()))
        .thenAnswer(
            call -> new java.util.LinkedHashMap<>(Map.of("build", Map.of("tool", "Gradle"))));
    var service = new ProjectStructureService(javaProjects, null, null);
    assertThat(service.maintenance(repository(), "sync"))
        .containsEntry("executable", "gradle")
        .containsEntry("args", List.of("--refresh-dependencies", ":argusResolveDependencies"));
    Files.writeString(root.resolve("gradlew"), "fixture wrapper");
    assertThat(service.maintenance(repository(), "sync")).containsEntry("executable", "./gradlew");
    assertThat(service.gradleSyncScript())
        .contains("root.allprojects", "it.canBeResolved", "ModuleComponentIdentifier");
    when(javaProjects.inspect(any(), anyMap()))
        .thenAnswer(
            call -> new java.util.LinkedHashMap<>(Map.of("build", Map.of("tool", "Maven"))));
    assertThat(service.maintenance(repository(), "sync"))
        .containsEntry("args", List.of("-U", "dependency:go-offline"));
  }

  @Test
  void rejectsMalformedRuntimeDeclarations() {
    for (String range : List.of("-", "20 -", "- 20", "20 - - 22"))
      assertThat(NodeRuntimeService.validRange(range)).as(range).isFalse();
    assertThat(JavaProjectService.literalLevel("'17\"")).isEmpty();
    assertThat(JavaProjectService.literalLevel("JavaVersion.toVersion('17')")).isEqualTo("17");
  }
}
