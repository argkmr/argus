package com.argus.apiclient.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.NotFoundException;
import com.argus.common.storage.AtomicJsonStore;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

class ApiRequestHistoryServiceTest {
  @TempDir Path root;
  final ObjectMapper mapper = new ObjectMapper();
  final MutableClock clock = new MutableClock();

  ApiRequestHistoryService service() {
    return service(new AtomicJsonStore(mapper));
  }

  ApiRequestHistoryService service(AtomicJsonStore store) {
    return new ApiRequestHistoryService(store, new ArgusProperties(root, root, "test", ""), clock);
  }

  ObjectNode payload(String id, String kind) {
    ObjectNode payload = mapper.createObjectNode();
    if (id != null) payload.put("id", id);
    ObjectNode snapshot = payload.putObject("snapshot");
    snapshot.put("version", 1);
    snapshot.put("kind", kind);
    snapshot.put("environmentId", "local-environment-id");
    snapshot
        .putObject("request")
        .put("name", "My draft")
        .put("method", "POST")
        .put("url", "{{HOST}}/unfinished/");
    snapshot
        .putObject("editor")
        .put("headers", "{ incomplete: \"value")
        .put("body", "Can't \u0026 shouldn't be escaped\n\"unfinished");
    snapshot.putNull("response");
    return payload;
  }

