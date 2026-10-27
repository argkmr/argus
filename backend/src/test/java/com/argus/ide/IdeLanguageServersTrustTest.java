package com.argus.ide;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.NotFoundException;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.dto.WorkspaceResponse;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class IdeLanguageServersTrustTest {
  @TempDir Path temporary;
  private WorkspaceService workspace;
  private Map<String, Object> preferences;
  private Path root;

  @BeforeEach
  void setup() throws Exception {
    workspace = mock(WorkspaceService.class);
    preferences = new LinkedHashMap<>();
    root = Files.createDirectory(temporary.resolve("repo"));
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Example", root.toString(), ""));
    when(workspace.snapshot())
        .thenAnswer(
            invocation ->
                new WorkspaceResponse(
                    1, "repo", preferences, List.of(), List.of(), List.of(), Map.of()));
    when(workspace.preferences(anyMap()))
        .thenAnswer(
            invocation -> {
              preferences.putAll(invocation.getArgument(0));
              return preferences;
            });
  }

  private IdeLanguageServers servers() {
    return new IdeLanguageServers(
        workspace, new ArgusProperties(temporary.resolve("state"), null, "test", ""));
  }

  @Test
  void automaticJavaLaunchKeepsGeneratedProjectMetadataOutOfTheSourceRepository() {
    var command = servers().discover("repo", "java");
    String flag = "-Djava.import.generatesMetadataFilesAtProjectRoot=false";
    if (command.args().contains("-jar")) {
      assertTrue(command.args().contains(flag));
      assertTrue(command.args().indexOf(flag) < command.args().indexOf("-jar"));
    } else {
      // Eclipse's jdtls wrapper forwards each --jvm-arg to Java before -jar.
      assertTrue(command.args().contains("--jvm-arg=" + flag));
    }
  }

  @Test
  void javaTrustIsOptInAndSurvivesServerRecreationWithoutConfiguringAnExecutable() {
    var servers = servers();
    assertFalse(servers.trustedProject("repo", "java"));
    var command = servers.discover("repo", "java");
    servers.setTrustedProject("repo", "java", true);
    assertTrue(servers.trustedProject("repo", "java"));
    assertTrue(servers().trustedProject("repo", "java"));
    assertFalse(preferences.containsKey("ideLanguageServers"));
    assertEquals(command, servers.discover("repo", "java"));
  }

  @Test
  void trustIsScopedToRepositoryIdentityCanonicalRootAndJavaOnly() throws Exception {
    var servers = servers();
    when(workspace.requireRepository("other"))
        .thenReturn(new Repository("other", "Same path, new identity", root.toString(), ""));
    servers.setTrustedProject("repo", "java", true);
    assertFalse(servers.trustedProject("other", "java"));
    assertFalse(servers.trustedProject("repo", "typescript"));
    servers.setTrustedProject("repo", "typescript", true);
    assertFalse(servers.trustedProject("repo", "typescript"));

    Path relocated = Files.createDirectory(temporary.resolve("relocated"));
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Relocated", relocated.toString(), ""));
    assertFalse(servers.trustedProject("repo", "java"));
    servers.setTrustedProject("repo", "java", true);
    assertTrue(servers.trustedProject("repo", "java"));
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Original", root.toString(), ""));
    assertFalse(servers.trustedProject("repo", "java"));
  }

  @Test
  void canonicalPathsKeepTrustButRetargetedSymlinksDoNot() throws Exception {
    var servers = servers();
    Path alias = Files.createSymbolicLink(temporary.resolve("repo-alias"), root);
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Alias", alias.resolve(".").toString(), ""));
    servers.setTrustedProject("repo", "java", true);
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Real", root.toString(), ""));
    assertTrue(servers.trustedProject("repo", "java"));

    Files.delete(alias);
    Files.createSymbolicLink(alias, Files.createDirectory(temporary.resolve("another-repo")));
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Retargeted", alias.toString(), ""));
    assertFalse(servers.trustedProject("repo", "java"));
  }

  @Test
  void trustMustMatchTheExactPreviouslyResolvedWorkerLaunchRoot() throws Exception {
    var servers = servers();
    servers.setTrustedProject("repo", "java", true);
    Path launchRoot = root.toRealPath();
    assertTrue(servers.trustedProject("repo", "java", launchRoot));
    assertFalse(servers.trustedProject("repo", "java", null));

    Path replacement = Files.createDirectory(temporary.resolve("replacement")).toRealPath();
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Replacement", replacement.toString(), ""));
    servers.setTrustedProject("repo", "java", true);
    assertTrue(servers.trustedProject("repo", "java"));
    assertFalse(
        servers.trustedProject("repo", "java", launchRoot),
        "A new grant for the current root must not authorize an already-resolved old launch root");
    assertTrue(servers.trustedProject("repo", "java", replacement));
  }

  @Test
  void missingInvalidAndNonDirectoryRootsNeverInheritTrustAndCanBeRevoked() throws Exception {
    var servers = servers();
    servers.setTrustedProject("repo", "java", true);
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Missing", temporary.resolve("missing").toString(), ""));
    assertFalse(servers.trustedProject("repo", "java"));
    assertThrows(
        IllegalArgumentException.class, () -> servers.setTrustedProject("repo", "java", true));
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Relative", "repo", ""));
    assertFalse(servers.trustedProject("repo", "java"));
    Path file = Files.writeString(temporary.resolve("file"), "not a directory");
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "File", file.toString(), ""));
    assertFalse(servers.trustedProject("repo", "java"));
    when(workspace.requireRepository("repo"))
        .thenThrow(new NotFoundException("Repository not found"));
    assertFalse(servers.trustedProject("repo", "java"));
    servers.setTrustedProject("repo", "java", false);
    assertTrue(((Map<?, ?>) preferences.get("ideProjectTrust")).isEmpty());
  }

  @Test
  void explicitRevocationSurvivesRestartAndCommandChangesPreserveTrust() {
    var servers = servers();
    servers.setTrustedProject("repo", "java", true);
    String java = Path.of(System.getProperty("java.home"), "bin/java").toString();
    servers.configure("repo", "java", java, List.of("--version"));
    assertTrue(servers.trustedProject("repo", "java"));
    assertEquals(List.of("--version"), servers.discover("repo", "java").args());
    servers.setTrustedProject("repo", "java", false);
    assertFalse(servers().trustedProject("repo", "java"));
    assertEquals(List.of("--version"), servers.discover("repo", "java").args());
  }

  @Test
  void offboardingPurgesOnlySelectedRepositoryTrustAndConfiguration() throws Exception {
    var servers = servers();
    Path other = Files.createDirectory(temporary.resolve("other"));
    when(workspace.requireRepository("other"))
        .thenReturn(new Repository("other", "Other", other.toString(), ""));
    servers.setTrustedProject("repo", "java", true);
    servers.setTrustedProject("other", "java", true);
    String java = Path.of(System.getProperty("java.home"), "bin/java").toString();
    servers.configure("repo", "java", java, List.of("--version"));
    servers.configure("other", "java", java, List.of("--version"));
    preferences.put("unrelated", "retained");
    servers.purgeRepository("repo");
    assertFalse(servers.trustedProject("repo", "java"));
    assertTrue(servers.trustedProject("other", "java"));
    assertFalse(((Map<?, ?>) preferences.get("ideProjectTrust")).containsKey("repo"));
    assertFalse(((Map<?, ?>) preferences.get("ideLanguageServers")).containsKey("repo"));
    assertEquals(List.of("--version"), servers.discover("other", "java").args());
    assertEquals("retained", preferences.get("unrelated"));
    assertTrue(Files.isDirectory(root));
  }

  @Test
  void malformedOrLegacyTrustRecordsAreNeverAccepted() {
    for (Object record :
        List.of(
            true,
            root.toString(),
            Map.of("trusted", "true", "root", root.toString()),
            Map.of("trusted", true),
            Map.of("trusted", false, "root", root.toString()))) {
      preferences.put("ideProjectTrust", Map.of("repo", Map.of("java", record)));
      assertFalse(servers().trustedProject("repo", "java"));
    }
  }
}
