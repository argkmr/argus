package com.argus.diagrams.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ConflictException;
import com.argus.common.error.NotFoundException;
import com.argus.common.storage.AtomicJsonStore;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

class DiagramDocumentServiceTest {
  @TempDir Path root;
  final ObjectMapper mapper = new ObjectMapper();
  final Clock clock = Clock.fixed(Instant.parse("2026-10-12T10:00:00Z"), ZoneOffset.UTC);

  DiagramDocumentService service() {
    return service(new AtomicJsonStore(mapper));
  }

  DiagramDocumentService service(AtomicJsonStore store) {
    return new DiagramDocumentService(
        new ArgusProperties(root, root, "test", ""), store, mapper, clock);
  }

  @Test
  void permanentlyDeletesOnlyTheSelectedActiveOrArchivedBoard() throws Exception {
    var service = service();
    var active = service.create(request());
    var archived = service.create(request().put("name", "Archived board"));
    var survivor = service.create(request().put("name", "Keep this board"));
    var archivedSummary = service.archive(archived.id(), archived.revision());
    byte[] kept = Files.readAllBytes(root.resolve("diagrams/" + survivor.id() + ".json"));

    service.deletePermanently(active.id(), active.revision());
    service.deletePermanently(archived.id(), archivedSummary.revision());

    assertThat(root.resolve("diagrams/" + active.id() + ".json")).doesNotExist();
    assertThat(root.resolve("diagrams/" + archived.id() + ".json")).doesNotExist();
    assertThat(service().list(true)).extracting(item -> item.id()).containsExactly(survivor.id());
    assertThat(Files.readAllBytes(root.resolve("diagrams/" + survivor.id() + ".json")))
        .isEqualTo(kept);
    assertThatThrownBy(() -> service.get(active.id())).isInstanceOf(NotFoundException.class);
    assertThatThrownBy(
            () -> service.restore(archived.id(), mapper.createObjectNode().put("revision", 2)))
        .isInstanceOf(NotFoundException.class);
  }

  @Test
  void deletionRejectsMissingOrStaleRevisionInvalidIdsAndSymlinks() throws Exception {
    var service = service();
    var board = service.create(request());
    var latest = service.update(board.id(), request().put("revision", board.revision()));
    Path file = root.resolve("diagrams/" + board.id() + ".json");
    byte[] kept = Files.readAllBytes(file);
    assertThatThrownBy(() -> service.deletePermanently(board.id(), null))
        .isInstanceOf(ConflictException.class);
    assertThatThrownBy(() -> service.deletePermanently(board.id(), board.revision()))
        .isInstanceOf(ConflictException.class);
    assertThatThrownBy(() -> service.deletePermanently("../workspace", 1L))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(Files.readAllBytes(file)).isEqualTo(kept);
    String linkId = UUID.randomUUID().toString();
    Files.createSymbolicLink(root.resolve("diagrams/" + linkId + ".json"), file);
    assertThatThrownBy(() -> service.deletePermanently(linkId, latest.revision()))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(Files.readAllBytes(file)).isEqualTo(kept);
  }

  ObjectNode request() {
    ObjectNode request = mapper.createObjectNode().put("name", " Order service ");
    ObjectNode snapshot = request.putObject("snapshot");
    ObjectNode structured = snapshot.putObject("structured");
    ArrayNode nodes = structured.putArray("nodes");
    nodes
        .addObject()
        .put("id", "class-a")
        .put("type", "umlClass")
        .putObject("data")
        .put("name", "Order")
        .putArray("fields")
        .add("- id: UUID");
    nodes.addObject().put("id", "class-b").put("type", "umlClass");
    structured
        .putArray("edges")
        .addObject()
        .put("id", "edge-a")
        .put("source", "class-a")
        .put("target", "class-b")
        .put("type", "bezier")
        .put("label", "places");
    structured.putObject("viewport").put("x", 0).put("y", 0).put("zoom", 1);
    ObjectNode sketch = snapshot.putObject("sketch");
    sketch
        .putArray("elements")
        .addObject()
        .put("id", "shape-a")
        .put("type", "rectangle")
        .putObject("customData")
        .put("futureField", "<script>inert text</script>");
    sketch.putObject("appState").put("viewBackgroundColor", "#ffffff");
    sketch
        .putObject("files")
        .putObject("image-a")
        .put("id", "image-a")
        .put("dataURL", "data:image/png;base64,aGVsbG8=")
        .put("mimeType", "image/png");
    sketch.putArray("libraryItems").addObject().put("id", "library-a").putArray("elements");
    return request;
  }

