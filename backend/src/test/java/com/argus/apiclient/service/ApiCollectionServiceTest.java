package com.argus.apiclient.service;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.apiclient.repository.ApiCollectionRepository;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.dto.WorkspaceResponse;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class ApiCollectionServiceTest {
  @TempDir Path temporary;

  ApiCollectionService service() {
    var workspace = mock(WorkspaceService.class);
    when(workspace.snapshot())
        .thenReturn(
            new WorkspaceResponse(1, "", Map.of(), List.of(), List.of(), List.of(), Map.of()));
    return new ApiCollectionService(
        new ApiCollectionRepository(
            temporary.resolve("collections"), new AtomicJsonStore(new ObjectMapper())),
        workspace);
  }

  @Test
  void importsNestedPostmanWithoutRunningScriptsAndRoundTripsMetadata() {
    var service = service();
    var repository = service.repository("standalone-api-client");
    var document =
        Map.of(
            "info",
            Map.of(
                "name",
                "Orders",
                "schema",
                "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"),
            "variable",
            List.of(Map.of("key", "base", "value", "https://example.test")),
            "event",
            List.of(
                Map.of(
                    "listen",
                    "prerequest",
                    "script",
                    Map.of("exec", List.of("throw new Error('must never run')")))),
            "item",
            List.of(
                Map.of(
                    "name",
                    "Read",
                    "item",
                    List.of(
                        Map.of(
                            "name",
                            "Fetch",
                            "request",
                            Map.of(
                                "method",
                                "GET",
                                "url",
                                "{{base}}/orders/:id?q=a&q=b",
                                "header",
                                List.of(
                                    Map.of(
                                        "key",
                                        "X-Disabled",
                                        "value",
                                        "never",
                                        "disabled",
                                        true))))))));
    var imported = service.importDocument(repository, document, "fallback", "");
    assertThat(imported).hasSize(1);
    assertThat(service.collections(repository))
        .extracting(item -> item.get("name"))
        .containsExactly("Orders", "Orders / Read");
    assertThat(imported.get(0).get("headers")).isEqualTo(Map.of());
    assertThat(ApiCollectionService.rows(imported.get(0).get("queryParams"))).hasSize(2);
    var exported = service.exportDocument(repository);
    assertThat(exported.get("event")).isEqualTo(document.get("event"));
    assertThat(ApiCollectionService.object(exported.get("info")).get("name")).isEqualTo("Orders");
    assertThat(service.requests(repository)).hasSize(1);
    var removed = service.removePath(repository, "Orders");
    assertThat(removed.get("deletedRequestCount")).isEqualTo(1);
    assertThat(service.requests(repository)).isEmpty();
  }

  @Test
  void storageRejectsEscapesAndSymlinksBeforeWrites() throws Exception {
    var service = service();
    var repository = service.repository("standalone-api-client");
    var collection = service.create(repository, null, Map.of("name", "Local"));
    var request =
        service.save(
            repository,
            null,
            Map.of(
                "name",
                "Example",
                "url",
                "https://example.test",
                "collectionId",
                collection.get("id")));
    assertThat(request.get("curl")).asString().contains("curl --request GET");
    assertThatThrownBy(
            () ->
                service.save(
                    repository,
                    null,
                    Map.of(
                        "id",
                        "../../escape",
                        "url",
                        "https://example.test",
                        "collectionId",
                        collection.get("id"))))
        .isInstanceOf(IllegalArgumentException.class);
    Path root = temporary.resolve("symlink-store");
    Files.createSymbolicLink(root, temporary.resolve("collections"));
    var storage = new ApiCollectionRepository(root, new AtomicJsonStore(new ObjectMapper()));
    assertThatThrownBy(() -> storage.files(repository))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("symbolic");
    assertThatThrownBy(() -> storage.delete(temporary.resolve("outside")))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void literalEnvironmentAndCurlParsingNeverEvaluateCommands() {
    String input =
        "A=one; export B=\"line\\nnext\"\nC='$(touch /tmp/not-executed)'\nJSON='{" + "\"x\":1}'";
    var parsed = EnvironmentFormat.parse(input);
    assertThat(parsed)
        .containsEntry("A", "one")
        .containsEntry("B", "line\nnext")
        .containsEntry("C", "$(touch /tmp/not-executed)");
    assertThat(EnvironmentFormat.parse(EnvironmentFormat.serialize(parsed))).isEqualTo(parsed);
    assertThat(EnvironmentFormat.parse("{\"a\":{\"b\":true},\"empty\":null}", "vault"))
        .containsEntry("a", "{\"b\":true}")
        .containsEntry("empty", "");
    var curl =
        CurlParser.parse(
            "curl -X POST 'https://example.test/a' -H 'X-Test: $(ignored)' --data-raw '@secret.json'");
    assertThat(curl.get("body")).isEqualTo("@secret.json");
    assertThat(curl.get("headers")).isEqualTo(Map.of("X-Test", "$(ignored)"));
  }

  @Test
  void offboardingPurgesOnlyItsManagedApiDirectoryNotSourceOrOtherCollections() throws Exception {
    var service = service();
    Path source = temporary.resolve("source");
    Files.createDirectories(source);
    Files.writeString(source.resolve("keep.txt"), "user source");
    var repository = new Repository("repo-1", "Repository", source.toString(), "");
    var collection = service.create(repository, null, Map.of("name", "Selected"));
    service.save(
        repository,
        null,
        Map.of("url", "https://example.test", "collectionId", collection.get("id")));
    var standalone = service.repository("standalone-api-client");
    service.create(standalone, null, Map.of("name", "Unrelated"));
    Files.createSymbolicLink(service.directory(repository).resolve("external-source"), source);
    assertThat(service.purgeRepository(repository))
        .containsEntry("apiCollectionDirectoryDeleted", true);
    assertThat(service.purgeRepository(repository))
        .containsEntry("apiCollectionDirectoryDeleted", false);
    assertThat(Files.readString(source.resolve("keep.txt"))).isEqualTo("user source");
    assertThat(service.collections(standalone)).hasSize(1);
  }
}
