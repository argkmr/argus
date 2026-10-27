package com.argus.ide;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ConflictException;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.dto.WorkspaceResponse;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.test.util.ReflectionTestUtils;
import tools.jackson.databind.ObjectMapper;

class IdeServiceTest {
  @TempDir Path temporary;

  static List<String> command(Path log) throws Exception {
    Path arguments = log.resolveSibling(log.getFileName() + ".javaargs");
    String classpath =
        System.getProperty("java.class.path").replace("\\", "\\\\").replace("\"", "\\\"");
    Files.writeString(arguments, "-cp\n\"" + classpath + "\"\n");
    return List.of(
        Path.of(System.getProperty("java.home"), "bin/java").toString(),
        "@" + arguments,
        FakeLspServer.class.getName(),
        log.toString());
  }

  @Test
  void trueLspHandshakeNavigationSymbolsAndLifecycle() throws Exception {
    Path root = Files.createDirectory(temporary.resolve("repo"));
    Files.writeString(root.resolve("app.ts"), "export const café = 1;\n");
    Files.writeString(root.resolve("other.ts"), "export const other = 1;\n");
    Path log = temporary.resolve("messages.jsonl");
    var workspace = mock(WorkspaceService.class);
    var preferences = new LinkedHashMap<String, Object>();
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
    var servers =
        new IdeLanguageServers(
            workspace, new ArgusProperties(temporary.resolve("state"), null, "test", ""));
    var files = new IdeFiles();
    var service = new IdeService(workspace, files, servers, new ObjectMapper());
    var command = command(log);
    service.configure("repo", "typescript", command.get(0), command.subList(1, command.size()));
    assertEquals(false, service.status("repo").get("running"));
    assertFalse(Files.exists(log), "Status must not launch workers");
    try {
      for (String kind :
          List.of("definition", "declaration", "typeDefinition", "references", "implementation")) {
        var result =
            service.navigate(
                "repo", "app.ts", 1, 15, kind, files.read(root, "app.ts").contentHash());
        assertEquals(1, result.locations().size(), result.notice());
        assertEquals(new IdeService.Location("app.ts", 1, 14, 1, 18), result.locations().get(0));
      }
      assertEquals("café😀", service.symbols("repo", "app.ts", "").results().get(0).name());
      assertEquals("café😀", service.symbols("repo", null, "café").results().get(0).name());
      service.navigate("repo", "other.ts", 1, 15, "definition");
      var current = files.read(root, "app.ts");
      files.write(root, "app.ts", "export const café = 2;\n", current.contentHash());
      service.navigate("repo", "other.ts", 1, 15, "definition");
      long pid = Long.parseLong(Files.readString(temporary.resolve("pid")));
      assertTrue(ProcessHandle.of(pid).orElseThrow().isAlive());
      service.refresh("repo");
      assertFalse(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false));
      assertFalse((boolean) service.status("repo").get("running"));
      assertEquals(
          command.subList(1, command.size()), servers.discover("repo", "typescript").args());
      String messages = Files.readString(log);
      assertTrue(messages.contains("initialize"));
      assertTrue(messages.contains("\"id\":\"config\",\"result\""));
      assertTrue(messages.contains("textDocument/didClose"));
      assertTrue(
          messages.contains("export const café = 2;"),
          "Cross-file saves must refresh previously opened LSP documents");
      assertTrue(messages.contains("shutdown"));
      assertTrue(messages.contains("\"allowLocalPluginLoads\":false"));
      Path cache = temporary.resolve("state/ide").resolve(IdeFiles.hash("repo").substring(0, 32));
      Files.createDirectories(cache.resolve("java/workspace"));
      Files.writeString(cache.resolve("java/workspace/index"), "cached");
      Files.createSymbolicLink(cache.resolve("source-link"), root);
      service.stopRepository("repo");
      assertFalse(Files.exists(cache));
      assertTrue(
          Files.exists(root.resolve("app.ts")),
          "Offboarding must preserve source even if cache contains a symlink");
      assertFalse(((Map<?, ?>) preferences.get("ideLanguageServers")).containsKey("repo"));
      assertThrows(IllegalStateException.class, () -> service.start("repo", "typescript", false));
      assertThrows(IllegalStateException.class, () -> service.status("repo"));
    } finally {
      service.quiesce();
    }
  }

  @ParameterizedTest
  @ValueSource(strings = {"definition-only", "empty-declaration"})
  void declarationFallbackIsHonestAndUnsupportedTypeDefinitionIsNotSent(String mode)
      throws Exception {
    Files.writeString(temporary.resolve("app.ts"), "export const value = 1;\n");
    Path log = temporary.resolve("definition-only.jsonl");
    var workspace = mock(WorkspaceService.class);
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Example", temporary.toString(), ""));
    var command = new ArrayList<>(command(log));
    command.add(mode);
    var preferences =
        Map.<String, Object>of(
            "ideLanguageServers",
            Map.of(
                "repo",
                Map.of(
                    "typescript",
                    Map.of(
                        "executable",
                        command.get(0),
                        "args",
                        command.subList(1, command.size())))));
    when(workspace.snapshot())
        .thenReturn(
            new WorkspaceResponse(
                1, "repo", preferences, List.of(), List.of(), List.of(), Map.of()));
    var service =
        new IdeService(
            workspace,
            new IdeFiles(),
            new IdeLanguageServers(
                workspace, new ArgusProperties(temporary.resolve("state"), null, "test", "")),
            new ObjectMapper());
    try {
      var declaration = service.navigate("repo", "app.ts", 1, 15, "declaration");
      assertFalse(declaration.locations().isEmpty());
      assertTrue(declaration.notice().contains("showing definition instead"));
      var type = service.navigate("repo", "app.ts", 1, 15, "typeDefinition");
      if (mode.equals("definition-only")) {
        assertTrue(type.locations().isEmpty());
        assertTrue(type.notice().contains("does not advertise"));
      } else assertFalse(type.locations().isEmpty());
      String messages = Files.readString(log);
      assertTrue(messages.contains("\"method\":\"textDocument/definition\""));
      assertEquals(
          mode.equals("empty-declaration"),
          messages.contains("\"method\":\"textDocument/typeDefinition\""));
      assertEquals(
          mode.equals("empty-declaration"),
          messages.contains("\"method\":\"textDocument/declaration\""));
    } finally {
      service.quiesce();
    }
  }

  @Test
  void navigationRejectsInvalidOrStaleSnapshotsBeforeStartingLanguageWorkers() throws Exception {
    Files.writeString(temporary.resolve("app.ts"), "export const value = 1;\n");
    var workspace = mock(WorkspaceService.class);
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Example", temporary.toString(), ""));
    var files = new IdeFiles();
    var servers = mock(IdeLanguageServers.class);
    var service = new IdeService(workspace, files, servers, new ObjectMapper());
    String staleHash = files.read(temporary, "app.ts").contentHash();
    Files.writeString(temporary.resolve("app.ts"), "export const value = 2;\n");
    for (String hash : List.of("", " ", "xyz", "a".repeat(63), "a".repeat(65), "A".repeat(64)))
      assertThrows(
          IllegalArgumentException.class,
          () -> service.navigate("repo", "app.ts", 1, 15, "definition", hash));
    var conflict =
        assertThrows(
            ConflictException.class,
            () -> service.navigate("repo", "app.ts", 1, 15, "definition", staleHash));
    assertTrue(conflict.getMessage().contains("changed on disk"));
    verifyNoInteractions(servers);
  }

  @Test
  void navigationRechecksSnapshotAfterLanguageServerStartup() throws Exception {
    Path root = Files.createDirectory(temporary.resolve("java-repo"));
    Files.writeString(root.resolve("App.java"), "class App { int value = 1; }\n");
    Path log = temporary.resolve("navigation-ready.jsonl");
    var workspace = mock(WorkspaceService.class);
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Example", root.toString(), ""));
    var command = new ArrayList<>(command(log));
    command.add("java-ready");
    var preferences =
        Map.<String, Object>of(
            "ideLanguageServers",
            Map.of(
                "repo",
                Map.of(
                    "java",
                    Map.of(
                        "executable",
                        command.get(0),
                        "args",
                        command.subList(1, command.size())))));
    when(workspace.snapshot())
        .thenReturn(
            new WorkspaceResponse(
                1, "repo", preferences, List.of(), List.of(), List.of(), Map.of()));
    var files = new IdeFiles();
    var service =
        new IdeService(
            workspace,
            files,
            new IdeLanguageServers(
                workspace, new ArgusProperties(temporary.resolve("state"), null, "test", "")),
            new ObjectMapper());
    String expectedHash = files.read(root, "App.java").contentHash();
    var navigating =
        CompletableFuture.supplyAsync(
            () -> service.navigate("repo", "App.java", 1, 17, "definition", expectedHash));
    try {
      long deadline = System.nanoTime() + Duration.ofSeconds(8).toNanos();
      while (!Files.exists(log) || !Files.readString(log).contains("\"method\":\"initialized\"")) {
        assertTrue(System.nanoTime() < deadline, "Fake server must receive initialized");
        Thread.sleep(10);
      }
      assertFalse(navigating.isDone(), "Navigation must wait for Java startup");
      Files.writeString(root.resolve("App.java"), "class App { int other = 2; }\n");
      Files.writeString(temporary.resolve("release-ready"), "ready");
      var error = assertThrows(ExecutionException.class, () -> navigating.get(5, TimeUnit.SECONDS));
      assertInstanceOf(ConflictException.class, error.getCause());
      assertFalse(
          Files.readString(log).contains("textDocument/definition"),
          "A stale position must never reach the language server");
      assertFalse(
          Files.readString(log).contains("textDocument/didOpen"),
          "Do not open the replaced source snapshot for rejected navigation");
    } finally {
      service.quiesce();
    }
  }

  @Test
  void navigationRechecksSnapshotAfterLanguageServerResponds() throws Exception {
    Path root = Files.createDirectory(temporary.resolve("typescript-repo"));
    Files.writeString(root.resolve("app.ts"), "export const value = 1;\n");
    Path log = temporary.resolve("navigation-response.jsonl");
    var workspace = mock(WorkspaceService.class);
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Example", root.toString(), ""));
    var command = new ArrayList<>(command(log));
    command.add("navigation-gate");
    var preferences =
        Map.<String, Object>of(
            "ideLanguageServers",
            Map.of(
                "repo",
                Map.of(
                    "typescript",
                    Map.of(
                        "executable",
                        command.get(0),
                        "args",
                        command.subList(1, command.size())))));
    when(workspace.snapshot())
        .thenReturn(
            new WorkspaceResponse(
                1, "repo", preferences, List.of(), List.of(), List.of(), Map.of()));
    var files = new IdeFiles();
    var service =
        new IdeService(
            workspace,
            files,
            new IdeLanguageServers(
                workspace, new ArgusProperties(temporary.resolve("state"), null, "test", "")),
            new ObjectMapper());
    String expectedHash = files.read(root, "app.ts").contentHash();
    var navigating =
        CompletableFuture.supplyAsync(
            () -> service.navigate("repo", "app.ts", 1, 15, "definition", expectedHash));
    try {
      long deadline = System.nanoTime() + Duration.ofSeconds(8).toNanos();
      while (!Files.exists(log)
          || !Files.readString(log).contains("\"method\":\"textDocument/definition\"")) {
        assertTrue(System.nanoTime() < deadline, "Fake server must receive definition request");
        Thread.sleep(10);
      }
      assertFalse(navigating.isDone(), "Navigation response must wait at the test gate");
      Files.writeString(root.resolve("app.ts"), "export const other = 2;\n");
      Files.writeString(temporary.resolve("release-navigation"), "ready");
      var error = assertThrows(ExecutionException.class, () -> navigating.get(5, TimeUnit.SECONDS));
      assertInstanceOf(ConflictException.class, error.getCause());
    } finally {
      service.quiesce();
    }
  }

  @Test
  void javaDoesNotAdvertiseNavigationUntilProjectReadinessAndReadinessWaitIsBounded()
      throws Exception {
    Path root = Files.createDirectory(temporary.resolve("java-repo"));
    Path log = temporary.resolve("java-ready.jsonl");
    var workspace = mock(WorkspaceService.class);
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Example", root.toString(), ""));
    var command = new ArrayList<>(command(log));
    command.add("java-ready");
    var preferences =
        Map.<String, Object>of(
            "ideLanguageServers",
            Map.of(
                "repo",
                Map.of(
                    "java",
                    Map.of(
                        "executable",
                        command.get(0),
                        "args",
                        command.subList(1, command.size())))));
    when(workspace.snapshot())
        .thenReturn(
            new WorkspaceResponse(
                1, "repo", preferences, List.of(), List.of(), List.of(), Map.of()));
    var service =
        new IdeService(
            workspace,
            new IdeFiles(),
            new IdeLanguageServers(
                workspace, new ArgusProperties(temporary.resolve("state"), null, "test", "")),
            new ObjectMapper());
    var starting = CompletableFuture.supplyAsync(() -> service.start("repo", "java", false));
    try {
      long deadline = System.nanoTime() + Duration.ofSeconds(8).toNanos();
      while (!Files.exists(log) || !Files.readString(log).contains("\"method\":\"initialized\"")) {
        assertTrue(System.nanoTime() < deadline, "Fake server must receive initialized");
        Thread.sleep(10);
      }
      assertFalse(starting.isDone(), "Initialize alone must not mark JDT ready");
      var languages = (List<?>) service.status("repo").get("languages");
      var java = (Map<?, ?>) languages.get(0);
      assertEquals(true, java.get("initializing"));
      assertEquals(false, java.get("ready"));
      assertEquals(false, ((Map<?, ?>) java.get("capabilities")).get("definition"));
      Files.writeString(temporary.resolve("release-ready"), "ready");
      starting.get(5, TimeUnit.SECONDS);
      java = (Map<?, ?>) ((List<?>) service.status("repo").get("languages")).get(0);
      assertEquals(false, java.get("initializing"));
      assertEquals(true, java.get("ready"));
      assertEquals(true, ((Map<?, ?>) java.get("capabilities")).get("definition"));
    } finally {
      service.quiesce();
    }
    var client =
        new LspClient(command(temporary.resolve("no-ready.jsonl")), temporary, new ObjectMapper());
    try {
      client.request("initialize", Map.of(), Duration.ofSeconds(5));
      var error =
          assertThrows(
              IllegalStateException.class,
              () -> client.awaitJavaServiceReady(Duration.ofMillis(100)));
      assertTrue(error.getMessage().contains("startup timed out"));
      assertFalse(client.alive());
    } finally {
      client.close();
    }
  }

  @Test
  void retiredInitializerCannotOverwriteTheReplacementWorkersReadyStatus() throws Exception {
    Path root = Files.createDirectory(temporary.resolve("restart-repo"));
    Path log = temporary.resolve("retired-ready.jsonl");
    var workspace = mock(WorkspaceService.class);
    var preferences = new LinkedHashMap<String, Object>();
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
    var service =
        new IdeService(
            workspace,
            new IdeFiles(),
            new IdeLanguageServers(
                workspace, new ArgusProperties(temporary.resolve("state"), null, "test", "")),
            new ObjectMapper());
    var command = new ArrayList<>(command(log));
    command.add("java-ready");
    service.configure("repo", "java", command.get(0), command.subList(1, command.size()));
    var starting = CompletableFuture.supplyAsync(() -> service.start("repo", "java", false));
    var failureObserved = new CountDownLatch(1);
    var releaseFailure = new CountDownLatch(1);
    try {
      long deadline = System.nanoTime() + Duration.ofSeconds(8).toNanos();
      while (!Files.exists(log) || !Files.readString(log).contains("\"method\":\"initialized\"")) {
        assertTrue(System.nanoTime() < deadline, "Fake server must reach its Java readiness gate");
        Thread.sleep(10);
      }
      // Hold the old caller's exception delivery until after a replacement is ready. This
      // deterministically covers a delayed startup failure without thread sleeps/suspension.
      var sessions = (Map<?, ?>) ReflectionTestUtils.getField(service, "sessions");
      var oldSession = sessions.get("repo:java");
      var client = (LspClient) ReflectionTestUtils.getField(oldSession, "client");
      var readiness =
          (CompletableFuture<?>) ReflectionTestUtils.getField(client, "javaServiceReady");
      readiness.completeExceptionally(
          new IllegalStateException("Retired worker failure") {
            @Override
            public String getMessage() {
              failureObserved.countDown();
              try {
                if (!releaseFailure.await(10, TimeUnit.SECONDS))
                  throw new AssertionError("Retired failure delivery was not released");
              } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new AssertionError(error);
              }
              return super.getMessage();
            }
          });
      assertTrue(failureObserved.await(5, TimeUnit.SECONDS));
      var replacement = command(temporary.resolve("replacement.jsonl"));
      service.configure(
          "repo", "java", replacement.get(0), replacement.subList(1, replacement.size()));
      service.start("repo", "java", false);
      releaseFailure.countDown();
      assertThrows(ExecutionException.class, () -> starting.get(5, TimeUnit.SECONDS));
      var java = (Map<?, ?>) ((List<?>) service.status("repo").get("languages")).get(0);
      assertEquals(true, java.get("ready"));
      assertEquals(true, java.get("running"));
      assertFalse(String.valueOf(java.get("notice")).contains("Retired worker failure"));
      assertTrue(String.valueOf(java.get("notice")).contains("Java project import is disabled"));
    } finally {
      releaseFailure.countDown();
      service.quiesce();
    }
  }

  @Test
  void javaTrustSurvivesServiceRestartAndRevocationStopsTrustedWorker() throws Exception {
    Path root = Files.createDirectory(temporary.resolve("java-trust-repo"));
    Files.writeString(root.resolve("App.java"), "class App { int value = 1; }\n");
    Path log = temporary.resolve("trust-lifecycle.jsonl");
    var workspace = mock(WorkspaceService.class);
    var preferences = new LinkedHashMap<String, Object>();
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
    var properties = new ArgusProperties(temporary.resolve("state"), null, "test", "");
    var servers = new IdeLanguageServers(workspace, properties);
    Files.writeString(root.resolve("build.gradle"), "plugins { id 'java' }\n");
    var projects = mock(com.argus.runtime.service.JavaProjectService.class);
    when(projects.resolveRuntimeEnvironment(any(), anyMap()))
        .thenReturn(Map.of("environment", Map.of("JAVA_HOME", "/fixture/project-jdk-17")));
    var javaProjects = new IdeJavaProjectSettings(workspace, projects);
    var service =
        new IdeService(workspace, new IdeFiles(), servers, new ObjectMapper(), javaProjects);
    var command = new ArrayList<>(command(log));
    command.add("empty-navigation");
    service.configure("repo", "java", command.get(0), command.subList(1, command.size()));
    var initial = (Map<?, ?>) ((List<?>) service.status("repo").get("languages")).get(0);
    assertEquals(false, initial.get("ready"));
    assertEquals(false, initial.get("trustedProject"));
    assertFalse(Files.exists(log), "Status and command configuration never launch a worker");
    try {
      var restricted = service.navigate("repo", "App.java", 1, 17, "definition");
      assertTrue(restricted.notice().contains("enable Java indexing"));
      assertFalse(Files.readString(log).contains("/fixture/project-jdk-17"));
      verifyNoInteractions(projects);
      service.start("repo", "java", true);
      service.navigate("repo", "App.java", 1, 17, "definition");
      assertTrue(Files.readString(log).contains("\"maven\":{\"enabled\":true}"));
      // Both initializationOptions and server-initiated workspace/configuration receive
      // the Services project JDK, without substituting it for the language-server executable.
      var json = new ObjectMapper();
      var messages = Files.readAllLines(log).stream().map(json::readTree).toList();
      assertTrue(
          messages.stream()
              .filter(message -> "initialize".equals(message.path("method").asText()))
              .anyMatch(
                  message ->
                      "/fixture/project-jdk-17"
                          .equals(
                              message
                                  .path("params")
                                  .path("initializationOptions")
                                  .path("settings")
                                  .path("java")
                                  .path("import")
                                  .path("gradle")
                                  .path("java")
                                  .path("home")
                                  .asText())));
      assertTrue(
          messages.stream()
              .filter(message -> "config".equals(message.path("id").asText()))
              .anyMatch(
                  message ->
                      "/fixture/project-jdk-17"
                          .equals(
                              message
                                  .path("result")
                                  .path(0)
                                  .path("import")
                                  .path("gradle")
                                  .path("java")
                                  .path("home")
                                  .asText())));
      verify(projects).resolveRuntimeEnvironment(any(), anyMap());
      service.closeRepository("repo");
      var stopped = (Map<?, ?>) ((List<?>) service.status("repo").get("languages")).get(0);
      assertEquals(true, stopped.get("trustedProject"));
      assertEquals(false, stopped.get("ready"));
      service.quiesce();
      // A new service/server object represents an app restart, not an in-memory grant.
      servers = new IdeLanguageServers(workspace, properties);
      service =
          new IdeService(workspace, new IdeFiles(), servers, new ObjectMapper(), javaProjects);
      var trusted = service.navigate("repo", "App.java", 1, 17, "definition");
      assertFalse(trusted.notice().contains("import is disabled"));
      assertTrue(trusted.notice().contains("still indexing"));
      long trustedPid = Long.parseLong(Files.readString(temporary.resolve("pid")));
      service.start("repo", "java", false);
      assertFalse(ProcessHandle.of(trustedPid).map(ProcessHandle::isAlive).orElse(false));
      assertFalse(servers.trustedProject("repo", "java"));
      assertTrue(
          service
              .navigate("repo", "App.java", 1, 17, "definition")
              .notice()
              .contains("enable Java indexing"));
      service.closeRepository("repo");
      service.navigate("repo", "App.java", 1, 17, "definition");
      var restarted = (Map<?, ?>) ((List<?>) service.status("repo").get("languages")).get(0);
      assertEquals(false, restarted.get("trustedProject"));
      assertEquals(true, restarted.get("ready"));
    } finally {
      service.quiesce();
    }
  }

  @Test
  void startupFailureIncludesActualExitCodeAndStderr() throws Exception {
    var argv = new ArrayList<>(command(temporary.resolve("failure.jsonl")));
    argv.add("startup-error");
    try (var client = new LspClient(argv, temporary, new ObjectMapper())) {
      var error =
          assertThrows(
              IllegalStateException.class,
              () -> client.request("initialize", Map.of(), Duration.ofSeconds(10)));
      assertTrue(error.getMessage().contains("exit 7"), error.getMessage());
      assertTrue(error.getMessage().contains("Missing Eclipse config.ini"), error.getMessage());
      assertEquals(error.getMessage(), client.failure());
      assertTimeoutPreemptively(
          Duration.ofMillis(500),
          () -> {
            var repeated =
                assertThrows(
                    IllegalStateException.class,
                    () -> client.request("initialize", Map.of(), Duration.ofSeconds(10)));
            assertEquals(error.getMessage(), repeated.getMessage());
          });
    }
  }

  @Test
  void timeoutKillsTheOwnedChildAndQuiescenceRejectsAdmission() throws Exception {
    Path log = temporary.resolve("timeout.jsonl");
    var command = new ArrayList<>(command(log));
    command.add("hang");
    var client = new LspClient(command, temporary, new ObjectMapper());
    try {
      assertThrows(
          IllegalStateException.class,
          () -> client.request("initialize", Map.of(), Duration.ofMillis(400)));
      assertFalse(client.alive());
      if (Files.exists(temporary.resolve("pid"))) {
        long pid = Long.parseLong(Files.readString(temporary.resolve("pid")));
        assertFalse(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false));
      }
    } finally {
      client.close();
    }
  }
}