  @Test
  void savesIndependentPrivateFilesAndRoundTripsAllNestedSketchDataAfterRestart() throws Exception {
    var service = service();
    assertThat(service.list(false)).isEmpty();
    assertThat(root.resolve("diagrams")).doesNotExist();
    ObjectNode request = request();
    var document = service.create(request);
    assertThat(document.name()).isEqualTo("Order service");
    assertThat(document.revision()).isEqualTo(1);
    assertThat(document.schemaVersion()).isEqualTo(1);
    assertThat(document.createdAt()).isEqualTo(clock.instant().toString());
    assertThat(document.snapshot()).isEqualTo(request.get("snapshot"));
    assertThat(service().get(document.id())).isEqualTo(document);
    assertThat(service.list(false))
        .singleElement()
        .satisfies(
            summary -> {
              assertThat(summary.id()).isEqualTo(document.id());
              assertThat(mapper.valueToTree(summary).has("snapshot")).isFalse();
            });
    assertThat(
            Files.getPosixFilePermissions(
                root.resolve("diagrams").resolve(document.id() + ".json")))
        .isEqualTo(Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
    assertThat(Files.getPosixFilePermissions(root.resolve("diagrams")))
        .isEqualTo(
            Set.of(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE,
                PosixFilePermission.OWNER_EXECUTE));
    try (var files = Files.list(root)) {
      assertThat(files.map(path -> path.getFileName().toString()).toList())
          .containsExactly("diagrams");
    }
    ((ObjectNode) request.path("snapshot").path("sketch")).remove("files");
    assertThat(document.snapshot().path("sketch").has("files")).isTrue();
  }

  @Test
  void updatesRequireExactRevisionAndKeepOriginalIdentityAndCreationTime() throws Exception {
    var service = service();
    var first = service.create(request());
    var update = request().put("name", "Renamed diagram").put("revision", first.revision());
    var saved = service.update(first.id(), update);
    assertThat(saved.id()).isEqualTo(first.id());
    assertThat(saved.createdAt()).isEqualTo(first.createdAt());
    assertThat(saved.revision()).isEqualTo(2);
    byte[] durable = Files.readAllBytes(root.resolve("diagrams").resolve(first.id() + ".json"));
    assertThatThrownBy(() -> service.update(first.id(), update))
        .isInstanceOf(ConflictException.class);
    assertThatThrownBy(() -> service.update(first.id(), request()))
        .isInstanceOf(ConflictException.class);
    assertThat(Files.readAllBytes(root.resolve("diagrams").resolve(first.id() + ".json")))
        .isEqualTo(durable);
    assertThat(service().get(first.id())).isEqualTo(saved);
  }

  @Test
  void replicaGroupsAndEditableContainersSurviveSaveRestartAndArchive() {
    var service = service();
    var input = request();
    ArrayNode nodes = (ArrayNode) input.path("snapshot").path("structured").path("nodes");
    nodes
        .addObject()
        .put("id", "workers")
        .put("type", "component")
        .putObject("data")
        .put("name", "Workers")
        .put("componentKey", "worker")
        .put("replicas", 12);
    ObjectNode data =
        nodes
            .addObject()
            .put("id", "counts")
            .put("type", "dataStructure")
            .putObject("data")
            .put("name", "counts")
            .put("structureKind", "map")
            .put("implementation", "HashMap")
            .put("columns", 2)
            .put("activeEntryId", "entry-1");
    data.putArray("entries")
        .addObject()
        .put("id", "entry-1")
        .put("key", "key <1>")
        .put("value", "value & 2")
        .put("annotation", "visited");
    data.putArray("links");
    data.putArray("pointers")
        .addObject()
        .put("id", "pointer-1")
        .put("label", "current")
        .put("target", "entry-1");
    var saved = service.create(input);
    assertThat(service().get(saved.id()).snapshot()).isEqualTo(input.get("snapshot"));
    var archived = service.archive(saved.id(), saved.revision());
    var restored =
        service()
            .restore(saved.id(), mapper.createObjectNode().put("revision", archived.revision()));
    assertThat(restored.snapshot()).isEqualTo(saved.snapshot());
  }

  @Test
  void nestedContainerTypesAndValuesSurviveSaveRestartAndArchive() {
    var service = service();
    var input = request();
    ArrayNode nodes = (ArrayNode) input.path("snapshot").path("structured").path("nodes");
    ObjectNode data =
        nodes.addObject().put("id", "nested-map").put("type", "dataStructure").putObject("data");
    data.put("name", "groups")
        .put("structureKind", "map")
        .put("typeSignature", "Map<String, Map<String, ArrayList<String>>>");
    ObjectNode innerMap =
        data.putArray("entries")
            .addObject()
            .put("id", "outer-entry")
            .put("key", "region")
            .put("value", "")
            .putObject("valueContainer");
    innerMap
        .put("name", "Value")
        .put("structureKind", "map")
        .put("typeSignature", "Map<String, ArrayList<String>>");
    ObjectNode innerList =
        innerMap
            .putArray("entries")
            .addObject()
            .put("id", "map-entry")
            .put("key", "team")
            .put("value", "")
            .putObject("valueContainer");
    innerList
        .put("name", "Value")
        .put("structureKind", "list")
        .put("typeSignature", "ArrayList<String>")
        .put("activeEntryId", "list-entry");
    innerList
        .putArray("entries")
        .addObject()
        .put("id", "list-entry")
        .put("key", "")
        .put("value", "worker <1>")
        .put("annotation", "visited");
    innerList
        .putArray("pointers")
        .addObject()
        .put("id", "cursor")
        .put("label", "i")
        .put("target", "list-entry");
    var saved = service.create(input);
    assertThat(service().get(saved.id()).snapshot()).isEqualTo(input.get("snapshot"));
    var archived = service.archive(saved.id(), saved.revision());
    var restored =
        service()
            .restore(saved.id(), mapper.createObjectNode().put("revision", archived.revision()));
    assertThat(restored.snapshot()).isEqualTo(saved.snapshot());
  }

  @Test
  void concurrentEditsFromOneRevisionHaveOneWinner() throws Exception {
    var service = service();
    var first = service.create(request());
    var start = new CountDownLatch(1);
    var successes = new AtomicInteger();
    var conflicts = new AtomicInteger();
    var executor = Executors.newFixedThreadPool(2);
    try {
      var jobs =
          List.of(0, 1).stream()
              .map(
                  index ->
                      executor.submit(
                          () -> {
                            start.await();
                            try {
                              service.update(
                                  first.id(),
                                  request().put("name", "Edit " + index).put("revision", 1));
                              successes.incrementAndGet();
                            } catch (ConflictException expected) {
                              conflicts.incrementAndGet();
                            }
                            return true;
                          }))
              .toList();
      start.countDown();
      for (var job : jobs) job.get(5, TimeUnit.SECONDS);
      assertThat(successes.get()).isEqualTo(1);
      assertThat(conflicts.get()).isEqualTo(1);
      assertThat(service.get(first.id()).revision()).isEqualTo(2);
    } finally {
      executor.shutdownNow();
    }
  }

  @Test
  void archiveAndRestoreKeepTheCompleteSnapshotAndRejectStaleActions() {
    var service = service();
    var first = service.create(request());
    assertThatThrownBy(() -> service.archive(first.id(), 0L)).isInstanceOf(ConflictException.class);
    var archived = service.archive(first.id(), first.revision());
    assertThat(archived.archived()).isTrue();
    assertThat(archived.revision()).isEqualTo(2);
    assertThat(root.resolve("diagrams").resolve(first.id() + ".json")).exists();
    assertThat(service.list(false)).isEmpty();
    assertThat(service.list(true)).containsExactly(archived);
    assertThat(service.get(first.id()).snapshot()).isEqualTo(first.snapshot());
    assertThatThrownBy(() -> service.update(first.id(), request().put("revision", 2)))
        .isInstanceOf(ConflictException.class);
    assertThatThrownBy(
            () -> service.restore(first.id(), mapper.createObjectNode().put("revision", 1)))
        .isInstanceOf(ConflictException.class);
    var restored = service.restore(first.id(), mapper.createObjectNode().put("revision", 2));
    assertThat(restored.archived()).isFalse();
    assertThat(restored.revision()).isEqualTo(3);
    assertThat(restored.snapshot()).isEqualTo(first.snapshot());
    assertThat(service.list(false)).hasSize(1);
  }

  @Test
  void failedDurableWriteNeverPublishesNewContentOrRevision() {
    var first = service().create(request());
    var failing =
        new AtomicJsonStore(mapper) {
          @Override
          public void write(Path path, Object value) {
            throw new IllegalStateException("Simulated full disk");
          }
        };
    assertThatThrownBy(() -> service(failing).update(first.id(), request().put("revision", 1)))
        .isInstanceOf(IllegalStateException.class)
        .hasMessageContaining("full disk");
    assertThat(service().get(first.id())).isEqualTo(first);
    assertThatThrownBy(() -> service(failing).archive(first.id(), 1L))
        .isInstanceOf(IllegalStateException.class);
    assertThat(service().get(first.id())).isEqualTo(first);
  }

  @Test
  void unsafeIdsMissingDocumentsAndNonregularFilesAreRejected() throws Exception {
    var service = service();
    for (String id : List.of("../workspace", "1-1-1-1-1", "not-a-uuid", ""))
      assertThatThrownBy(() -> service.get(id)).isInstanceOf(IllegalArgumentException.class);
    String id = UUID.randomUUID().toString();
    assertThatThrownBy(() -> service.get(id)).isInstanceOf(NotFoundException.class);
    Files.createDirectories(root.resolve("diagrams").resolve(id + ".json"));
    assertThatThrownBy(() -> service.get(id)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> service.list(true)).isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void symbolicDocumentAndDirectoryTargetsAreRejectedWithoutTouchingTargets() throws Exception {
    Path external = Files.createDirectory(root.resolve("external"));
    Files.createSymbolicLink(root.resolve("diagrams"), external);
    assertThatThrownBy(() -> service().create(request()))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> service().list(true)).isInstanceOf(IllegalArgumentException.class);
    Files.delete(root.resolve("diagrams"));
    Files.createDirectory(root.resolve("diagrams"));
    String id = UUID.randomUUID().toString();
    Path source = Files.writeString(external.resolve("preserved.json"), "unchanged");
    Files.createSymbolicLink(root.resolve("diagrams").resolve(id + ".json"), source);
    assertThatThrownBy(() -> service().get(id)).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> service().archive(id, 1L))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(Files.readString(source)).isEqualTo("unchanged");
  }