  @Test
  void draftsSurviveRestartWithIncompleteEditorValuesAndWithoutCreatingACollection()
      throws Exception {
    var service = service();
    assertThat(service.list()).isEmpty();
    assertThat(root.resolve("api-request-history")).doesNotExist();
    var submitted = payload(null, "draft");
    ((ObjectNode) submitted.path("snapshot").path("request"))
        .putObject("metadata")
        .putArray("nested")
        .add("secret-header-value")
        .addNull()
        .add(123456789012345L);
    var saved = service.save(submitted);
    assertThat(saved.kind()).isEqualTo("draft");
    assertThat(saved.url()).isEqualTo("{{HOST}}/unfinished/");
    assertThat(saved.status()).isNull();
    assertThat(service().get(saved.id()).snapshot()).isEqualTo(submitted.get("snapshot"));
    assertThat(service().list()).containsExactly(saved);
    try (var files = Files.list(root)) {
      assertThat(files.map(path -> path.getFileName().toString()).toList())
          .containsExactly("api-request-history");
    }
    assertThat(
            Files.getPosixFilePermissions(
                root.resolve("api-request-history").resolve(saved.id() + ".json")))
        .isEqualTo(Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
  }

  @Test
  void updatingAnInFlightRequestKeepsIdentityAndCreationTimeAndLoadsNewestFirst() {
    var service = service();
    var first = service.save(payload(null, "draft"));
    clock.advanceMillis(500);
    var second = service.save(payload(null, "draft"));
    assertThat(service.list()).containsExactly(second, first);
    clock.advanceMillis(500);
    var completion = payload(first.id(), "sent");
    ((ObjectNode) completion.path("snapshot"))
        .putObject("response")
        .put("status", 500)
        .put("body", "{\"error\":\"Can't fulfil\"}")
        .putObject("headers")
        .put("authorization", "private-response-header");
    var updated = service.save(completion);
    assertThat(updated.id()).isEqualTo(first.id());
    assertThat(updated.createdAt()).isEqualTo(first.createdAt());
    assertThat(updated.updatedAt()).isNotEqualTo(first.updatedAt());
    assertThat(updated.status()).isEqualTo(500);
    assertThat(service.list()).containsExactly(updated, second);
    assertThat(mapper.writeValueAsString(service.list()))
        .doesNotContain("private-response-header", "Can't fulfil", "headers", "editor", "snapshot");
  }

  @Test
  void inputAndReturnedTreesCannotMutateStoredSnapshots() {
    var service = service();
    var input = payload(null, "draft");
    var saved = service.save(input);
    ((ObjectNode) input.path("snapshot").path("request")).put("name", "Mutation");
    var retrieved = service.get(saved.id());
    ((ObjectNode) retrieved.snapshot().path("request")).put("name", "Other mutation");
    assertThat(service.get(saved.id()).snapshot().path("request").path("name").asText())
        .isEqualTo("My draft");
    assertThat(service.list().get(0).name()).isEqualTo("My draft");
  }

  @Test
  void failedPersistenceDoesNotPublishNewMetadataOrOverwriteThePreviousEntry() {
    class FailingStore extends AtomicJsonStore {
      boolean fail;

      FailingStore() {
        super(mapper);
      }

      @Override
      public void write(Path path, Object value) {
        if (fail) throw new IllegalStateException("Disk full");
        super.write(path, value);
      }
    }
    var store = new FailingStore();
    var service = service(store);
    var input = payload(null, "draft");
    var saved = service.save(input);
    store.fail = true;
    clock.advanceMillis(500);
    assertThatThrownBy(() -> service.save(payload(saved.id(), "failed"))).hasMessage("Disk full");
    assertThat(service.list()).containsExactly(saved);
    assertThat(service.get(saved.id()).snapshot()).isEqualTo(input.get("snapshot"));
    assertThatThrownBy(() -> service.save(payload(null, "draft"))).hasMessage("Disk full");
    assertThat(service.list()).containsExactly(saved);
  }

  @Test
  void concurrentWritesPreserveEverySnapshotAndNothingIsEvicted() throws Exception {
    var service = service();
    var pool = Executors.newFixedThreadPool(6);
    try {
      var futures = new ArrayList<java.util.concurrent.Future<String>>();
      for (int i = 0; i < 75; i++)
        futures.add(pool.submit(() -> service.save(payload(null, "draft")).id()));
      var ids = new ArrayList<String>();
      for (var future : futures) ids.add(future.get(20, TimeUnit.SECONDS));
      assertThat(ids).doesNotHaveDuplicates();
      assertThat(service().list()).hasSize(75);
      for (String id : ids) assertThat(service.get(id).id()).isEqualTo(id);
    } finally {
      pool.shutdownNow();
    }
  }

  @Test
  void malformedSnapshotsAndPathTraversalAreRejectedWithoutMutatingExistingData() {
    var service = service();
    var saved = service.save(payload(null, "draft"));
    for (String id : List.of("../outside", "1-1-1-1-1", "", "a/b", saved.id() + "/more")) {
      assertThatThrownBy(() -> service.save(payload(id, "draft")))
          .isInstanceOf(IllegalArgumentException.class);
      assertThatThrownBy(() -> service.get(id)).isInstanceOf(IllegalArgumentException.class);
      assertThatThrownBy(() -> service.delete(id)).isInstanceOf(IllegalArgumentException.class);
    }
    for (String malformed : List.of("null", "[]", "{}", "{\"id\":2,\"snapshot\":{}}"))
      assertThatThrownBy(() -> service.save(mapper.readTree(malformed)))
          .isInstanceOf(IllegalArgumentException.class);
    for (String field :
        List.of("version", "kind", "request", "editor", "environmentId", "response")) {
      var invalid = payload(saved.id(), "draft");
      ((ObjectNode) invalid.get("snapshot")).remove(field);
      assertThatThrownBy(() -> service.save(invalid)).isInstanceOf(IllegalArgumentException.class);
    }
    var invalid = payload(saved.id(), "draft");
    ((ObjectNode) invalid.get("snapshot")).put("version", 2);
    assertThatThrownBy(() -> service.save(invalid)).hasMessageContaining("version");
    assertThat(service.list()).containsExactly(saved);
  }

  @Test
  void onlyExplicitDeleteRemovesOneEntryAndMissingEntriesAre404s() {
    var service = service();
    var first = service.save(payload(null, "draft"));
    var second = service.save(payload(null, "draft"));
    assertThat(service.delete(first.id())).containsEntry("ok", true);
    assertThat(service().list()).containsExactly(second);
    assertThatThrownBy(() -> service.get(first.id())).isInstanceOf(NotFoundException.class);
    assertThatThrownBy(() -> service.delete(first.id())).isInstanceOf(NotFoundException.class);
  }

  @Test
  void symlinkedStorageAndFilesAreNeverReadWrittenOrDeleted() throws Exception {
    Path outside = Files.createDirectory(root.resolve("outside"));
    Path directory = root.resolve("api-request-history");
    Files.createSymbolicLink(directory, outside);
    assertThatThrownBy(() -> service().list()).hasMessageContaining("symbolic links");
    assertThatThrownBy(() -> service().save(payload(null, "draft")))
        .hasMessageContaining("symbolic links");
    Files.delete(directory);
    Files.createDirectory(directory);
    String id = UUID.randomUUID().toString();
    Path secret = outside.resolve("secret.json");
    Files.writeString(secret, "do not change");
    Files.createSymbolicLink(directory.resolve(id + ".json"), secret);
    assertThatThrownBy(() -> service().get(id)).hasMessageContaining("symbolic links");
    assertThatThrownBy(() -> service().save(payload(id, "draft")))
        .hasMessageContaining("symbolic links");
    assertThatThrownBy(() -> service().delete(id)).hasMessageContaining("symbolic links");
    assertThat(secret).hasContent("do not change");
  }

  @Test
  void corruptExistingEntriesAreNotSilentlyDiscardedOrReplaced() throws Exception {
    var service = service();
    var saved = service.save(payload(null, "draft"));
    Path file = root.resolve("api-request-history").resolve(saved.id() + ".json");
    Files.writeString(file, "broken data should be preserved");
    assertThatThrownBy(() -> service().list()).isInstanceOf(IllegalStateException.class);
    assertThatThrownBy(() -> service.save(payload(saved.id(), "sent")))
        .isInstanceOf(IllegalStateException.class);
    assertThat(file).hasContent("broken data should be preserved");
  }

  static class MutableClock extends Clock {
    Instant now = Instant.parse("2026-09-23T10:00:00Z");

    void advanceMillis(long millis) {
      now = now.plusMillis(millis);
    }

    @Override
    public ZoneId getZone() {
      return ZoneOffset.UTC;
    }

    @Override
    public Clock withZone(ZoneId zone) {
      return this;
    }

    @Override
    public Instant instant() {
      return now;
    }
  }
}
