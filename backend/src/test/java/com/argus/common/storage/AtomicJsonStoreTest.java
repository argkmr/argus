package com.argus.common.storage;

import static org.assertj.core.api.Assertions.*;

import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class AtomicJsonStoreTest {
  @TempDir Path root;
  final AtomicJsonStore store = new AtomicJsonStore(new ObjectMapper());

  public static class SlowValue {
    final CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);

    public String getValue() throws InterruptedException {
      entered.countDown();
      if (!release.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("Fixture timed out");
      return "first";
    }
  }

  @Test
  void unrelatedWritesDoNotWaitForSlowSerialization() throws Exception {
    var executor = Executors.newFixedThreadPool(2);
    var slow = new SlowValue();
    Path first = root.resolve("slow.json");
    Path second = root.resolve("fast.json");
    assertThat((first.hashCode() & Integer.MAX_VALUE) % 64)
        .isNotEqualTo((second.hashCode() & Integer.MAX_VALUE) % 64);
    try {
      var firstWrite = executor.submit(() -> store.write(first, slow));
      assertThat(slow.entered.await(2, TimeUnit.SECONDS)).isTrue();
      executor
          .submit(() -> store.write(second, Map.of("value", "second")))
          .get(2, TimeUnit.SECONDS);
      assertThat(store.read(second, Map.class)).containsEntry("value", "second");
      assertThat(firstWrite.isDone()).isFalse();
      slow.release.countDown();
      firstWrite.get(2, TimeUnit.SECONDS);
      assertThat(store.read(first, Map.class)).containsEntry("value", "first");
    } finally {
      slow.release.countDown();
      executor.shutdownNow();
    }
  }

  @Test
  void sameNormalizedTargetKeepsWriteOrderingAndAtomicReplacement() throws Exception {
    var executor = Executors.newFixedThreadPool(2);
    var slow = new SlowValue();
    Path target = root.resolve("same.json");
    store.write(target, Map.of("value", "original"));
    try {
      var first = executor.submit(() -> store.write(target, slow));
      assertThat(slow.entered.await(2, TimeUnit.SECONDS)).isTrue();
      var attempted = new CountDownLatch(1);
      var second =
          executor.submit(
              () -> {
                attempted.countDown();
                store.write(root.resolve("child/../same.json"), Map.of("value", "last"));
              });
      assertThat(attempted.await(2, TimeUnit.SECONDS)).isTrue();
      assertThat(store.read(target, Map.class)).containsEntry("value", "original");
      assertThatThrownBy(() -> second.get(100, TimeUnit.MILLISECONDS))
          .isInstanceOf(TimeoutException.class);
      slow.release.countDown();
      first.get(2, TimeUnit.SECONDS);
      second.get(2, TimeUnit.SECONDS);
      assertThat(store.read(target, Map.class)).containsEntry("value", "last");
      try (var files = Files.list(root)) {
        assertThat(files.map(path -> path.getFileName().toString()).toList())
            .containsExactly("same.json");
      }
    } finally {
      slow.release.countDown();
      executor.shutdownNow();
    }
  }
}
