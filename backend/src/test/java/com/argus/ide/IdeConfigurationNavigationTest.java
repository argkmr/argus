package com.argus.ide;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.common.error.ConflictException;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class IdeConfigurationNavigationTest {
  @TempDir Path root;
  private final IdeFiles files = new IdeFiles();
  private final IdeConfigurationNavigation navigation = new IdeConfigurationNavigation(files);

  private IdeService.Navigation lookup(String path, String source, String selected)
      throws Exception {
    Files.writeString(root.resolve(path), source);
    return navigation.navigate(root, files.read(root, path), 1, source.indexOf(selected) + 1);
  }

  @Test
  void springPlaceholderFindsNestedYamlDeclarationWithoutReturningItsValue() throws Exception {
    Files.createDirectories(root.resolve("src/main/resources"));
    Files.writeString(
        root.resolve("src/main/resources/application.yml"),
        "payment:\n  api:\n    token: a-secret-value\n");
    var result =
        lookup(
            "App.java",
            "@Value(\"${payment.api.token:default}\") String token;",
            "payment.api.token");
    assertEquals(
        List.of(new IdeService.Location("src/main/resources/application.yml", 3, 5, 3, 10)),
        result.locations());
    assertFalse(result.toString().contains("a-secret-value"));
    assertTrue(result.notice().contains("runtime values are not resolved"));
    assertNull(
        lookup("App.java", "@Value(\"${payment.api.token:default}\") String token;", "default"));
  }

  @Test
  void allProfilesDocumentsAndExactPropertiesKeysAreReturned() throws Exception {
    Files.writeString(
        root.resolve("application.yml"), "server:\n  port: 8080\n---\nserver.port: 8081\n");
    Files.writeString(root.resolve("application-local.yaml"), "server: { port: 8082 }\n");
    Files.writeString(
        root.resolve("application.properties"), "server.port.extra=wrong\nserver\\.port=8083\n");
    var result = lookup("App.java", "@Value(\"${server.port:80}\") int port;", "server.port");
    assertEquals(4, result.locations().size(), result.toString());
    assertTrue(result.notice().contains("Multiple configuration declarations"));
    assertTrue(
        result.locations().stream()
            .anyMatch(item -> item.path().equals("application.properties") && item.line() == 2));
  }

  @Test
  void uncommonProfileNamesDoNotMakeTheBaseDeclarationFalselyUnique() throws Exception {
    Files.writeString(root.resolve("application.yml"), "server.port: 8080\n");
    Files.writeString(root.resolve("application-prod.eu.yml"), "server.port: 8081\n");
    Files.writeString(root.resolve("application-tenant+blue.properties"), "server.port=8082\n");
    Files.writeString(root.resolve("application-local.yml.bak"), "server.port: ignored\n");
    Files.writeString(root.resolve("other.yml"), "server.port: ignored\n");
    var result = lookup("App.java", "@Value(\"${server.port}\")", "server.port");
    assertEquals(
        List.of("application-prod.eu.yml", "application-tenant+blue.properties", "application.yml"),
        result.locations().stream().map(IdeService.Location::path).toList());
    assertTrue(result.notice().contains("Multiple configuration declarations"));
    assertFalse(
        result.selectionRequired(), "Complete scan presents all three declarations as choices");
  }

  @Test
  void yamlAndPropertiesPlaceholdersAndLiteralPropertyCallsNavigate() throws Exception {
    Files.writeString(root.resolve("application.yml"), "client:\n  timeout: 20\n");
    assertEquals(
        1,
        lookup("other.yaml", "timeout: ${client.timeout:10}", "client.timeout").locations().size());
    assertEquals(
        1,
        lookup("other.properties", "timeout=${client.timeout:10}", "client.timeout")
            .locations()
            .size());
    for (String call : List.of("getProperty", "getRequiredProperty"))
      assertEquals(
          1,
          lookup(
                  "App.java",
                  "env." + call + "(\"client.timeout\", Integer.class);",
                  "client.timeout")
              .locations()
              .size());
    assertEquals(
        1,
        lookup("App.kt", "env.getProperty(\"client.timeout\")", "client.timeout")
            .locations()
            .size());
    assertNull(lookup("App.java", "env.getProperty(key);", "key"));
    assertNull(lookup("App.java", "env.getProperty(\"client.\" + timeout);", "timeout"));
    assertNull(lookup("App.java", "env.getProperty(\"client.\" + timeout);", "client."));
    assertNull(lookup("App.kt", "val message = \"${local}\"", "local"));
    assertEquals(
        1,
        lookup("App.kt", "@Value(\"\\${client.timeout}\")", "client.timeout").locations().size());
  }

  @Test
  void typescriptTemplatesShellSubstitutionsAndOrdinaryIdentifiersStayWithLanguageServer()
      throws Exception {
    for (String extension : List.of("ts", "js", "sh", "py"))
      assertNull(lookup("app." + extension, "const text = `${local}`;", "local"));
    assertNull(lookup("App.java", "int value = CONSTANT;", "CONSTANT"));
    assertNull(lookup("App.java", "@Value(\"${" + "a".repeat(257) + "}\")", "aaa"));
  }

  @Test
  void scanDoesNotFollowLinksOrSearchDependencyAndBuildFolders(@TempDir Path external)
      throws Exception {
    Files.writeString(external.resolve("application.yml"), "sample:\n  key: secret\n");
    Files.createSymbolicLink(root.resolve("external"), external);
    Files.createSymbolicLink(root.resolve("application.yml"), external.resolve("application.yml"));
    for (String folder : List.of(".git", ".argus-data", "target", "build", "node_modules")) {
      Files.createDirectory(root.resolve(folder));
      Files.writeString(root.resolve(folder).resolve("application.yml"), "sample.key: ignored\n");
    }
    var result = lookup("App.java", "@Value(\"${sample.key}\")", "sample.key");
    assertTrue(result.locations().isEmpty());
  }

  @Test
  void malformedAndOversizedConfigurationsAreSkippedWithoutLeakingParserValues() throws Exception {
    Files.writeString(root.resolve("application.yml"), "token: [private-secret\n");
    Files.writeString(root.resolve("application-big.properties"), "token=" + "x".repeat(300000));
    var result = lookup("App.java", "@Value(\"${token}\")", "token");
    assertTrue(result.locations().isEmpty());
    assertTrue(result.notice().contains("unsupported"));
    assertFalse(result.toString().contains("private-secret"));
  }

  @Test
  void recursiveAliasesRequireSelectionAndIndexedKeysAreExact() throws Exception {
    Files.writeString(root.resolve("application-alias.yml"), "loop: &loop { child: *loop }\n");
    Files.writeString(root.resolve("application.yml"), "clients:\n  - url: one\n  - url: two\n");
    var result = lookup("App.java", "@Value(\"${clients[1].url}\")", "clients[1].url");
    assertEquals(
        List.of(new IdeService.Location("application.yml", 3, 5, 3, 8)), result.locations());
    assertTrue(result.selectionRequired(), "An unsupported file can hide additional declarations");
  }

  @Test
  void continuedPropertyValuesKeepTheirDeclarationButContinuedKeysNeedSelection() throws Exception {
    Files.writeString(root.resolve("application.properties"), "client.timeout=one\\\n two\n");
    var result = lookup("App.java", "@Value(\"${client.timeout}\")", "client.timeout");
    assertEquals(
        List.of(new IdeService.Location("application.properties", 1, 1, 1, 15)),
        result.locations());
    assertFalse(result.selectionRequired());
    Files.writeString(root.resolve("application-local.properties"), "client.\\\n timeout=other\n");
    assertTrue(
        lookup("App.java", "@Value(\"${client.timeout}\")", "client.timeout").selectionRequired());
  }

  @Test
  void partialScanRetainsKnownLocationButRequiresExplicitSelection() throws Exception {
    Files.writeString(root.resolve("application.yml"), "token: valid\n");
    Files.writeString(root.resolve("application-local.yml"), "token: [private-value\n");
    var result = lookup("App.java", "@Value(\"${token}\")", "token");
    assertEquals(1, result.locations().size());
    assertTrue(result.selectionRequired());
    assertTrue(result.notice().contains("unsupported"));
  }

  @Test
  void scalarSequenceDeclarationsUseItemLocation() throws Exception {
    Files.writeString(root.resolve("application.yml"), "servers: [one, two]\n");
    var result = lookup("App.java", "@Value(\"${servers[1]}\")", "servers[1]");
    assertEquals(
        List.of(new IdeService.Location("application.yml", 1, 16, 1, 19)), result.locations());
  }

  @Test
  void propertiesCrLfContinuationsAndCommentBackslashesDoNotInventOrHideKeys() throws Exception {
    Files.writeString(
        root.resolve("application.properties"), "message=hello\\\r\nserver.port=8080\r\n");
    assertTrue(
        lookup("App.java", "@Value(\"${server.port}\")", "server.port").locations().isEmpty());
    Files.writeString(root.resolve("application.properties"), "# comment\\\nserver.port=8080\n");
    assertEquals(
        List.of(new IdeService.Location("application.properties", 2, 1, 2, 12)),
        lookup("App.java", "@Value(\"${server.port}\")", "server.port").locations());
    Files.writeString(root.resolve("application.properties"), "server.port\u2002extra=8080\n");
    assertTrue(
        lookup("App.java", "@Value(\"${server.port}\")", "server.port").locations().isEmpty());
  }

  @Test
  void serviceChecksSnapshotAndDoesNotStartWorkersForConfigurationReferences() throws Exception {
    String source = "@Value(\"${server.port:8080}\") int port;";
    Files.writeString(root.resolve("App.java"), source);
    Files.writeString(root.resolve("application.yml"), "server.port: 9090\n");
    var workspace = mock(WorkspaceService.class);
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Repo", root.toString(), ""));
    var servers = mock(IdeLanguageServers.class);
    var service = new IdeService(workspace, files, servers, new ObjectMapper());
    String hash = files.read(root, "App.java").contentHash();
    for (String kind : List.of("definition", "declaration"))
      assertEquals(
          1,
          service
              .navigate("repo", "App.java", 1, source.indexOf("server.port") + 1, kind, hash)
              .locations()
              .size());
    Files.writeString(root.resolve("App.java"), source + " // changed");
    assertThrows(
        ConflictException.class,
        () -> service.navigate("repo", "App.java", 1, 11, "definition", hash));
    verifyNoInteractions(servers);
  }
}
