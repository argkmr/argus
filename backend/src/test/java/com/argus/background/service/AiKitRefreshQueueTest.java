package com.argus.background.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.common.storage.AtomicJsonStore;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class AiKitRefreshQueueTest {
  @TempDir Path directory;
  AtomicLong clock = new AtomicLong(1000);

  AiKitRefreshQueue queue() {
    return new AiKitRefreshQueue(new AtomicJsonStore(new ObjectMapper()), directory, clock::get);
  }

  @Test
  void disconnectRetainsFullPendingAndActiveRequestProvenanceAcrossRestart() {
    var queue = queue();
    queue.load();
    queue.request(List.of("a", "b"), false, Map.of("a", "revision-a", "b", "revision-b"));
    queue.claim("job", List.of("a"));
    queue.preserveRepositoryRequests(List.of("a", "b"));
    queue.cancel("job");
    queue.finish("job", List.of());
    var recovered = queue().load();
    var retained = (List<?>) recovered.get("disconnectedRequests");
    assertThat(retained).hasSize(2);
    assertThat(retained.toString())
        .contains("revision-a", "revision-b", "job", "pending", "active");
    assertThat(recovered.get("pendingRepositoryIds")).isEqualTo(List.of("b"));
  }

  @Test
  void coalescesRequestsAndRecoversOnlyUncancelledClaims() {
    var queue = queue();
    queue.load();
    queue.request(List.of("a", "b", "a"), false, Map.of("a", "rev1"));
    assertThat(queue.claim("job", List.of("a", "b"))).containsEntry("claimed", true);
    queue.request(List.of("a"), true, Map.of("a", "rev1"));
    assertThat(queue.snapshot().get("pendingRepositoryIds")).isEqualTo(List.of());
    queue.cancel("job");
    assertThat(queue.snapshot().get("activeRepositoryIds")).isEqualTo(List.of("a", "b"));
    var recovered = queue();
    assertThat(recovered.load().get("pendingRepositoryIds")).isEqualTo(List.of());
    recovered.request(List.of("a"), true, Map.of("a", "rev1"));
    assertThat(recovered.snapshot().get("pendingRepositoryIds")).isEqualTo(List.of());
    recovered.request(List.of("a"), true, Map.of("a", "rev2"));
    assertThat(recovered.snapshot().get("readyRepositoryIds")).isEqualTo(List.of("a"));
  }

  @Test
  void retriesAfterBackoffAndManualRequestOverridesDelay() {
    var queue = queue();
    queue.load();
    queue.request(List.of("a"), false, Map.of());
    queue.claim("job", List.of("a"));
    queue.finish("job", List.of("a"));
    assertThat(queue.snapshot().get("nextReadyAt")).isEqualTo(61000L);
    assertThat(queue.snapshot().get("readyRepositoryIds")).isEqualTo(List.of());
    queue.request(List.of("a"), false, Map.of());
    assertThat(queue.snapshot().get("readyRepositoryIds")).isEqualTo(List.of("a"));
  }

  @Test
  void invalidStateCannotBecomeLoadedAfterFirstFailure() throws Exception {
    Files.writeString(
        directory.resolve("ai-kit-refresh-queue.json"),
        "{\"version\":1,\"pending\":[],\"active\":{\"jobId\":\"job\",\"requests\":{}},\"cancelled\":[]}");
    var queue = queue();
    assertThatThrownBy(queue::load).isInstanceOf(IllegalStateException.class);
    assertThatThrownBy(queue::load).isInstanceOf(IllegalStateException.class);
  }

  @Test
  void restartRestoresClaimAndFailureDoesNotOverwriteNewerPendingRevision() {
    var queue = queue();
    queue.load();
    queue.request(List.of("a"), false, Map.of("a", "old"));
    queue.claim("job", List.of("a"));
    queue.request(List.of("a"), false, Map.of("a", "new"));
    var next = queue();
    assertThat(next.load().get("pendingRepositoryIds")).isEqualTo(List.of("a"));
    assertThat(next.snapshot().get("active")).isNull();
    assertThat(Files.exists(directory.resolve("ai-kit-refresh-queue.json"))).isTrue();
  }
}
