package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.workspace.domain.Repository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class RuntimeServiceCompatibilityTest {
  @TempDir Path root;

  @Test
  void dependencyMaintenanceStillResolvesDeclaredNodeWithoutAStartScript() throws Exception {
    Files.writeString(root.resolve("package.json"), "{\"engines\":{\"node\":\"20.x\"}}\n");
    var node = mock(NodeRuntimeService.class);
    when(node.resolve(root))
        .thenReturn(
            object(
                "version",
                "20.20.0",
                "environment",
                Map.of("PATH", "/fixture/node20/bin:/fixture/bin")));
    var service =
        new RuntimeConfigurationService(
            null, new RuntimeDetector(node), null, null, null, null, null, null);
    var repository = new Repository("r", "fixture", root.toString(), "now", "main");
    var runtime =
        service.projectRuntime(
            repository, object("executable", "npm", "args", java.util.List.of("install")));
    assertThat(map(runtime.get("environment")))
        .containsEntry("PATH", "/fixture/node20/bin:/fixture/bin");
    assertThat(map(runtime.get("configuration"))).containsEntry("runtimeLabel", "Node 20.20.0");
    when(node.resolve(root))
        .thenThrow(new RuntimeCompatibilityException("Node 20 is not installed"));
    assertThatThrownBy(() -> service.projectRuntime(repository, object("executable", "npm")))
        .isInstanceOf(RuntimeCompatibilityException.class);
  }

  @Test
  void javaPatchVersionsAreOrderedNumerically() {
    assertThat(JavaProjectService.compareVersionNumbers("17.0.10+7", "17.0.9+99")).isPositive();
    assertThat(JavaProjectService.literalLevel("'17' // developer's setting")).isEqualTo("17");
  }
}