  @Test
  void corruptAndUnsupportedFilesRemainIntact() throws Exception {
    var first = service().create(request());
    Path path = root.resolve("diagrams").resolve(first.id() + ".json");
    ObjectNode stored = (ObjectNode) mapper.valueToTree(first);
    stored.put("schemaVersion", 99);
    new AtomicJsonStore(mapper).write(path, stored);
    byte[] unsupported = Files.readAllBytes(path);
    assertThatThrownBy(() -> service().get(first.id())).isInstanceOf(IllegalStateException.class);
    assertThat(Files.readAllBytes(path)).isEqualTo(unsupported);
    Files.writeString(path, "{incomplete");
    assertThatThrownBy(() -> service().get(first.id())).isInstanceOf(IllegalStateException.class);
    assertThat(Files.readString(path)).isEqualTo("{incomplete");
  }

  @Test
  void namesShapeReferencesAndElementLimitsAreValidatedBeforeCreatingFiles() {
    for (String name : List.of(" ", "x".repeat(161), "line\nbreak"))
      assertThatThrownBy(() -> service().create(request().put("name", name)))
          .isInstanceOf(IllegalArgumentException.class);
    ObjectNode missing = request();
    ((ObjectNode) missing.path("snapshot").path("sketch")).remove("files");
    assertThatThrownBy(() -> service().create(missing))
        .isInstanceOf(IllegalArgumentException.class);
    ObjectNode brokenEdge = request();
    ((ObjectNode) brokenEdge.path("snapshot").path("structured").path("edges").get(0))
        .put("target", "absent");
    assertThatThrownBy(() -> service().create(brokenEdge))
        .isInstanceOf(IllegalArgumentException.class);
    for (String type : List.of("nodes", "edges", "elements")) {
      ObjectNode request = request();
      ObjectNode parent =
          (ObjectNode)
              request.path("snapshot").path(type.equals("elements") ? "sketch" : "structured");
      ArrayNode entries = parent.putArray(type);
      int max = type.equals("nodes") ? 2_000 : type.equals("edges") ? 5_000 : 10_000;
      for (int index = 0; index <= max; index++) entries.addObject().put("id", "item-" + index);
      assertThatThrownBy(() -> service().create(request))
          .isInstanceOf(IllegalArgumentException.class);
    }
    assertThat(root.resolve("diagrams")).doesNotExist();
  }

  @Test
  void oversizedAndOvernestedSnapshotsAreRejectedWithoutDiskMutation() {
    ObjectNode oversized = request();
    ((ObjectNode) oversized.path("snapshot"))
        .put("extra", "x".repeat(DiagramDocumentService.MAX_BYTES));
    assertThatThrownBy(() -> service().create(oversized))
        .isInstanceOf(ResponseStatusException.class)
        .satisfies(
            error ->
                assertThat(((ResponseStatusException) error).getStatusCode().value())
                    .isEqualTo(413));
    ObjectNode deep = request();
    ObjectNode cursor = (ObjectNode) deep.path("snapshot");
    for (int i = 0; i < 70; i++) cursor = cursor.putObject("nested");
    assertThatThrownBy(() -> service().create(deep)).isInstanceOf(IllegalArgumentException.class);
    assertThat(root.resolve("diagrams")).doesNotExist();
  }
}
