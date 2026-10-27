package com.argus.ide;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.common.config.ArgusProperties;
import com.argus.workspace.dto.WorkspaceResponse;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class IdeLanguageServerPreparationTest {
  @TempDir Path temporary;

  private IdeLanguageServers servers(Path bundle) {
    var workspace = mock(WorkspaceService.class);
    var preferences = new LinkedHashMap<String, Object>();
    when(workspace.snapshot())
        .thenAnswer(
            ignored ->
                new WorkspaceResponse(
                    1, "repo", preferences, List.of(), List.of(), List.of(), Map.of()));
    when(workspace.preferences(anyMap()))
        .thenAnswer(
            call -> {
              preferences.putAll(call.getArgument(0));
              return preferences;
            });
    return new IdeLanguageServers(
        workspace, new ArgusProperties(temporary.resolve("state"), null, "test", ""), bundle);
  }

  private Path bundle() throws Exception {
    Path bundle = Files.createDirectory(temporary.resolve("bundle"));
    Files.createDirectory(bundle.resolve("plugins"));
    Files.writeString(bundle.resolve("plugins/org.eclipse.equinox.launcher_test.jar"), "fixture");
    for (String platform : List.of("mac", "mac_arm", "linux", "linux_arm", "win", "win_arm")) {
      Path config = Files.createDirectory(bundle.resolve("config_" + platform));
      Files.writeString(config.resolve("config.ini"), "osgi.bundles=required-runtime\n");
    }
    return bundle;
  }

  private Path cache() {
    return temporary.resolve("state/ide/" + IdeFiles.hash("repo").substring(0, 32) + "/java");
  }

  private List<String> args(Path bundle, Path config) {
    return List.of(
        "-jar",
        bundle.resolve("plugins/org.eclipse.equinox.launcher_test.jar").toString(),
        "-configuration",
        config.toString(),
        "-data",
        cache().resolve("workspace").toString());
  }

  @Test
  void savingPrefilledBundledCommandStillRepairsMissingEclipseConfiguration() throws Exception {
    Path bundle = bundle(), config = cache().resolve("configuration");
    var servers = servers(bundle);
    servers.configure(
        "repo",
        "java",
        Path.of(System.getProperty("java.home"), "bin/java").toString(),
        args(bundle, config));
    Path workspace = Files.createDirectories(cache().resolve("workspace"));
    Files.writeString(workspace.resolve("index"), "preserve existing index");
    Files.createDirectories(config);
    Files.writeString(config.resolve("crash.log"), "previous startup failed");
    servers.prepare("repo", servers.discover("repo", "java"));
    assertEquals("osgi.bundles=required-runtime\n", Files.readString(config.resolve("config.ini")));
    assertEquals("preserve existing index", Files.readString(workspace.resolve("index")));
    assertTrue(Files.exists(config.resolve("crash.log")));
    Files.writeString(config.resolve("config.ini"), "old bundled version");
    servers.prepare("repo", servers.discover("repo", "java"));
    assertEquals("osgi.bundles=required-runtime\n", Files.readString(config.resolve("config.ini")));
  }

  @Test
  void customConfigurationDirectoryIsNotModified() throws Exception {
    Path bundle = bundle(), custom = Files.createDirectory(temporary.resolve("custom"));
    var servers = servers(bundle);
    servers.configure(
        "repo",
        "java",
        Path.of(System.getProperty("java.home"), "bin/java").toString(),
        args(bundle, custom));
    servers.prepare("repo", servers.discover("repo", "java"));
    assertFalse(Files.exists(custom.resolve("config.ini")));
    assertFalse(Files.exists(cache()));
  }

  @Test
  void preparationCannotFollowPrivateCacheSymlinksIntoSourceFiles() throws Exception {
    Path bundle = bundle(), config = cache().resolve("configuration");
    var servers = servers(bundle);
    servers.configure(
        "repo",
        "java",
        Path.of(System.getProperty("java.home"), "bin/java").toString(),
        args(bundle, config));
    Path external = Files.createDirectory(temporary.resolve("source"));
    Files.createDirectories(cache());
    Files.createSymbolicLink(config, external);
    assertThrows(
        IllegalStateException.class,
        () -> servers.prepare("repo", servers.discover("repo", "java")));
    assertFalse(Files.exists(external.resolve("config.ini")));
  }
}
