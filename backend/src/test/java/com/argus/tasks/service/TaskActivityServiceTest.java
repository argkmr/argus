package com.argus.tasks.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.common.error.ConflictException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

class TaskActivityServiceTest {
  @Test
  void cancellationBarrierBlocksNewResponsesButLetsTheExistingResponseDrain() throws Exception {
    var activity = new TaskActivityService();
    var running = activity.reserve("chat-one");
    try (var barrier = activity.preventNewActivity("chat-one")) {
      assertThat(activity.busy("chat-one")).isTrue();
      assertThat(barrier.responseBusy()).isTrue();
      assertThatThrownBy(() -> activity.reserve("chat-one")).isInstanceOf(ConflictException.class);
      assertThatThrownBy(() -> activity.preventNewActivity("chat-one"))
          .isInstanceOf(ConflictException.class);
      try (var unrelated = activity.reserve("chat-two")) {
        assertThat(activity.busy("chat-two")).isTrue();
      }
      running.close();
      barrier.awaitResponseRelease(100);
      assertThat(barrier.responseBusy()).isFalse();
      assertThat(activity.busy("chat-one")).isTrue();
      assertThatThrownBy(() -> activity.reserve("chat-one")).isInstanceOf(ConflictException.class);
    } finally {
      running.close();
    }
    assertThat(activity.busy("chat-one")).isFalse();
    try (var next = activity.reserve("chat-one")) {
      assertThat(activity.busy("chat-one")).isTrue();
    }
  }

  @Test
  void releaseWakesTheWaitingCancellationAndRepeatedClosesCannotUnlockLaterWork() throws Exception {
    var activity = new TaskActivityService();
    var running = activity.reserve("chat");
    var barrier = activity.preventNewActivity("chat");
    var waiting = new CountDownLatch(1);
    var finished =
        CompletableFuture.runAsync(
            () -> {
              waiting.countDown();
              try {
                barrier.awaitResponseRelease(2_000);
              } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(error);
              }
            });
    try {
      assertThat(waiting.await(1, TimeUnit.SECONDS)).isTrue();
      running.close();
      finished.get(1, TimeUnit.SECONDS);
      barrier.close();
      try (var next = activity.reserve("chat")) {
        running.close();
        barrier.close();
        assertThat(activity.busy("chat")).isTrue();
        assertThatThrownBy(() -> activity.reserve("chat")).isInstanceOf(ConflictException.class);
      }
    } finally {
      running.close();
      barrier.close();
    }
  }

  @Test
  void timeoutDoesNotReleaseTheBarrierOrPretendTheOriginalResponseHasStopped() throws Exception {
    var activity = new TaskActivityService();
    try (var running = activity.reserve("chat");
        var barrier = activity.preventNewActivity("chat")) {
      assertThatThrownBy(() -> barrier.awaitResponseRelease(1))
          .isInstanceOf(ConflictException.class);
      assertThat(barrier.responseBusy()).isTrue();
      assertThatThrownBy(() -> activity.reserve("chat")).isInstanceOf(ConflictException.class);
      running.close();
      assertThat(barrier.responseBusy()).isFalse();
      assertThatThrownBy(() -> activity.reserve("chat")).isInstanceOf(ConflictException.class);
    }
    assertThat(activity.busy("chat")).isFalse();
  }

  @Test
  void queuedPreparationCannotCrossCancellationEvenAfterTheBarrierHasClosed() {
    var activity = new TaskActivityService();
    long prepared = activity.queueEpoch("chat");
    var saved = new java.util.concurrent.atomic.AtomicInteger();
    try (var barrier = activity.preventNewActivity("chat")) {
      assertThatThrownBy(() -> activity.queueEpoch("chat")).isInstanceOf(ConflictException.class);
      assertThatThrownBy(
              () -> activity.acceptQueuedPrompt("chat", prepared, saved::incrementAndGet))
          .isInstanceOf(ConflictException.class);
    }
    assertThatThrownBy(() -> activity.acceptQueuedPrompt("chat", prepared, saved::incrementAndGet))
        .isInstanceOf(ConflictException.class);
    assertThat(saved).hasValue(0);
    long explicitlyRetried = activity.queueEpoch("chat");
    assertThat(explicitlyRetried).isNotEqualTo(prepared);
    assertThat(activity.acceptQueuedPrompt("chat", explicitlyRetried, saved::incrementAndGet))
        .isEqualTo(1);
  }

  @Test
  void queueAdmissionStillWorksAlongsideResponsesAndCancellationIsChatScoped() {
    var activity = new TaskActivityService();
    long unaffected = activity.queueEpoch("other-chat");
    try (var running = activity.reserve("chat")) {
      long current = activity.queueEpoch("chat");
      assertThat(activity.acceptQueuedPrompt("chat", current, () -> "queued while working"))
          .isEqualTo("queued while working");
      try (var barrier = activity.preventNewActivity("chat")) {
        assertThat(activity.acceptQueuedPrompt("other-chat", unaffected, () -> "unaffected"))
            .isEqualTo("unaffected");
      }
    }
    assertThat(activity.queueEpoch("other-chat")).isEqualTo(unaffected);
  }
}
