package com.argus.tasks.service;

import static com.argus.agents.domain.AgentValues.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.agents.service.RepositoryScopeService;
import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ConflictException;
import com.argus.common.error.NotFoundException;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.repository.PromptQueueRepository;
import com.argus.workspace.domain.Repository;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.*;
import java.util.concurrent.*;
import java.util.stream.IntStream;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

/** Durable queue regression matrix formerly exercised through prompt-queue-store.mjs. */
class NativePromptQueueParityTest {
  @TempDir Path root;
  final ObjectMapper mapper = new ObjectMapper();
  ArgusProperties properties;
  PromptQueueService queue;
  AiTask task;
  List<Map<String, Object>> attachments;

  @BeforeEach
  void setup() {
    properties = new ArgusProperties(root, null, "test", "");
    queue = reload();
    task = task("task-a", "repo-a", "repository");
    attachments =
        List.of(fields("id", "attachment-a", "name", "plan.pdf", "path", "/managed/plan.pdf"));
  }

  AiTask task(String id, String repository, String scope) {
    var value = new AiTask();
    value.id = id;
    value.repositoryId = repository;
    value.scope = scope;
    return value;
  }

  PromptQueueService reload() {
    return new PromptQueueService(
        new PromptQueueRepository(properties, new AtomicJsonStore(mapper), mapper), mapper);
  }

  @Test
  void disconnectPausesButPreservesRepositoryAndCrossRepositoryNexusPrompts() {
    queue.enqueue(task, request(task, "repo-prompt"), attachments);
    var global = task("nexus", "global", "global");
    var input = request(global, "nexus-prompt");
    input.put("repositoryIds", List.of("repo-a", "repo-b"));
    queue.enqueue(global, input, attachments);
    queue.pauseRepositories(List.of("repo-a"));
    var saved = reload().list(null);
    assertThat(saved).hasSize(2);
    for (var item : saved)
      assertThat(item)
          .containsEntry("prompt", "Do the work")
          .containsEntry("pauseReason", "repository-disconnected")
          .containsEntry("attachments", attachments);
    assertThat(saved.get(1)).containsEntry("repositoryIds", List.of("repo-a", "repo-b"));
    assertThat(reload().resumeTask(global.id).get(0)).doesNotContainKey("pauseReason");
    assertThat(reload().list(task.id).get(0))
        .containsEntry("pauseReason", "repository-disconnected");
  }

  Map<String, Object> request(AiTask value, String id) {
    return fields(
        "requestId",
        id,
        "taskId",
        value.id,
        "scope",
        value.scope,
        "repositoryId",
        value.repositoryId,
        "repositoryIds",
        List.of(),
        "prompt",
        "Do the work",
        "providerId",
        "codex",
        "providerName",
        "Codex",
        "mode",
        "edit",
        "contextMode",
        "fresh",
        "modelSettings",
        fields("model", "chosen", "effort", "high", "speed", "standard"),
        "attachmentIds",
        List.of("attachment-a"));
  }

  Map<String, Object> input(Map<String, Object> request) {
    var input = new LinkedHashMap<>(request);
    input.put("provider", request.get("providerId"));
    input.putAll(obj(request.get("modelSettings")));
    return input;
  }

  @Test
  void persistedQueueKeepsExactPromptSettingsAttachmentsAndPrivateMode() throws Exception {
    var request = request(task, "request-a");
    queue.enqueue(task, request, attachments);
    var saved = reload().list(task.id).get(0);
    assertThat(saved)
        .containsEntry("prompt", request.get("prompt"))
        .containsEntry("modelSettings", request.get("modelSettings"))
        .containsEntry("attachments", attachments)
        .containsEntry("status", "queued");
    assertThat(Files.getPosixFilePermissions(root.resolve("prompt-queue.json")))
        .isEqualTo(PosixFilePermissions.fromString("rw-------"));
  }

  @Test
  void concurrentEnqueueIsIdempotentAndOnlyOneClaimCanWin() throws Exception {
    var request = request(task, "request-a");
    var executor = Executors.newFixedThreadPool(2);
    try {
      var barrier = new CyclicBarrier(2);
      Callable<Map<String, Object>> enqueue =
          () -> {
            barrier.await();
            return queue.enqueue(task, request, attachments);
          };
      var first = executor.submit(enqueue);
      var second = executor.submit(enqueue);
      first.get(5, TimeUnit.SECONDS);
      second.get(5, TimeUnit.SECONDS);
      assertThat(queue.list(task.id)).hasSize(1);
      var changed = new LinkedHashMap<>(request);
      changed.put("prompt", "Different");
      assertThatThrownBy(() -> queue.enqueue(task, changed, attachments))
          .isInstanceOf(ConflictException.class);
      assertThat(queue.list(task.id).get(0)).containsEntry("prompt", "Do the work");
      Callable<Object> claim =
          () -> {
            barrier.await();
            try {
              return queue.claim("request-a");
            } catch (ConflictException error) {
              return error;
            }
          };
      var claimOne = executor.submit(claim);
      var claimTwo = executor.submit(claim);
      var outcomes = List.of(claimOne.get(5, TimeUnit.SECONDS), claimTwo.get(5, TimeUnit.SECONDS));
      assertThat(outcomes.stream().filter(Map.class::isInstance)).hasSize(1);
      var won = obj(outcomes.stream().filter(Map.class::isInstance).findFirst().orElseThrow());
      assertThatThrownBy(() -> queue.begin("request-a", "wrong", input(request)))
          .isInstanceOf(ConflictException.class);
      queue.begin("request-a", won.get("dispatchToken"), input(request));
      assertThatThrownBy(() -> queue.begin("request-a", won.get("dispatchToken"), input(request)))
          .isInstanceOf(ConflictException.class);
      assertThatThrownBy(() -> queue.remove("request-a")).isInstanceOf(ConflictException.class);
    } finally {
      executor.shutdownNow();
    }
  }

  @Test
  void everyExecutionFingerprintChangeFailsBeforeConsumingClaim() {
    var request = request(task, "request-a");
    queue.enqueue(task, request, attachments);
    var claim = queue.claim("request-a");
    for (var change :
        List.of(
            fields("prompt", "Changed"),
            fields("repositoryId", "repo-b"),
            fields("model", "different"),
            fields("attachmentIds", List.of()),
            fields("provider", "claude"),
            fields("effort", "low"),
            fields("contextMode", "history"))) {
      var changed = input(request);
      changed.putAll(change);
      assertThatThrownBy(() -> queue.begin("request-a", claim.get("dispatchToken"), changed))
          .isInstanceOf(IllegalArgumentException.class)
          .hasMessageContaining("settings changed");
      assertThat(queue.list(task.id).get(0)).containsEntry("attempted", false);
    }
    var changed = input(request);
    changed.put("requestId", "other-request");
    assertThatThrownBy(() -> queue.begin("request-a", claim.get("dispatchToken"), changed))
        .hasMessageContaining("ID changed");
    assertThatThrownBy(() -> queue.interrupted("request-a", "Lost response", null))
        .isInstanceOf(ConflictException.class);
    queue.begin("request-a", claim.get("dispatchToken"), input(request));
  }

  @Test
  void restartInterruptsClaimWithoutReplayAndCompletedReceiptsStayPrivate() throws Exception {
    var request = request(task, "request-a");
    queue.enqueue(task, request, attachments);
    var claim = queue.claim("request-a");
    var restarted = reload();
    assertThat(restarted.list(task.id).get(0)).containsEntry("status", "interrupted");
    assertThatThrownBy(() -> restarted.claim("request-a")).isInstanceOf(ConflictException.class);
    assertThatThrownBy(
            () -> restarted.begin("request-a", claim.get("dispatchToken"), input(request)))
        .isInstanceOf(ConflictException.class);
    restarted.remove("request-a");
    request.put("requestId", "request-b");
    restarted.enqueue(task, request, attachments);
    var next = restarted.claim("request-b");
    restarted.begin("request-b", next.get("dispatchToken"), input(request));
    restarted.started("request-b", "job");
    restarted.interrupted("request-b", "Late response", null);
    restarted.remove("request-b");
    assertThat(restarted.list(task.id)).isEmpty();
    var entries = mapper.readValue(Files.readString(root.resolve("prompt-queue.json")), List.class);
    var receipt = obj(entries.get(0));
    assertThat(receipt)
        .doesNotContainKeys("prompt", "attachments", "modelSettings", "attachmentIds");
    assertThat(text(receipt.get("receiptFingerprint"))).matches("[a-f0-9]{64}");
    var restored = reload();
    assertThat(restored.enqueue(task, request, attachments)).containsEntry("status", "started");
    request.put("prompt", "Changed");
    assertThatThrownBy(() -> restored.enqueue(task, request, attachments))
        .isInstanceOf(ConflictException.class);
    assertThatThrownBy(() -> restored.claim("request-b")).isInstanceOf(ConflictException.class);
    restored.purgeTasks(List.of(task.id));
    assertThat(Files.readString(root.resolve("prompt-queue.json"))).doesNotContain("request-b");
  }

  @Test
  void failedPersistenceDoesNotAcknowledgeEnqueueOrRetainItInMemory() {
    var json = spy(new AtomicJsonStore(mapper));
    var failing =
        new PromptQueueService(new PromptQueueRepository(properties, json, mapper), mapper);
    doThrow(new IllegalStateException("Disk full"))
        .when(json)
        .write(eq(root.resolve("prompt-queue.json")), any());
    assertThatThrownBy(() -> failing.enqueue(task, request(task, "request-a"), attachments))
        .hasMessageContaining("Disk full");
    assertThat(failing.list(task.id)).isEmpty();
    assertThat(Files.exists(root.resolve("prompt-queue.json"))).isFalse();
  }

  @Test
  void fifoIsPerTaskAndPurgeRemovesOnlyAffectedRequests() {
    queue.enqueue(task, request(task, "first"), attachments);
    queue.enqueue(task, request(task, "second"), attachments);
    var other = task("task-b", "repo-b", "repository");
    queue.enqueue(other, request(other, "other"), List.of());
    assertThatThrownBy(() -> queue.claim("second")).isInstanceOf(ConflictException.class);
    var first = queue.claim("first");
    assertThat(queue.claim("other")).containsEntry("status", "dispatching");
    queue.begin("first", first.get("dispatchToken"), input(request(task, "first")));
    queue.started("first", "job");
    assertThat(queue.claim("second")).containsEntry("status", "dispatching");
    queue.purgeRepositories(List.of("repo-a"));
    assertThat(queue.list(null)).hasSize(1);
    assertThat(queue.list(null).get(0)).containsEntry("taskId", other.id);
    queue.purgeTasks(List.of(other.id));
    assertThat(queue.list(null)).isEmpty();
  }

  @Test
  void questionCancellationPauseIsDurableScopedAndPreservesTheExactQueue() {
    var first = request(task, "first");
    var second = request(task, "second");
    second.put("prompt", "Continue with the second request");
    var other = task("task-b", "repo-b", "repository");
    var savedFirst = queue.enqueue(task, first, attachments);
    var savedSecond = queue.enqueue(task, second, attachments);
    var savedOther = queue.enqueue(other, request(other, "other"), List.of());

    var paused = queue.pauseTask(task.id, "question-a");
    assertThat(paused).extracting(item -> item.get("requestId")).containsExactly("first", "second");
    assertThat(paused.get(0)).containsAllEntriesOf(savedFirst);
    assertThat(paused.get(1)).containsAllEntriesOf(savedSecond);
    assertThat(paused)
        .allSatisfy(
            item ->
                assertThat(item)
                    .containsEntry("pauseReason", "question-cancelled")
                    .containsEntry("pausedQuestionId", "question-a")
                    .containsKey("pausedAt"));
    assertThat(queue.pauseTask(task.id, "question-a")).isEqualTo(paused);
    var restarted = reload();
    assertThat(restarted.list(task.id)).isEqualTo(paused);
    assertThat(restarted.list(other.id)).containsExactly(savedOther);
    assertThatThrownBy(() -> restarted.claim("first"))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("paused");
    assertThat(restarted.list(task.id)).isEqualTo(paused);
  }

  @Test
  void cancellationRetiresAnUnattemptedClaimAndExplicitResumeRequiresANewToken() {
    var request = request(task, "request-a");
    queue.enqueue(task, request, attachments);
    var claim = queue.claim("request-a");
    var token = claim.get("dispatchToken");
    queue.pauseTask(task.id, "question-a");
    assertThat(queue.list(task.id).get(0))
        .containsEntry("status", "queued")
        .containsEntry("attempted", false)
        .containsEntry("pauseReason", "question-cancelled")
        .doesNotContainKey("dispatchToken");
    assertThatThrownBy(() -> queue.begin("request-a", token, input(request)))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("paused");
    assertThat(queue.list(task.id).get(0)).containsEntry("attempted", false);

    var resumed = queue.resumeTask(task.id);
    assertThat(resumed.get(0))
        .containsEntry("status", "queued")
        .containsEntry("attempted", false)
        .doesNotContainKeys("pauseReason", "pausedQuestionId", "pausedAt", "dispatchToken");
    assertThatThrownBy(() -> queue.begin("request-a", token, input(request)))
        .isInstanceOf(ConflictException.class);
    var fresh = queue.claim("request-a");
    assertThat(fresh.get("dispatchToken")).isNotEqualTo(token);
    assertThatThrownBy(() -> queue.begin("request-a", token, input(request)))
        .isInstanceOf(ConflictException.class);
    assertThat(queue.list(task.id).get(0)).containsEntry("attempted", false);
    assertThat(queue.begin("request-a", fresh.get("dispatchToken"), input(request)))
        .containsEntry("attempted", true);
  }

  @Test
  void pauseAndResumeNeverReplayAttemptedOrInterruptedRequests() {
    var request = request(task, "request-a");
    queue.enqueue(task, request, attachments);
    var claim = queue.claim("request-a");
    queue.begin("request-a", claim.get("dispatchToken"), input(request));
    queue.enqueue(task, request(task, "request-b"), attachments);
    queue.pauseTask(task.id, "question-a");
    assertThat(queue.list(task.id).get(0))
        .containsEntry("status", "dispatching")
        .containsEntry("attempted", true)
        .containsEntry("dispatchToken", claim.get("dispatchToken"));
    assertThatThrownBy(() -> queue.begin("request-a", claim.get("dispatchToken"), input(request)))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("paused");
    queue.interrupted("request-a", "Stopped before completion", claim.get("dispatchToken"));
    var interrupted = queue.list(task.id).get(0);
    var restarted = reload();
    var resumed = restarted.resumeTask(task.id);
    assertThat(resumed.get(0)).isEqualTo(interrupted);
    assertThat(resumed.get(1))
        .containsEntry("status", "queued")
        .doesNotContainKeys("pauseReason", "pausedQuestionId", "pausedAt");
    assertThatThrownBy(() -> restarted.claim("request-a")).isInstanceOf(ConflictException.class);
    assertThatThrownBy(() -> restarted.claim("request-b"))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("earlier saved request");
    assertThat(restarted.list(task.id)).isEqualTo(resumed);
  }

  @Test
  void cancellationDoesNotResetAnAlreadyInterruptedUnattemptedClaim() {
    queue.enqueue(task, request(task, "request-a"), attachments);
    var claim = queue.claim("request-a");
    queue.interrupted("request-a", "Connection lost", claim.get("dispatchToken"));
    queue.pauseTask(task.id, "question-a");
    var interrupted = queue.list(task.id).get(0);
    assertThat(interrupted)
        .containsEntry("attempted", false)
        .containsEntry("status", "interrupted")
        .containsEntry("error", "Connection lost");
    assertThat(queue.resumeTask(task.id)).containsExactly(interrupted);
    assertThatThrownBy(() -> queue.claim("request-a")).isInstanceOf(ConflictException.class);
  }

  @Test
  void pausingLeavesStartedReceiptsUntouchedAndResumeRemainsScoped() {
    var request = request(task, "started");
    queue.enqueue(task, request, attachments);
    var claim = queue.claim("started");
    queue.begin("started", claim.get("dispatchToken"), input(request));
    var started = queue.started("started", "job-a");
    queue.enqueue(task, request(task, "pending"), attachments);
    var other = task("task-b", "repo-b", "repository");
    queue.enqueue(other, request(other, "other"), List.of());
    queue.pauseTask(task.id, "question-a");
    var otherPaused = queue.pauseTask(other.id, "question-b");
    var resumed = queue.resumeTask(task.id);
    assertThat(resumed).hasSize(1);
    assertThat(resumed.get(0))
        .containsEntry("requestId", "pending")
        .doesNotContainKeys("pauseReason", "pausedQuestionId", "pausedAt");
    assertThat(queue.enqueue(task, request, attachments)).isEqualTo(started);
    assertThat(queue.list(other.id)).isEqualTo(otherPaused);
    assertThat(reload().list(task.id)).isEqualTo(resumed);
  }

  @Test
  void newlyQueuedWorkCannotSkipAnOlderPausedRequest() {
    queue.enqueue(task, request(task, "first"), attachments);
    queue.pauseTask(task.id, "question-a");
    queue.enqueue(task, request(task, "second"), attachments);
    assertThat(queue.list(task.id).get(1)).doesNotContainKey("pauseReason");
    assertThatThrownBy(() -> queue.claim("second"))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("earlier saved request");
    queue.resumeTask(task.id);
    assertThat(queue.claim("first")).containsEntry("status", "dispatching");
  }

  @Test
  void failedPauseAndResumePersistenceNeverAcknowledgeAnInMemoryOnlyChange() {
    var json = spy(new AtomicJsonStore(mapper));
    var failing =
        new PromptQueueService(new PromptQueueRepository(properties, json, mapper), mapper);
    failing.enqueue(task, request(task, "request-a"), attachments);
    var before = failing.list(task.id);
    doThrow(new IllegalStateException("Disk full"))
        .when(json)
        .write(eq(root.resolve("prompt-queue.json")), any());
    assertThatThrownBy(() -> failing.pauseTask(task.id, "question-a"))
        .hasMessageContaining("Disk full");
    assertThat(failing.list(task.id)).isEqualTo(before);
    assertThat(reload().list(task.id)).isEqualTo(before);
    doCallRealMethod().when(json).write(eq(root.resolve("prompt-queue.json")), any());
    var paused = failing.pauseTask(task.id, "question-a");
    doThrow(new IllegalStateException("Disk full"))
        .when(json)
        .write(eq(root.resolve("prompt-queue.json")), any());
    assertThatThrownBy(() -> failing.resumeTask(task.id)).hasMessageContaining("Disk full");
    assertThat(failing.list(task.id)).isEqualTo(paused);
    assertThat(reload().list(task.id)).isEqualTo(paused);
  }

  @Test
  void cancellationQueueMutationsRequireAnExplicitTaskAndQuestion() {
    queue.enqueue(task, request(task, "request-a"), attachments);
    var before = queue.list(task.id);
    for (String invalid : Arrays.asList(null, "", " ")) {
      assertThatThrownBy(() -> queue.pauseTask(invalid, "question-a"))
          .isInstanceOf(IllegalArgumentException.class);
      assertThatThrownBy(() -> queue.pauseTask(task.id, invalid))
          .isInstanceOf(IllegalArgumentException.class);
      assertThatThrownBy(() -> queue.resumeTask(invalid))
          .isInstanceOf(IllegalArgumentException.class);
    }
    assertThat(queue.list(task.id)).isEqualTo(before);
  }

  @Test
  void nexusQueueFreezesMoreThanSixAndFailsClosedForMissingOrEmptySavedScope() {
    var nexus = task("task-a", "global", "global");
    var scopes = new RepositoryScopeService();
    var repositories =
        IntStream.range(0, 8)
            .mapToObj(
                index ->
                    new Repository(
                        "repo-" + index, "Repo " + index, "/fixture/" + index, "", "main"))
            .toList();
    var frozen = scopes.freeze(nexus, request(nexus, "nexus"), repositories);
    assertThat(list(frozen.get("repositoryIds"))).hasSize(8);
    queue.enqueue(nexus, frozen, attachments);
    var claim = queue.claim("nexus");
    var started = queue.begin("nexus", claim.get("dispatchToken"), input(frozen));
    var expanded = new ArrayList<>(repositories);
    expanded.add(new Repository("new-repo", "New", "/fixture/new", "", "main"));
    assertThat(scopes.queued(started, expanded, frozen.get("repositoryIds")).repositories())
        .isEqualTo(repositories);
    assertThatThrownBy(
            () -> scopes.queued(started, repositories.subList(1, 8), frozen.get("repositoryIds")))
        .hasMessageContaining("no longer connected");
    var empty = new LinkedHashMap<>(started);
    empty.put("repositoryIds", List.of());
    assertThatThrownBy(() -> scopes.queued(empty, repositories, List.of()))
        .hasMessageContaining("no safe saved");
  }

  @Test
  void interruptionWithoutThrowableMessageIsStillDurablyRecorded() {
    queue.enqueue(task, request(task, "request-a"), attachments);
    var claim = queue.claim("request-a");
    assertThat(queue.interrupted("request-a", new RuntimeException(), claim.get("dispatchToken")))
        .containsEntry("status", "interrupted")
        .containsEntry("error", "Dispatch interrupted");
  }

  @Test
  void queuedEditPreservesExactWhitespaceIdentityOrderAndAllFrozenSettings() {
    var first = queue.enqueue(task, request(task, "first"), attachments);
    var second = queue.enqueue(task, request(task, "second"), attachments);
    var edit =
        fields(
            "taskId", task.id,
            "expectedPrompt", "Do the work",
            "prompt", "  Revised\nwith spacing  ",
            "requestId", "other-request",
            "status", "started",
            "attachmentIds", List.of(),
            "repositoryId", "repo-b",
            "modelSettings", fields("model", "different"));
    var edited = queue.edit("second", edit);
    var expected = new LinkedHashMap<>(second);
    expected.put("prompt", edit.get("prompt"));
    expected.put("updatedAt", edited.get("updatedAt"));
    expected.put("enqueueFingerprint", queue.fingerprint(second));
    assertThat(edited).isEqualTo(expected);
    assertThat(edited.get("updatedAt")).isInstanceOf(String.class);
    assertThat(reload().list(task.id)).containsExactly(first, expected);
    assertThatThrownBy(() -> queue.claim("second")).isInstanceOf(ConflictException.class);
  }

  @Test
  void oldEnqueueRetryKeepsEditsAndOriginalReceiptIdentityAfterDispatchAndRestart()
      throws Exception {
    var original = request(task, "request-a");
    queue.enqueue(task, original, attachments);
    var first = queue.edit("request-a", edit("Do the work", "First revision"));
    var edited = queue.edit("request-a", edit("First revision", "Latest revision"));
    assertThat(edited.get("enqueueFingerprint")).isEqualTo(first.get("enqueueFingerprint"));
    queue = reload();
    assertThat(queue.enqueue(task, original, attachments)).isEqualTo(edited);
    var changedEnqueue = new LinkedHashMap<>(original);
    changedEnqueue.put("prompt", "Latest revision");
    assertThatThrownBy(() -> queue.enqueue(task, changedEnqueue, attachments))
        .isInstanceOf(ConflictException.class);

    var claimed = queue.claim("request-a");
    assertThat(claimed).containsEntry("prompt", "Latest revision");
    assertThatThrownBy(
            () -> queue.begin("request-a", claimed.get("dispatchToken"), input(original)))
        .hasMessageContaining("settings changed");
    assertThat(queue.list(task.id).get(0)).containsEntry("attempted", false);
    queue.begin("request-a", claimed.get("dispatchToken"), input(claimed));
    queue.started("request-a", "fixture-job");
    assertThat(queue.enqueue(task, original, attachments))
        .containsEntry("status", "started")
        .containsEntry("prompt", "Latest revision");
    queue.remove("request-a");
    queue = reload();
    assertThat(queue.enqueue(task, original, attachments))
        .containsEntry("status", "started")
        .containsEntry("jobId", "fixture-job");
    assertThatThrownBy(() -> queue.claim("request-a")).isInstanceOf(ConflictException.class);
    assertThat(Files.readString(root.resolve("prompt-queue.json")))
        .doesNotContain("Do the work", "First revision", "Latest revision", "attachment-a")
        .contains(queue.fingerprint(original));
  }

  @Test
  void staleForeignMissingAndNonQueuedEditsFailWithoutChangingSavedContent() {
    queue.enqueue(task, request(task, "request-a"), attachments);
    var before = queue.list(task.id);
    assertThatThrownBy(() -> queue.edit("request-a", edit("Stale prompt", "Replacement")))
        .isInstanceOf(ConflictException.class);
    var foreign = edit("Do the work", "Replacement");
    foreign.put("taskId", "other-chat");
    assertThatThrownBy(() -> queue.edit("request-a", foreign))
        .isInstanceOf(ConflictException.class);
    assertThatThrownBy(() -> queue.edit("missing", edit("Do the work", "Replacement")))
        .isInstanceOf(NotFoundException.class);
    assertThat(queue.list(task.id)).isEqualTo(before);
    assertThat(reload().list(task.id)).isEqualTo(before);

    var repository = new PromptQueueRepository(properties, new AtomicJsonStore(mapper), mapper);
    var guarded = new PromptQueueService(repository, mapper);
    for (String status : List.of("claimed", "dispatching", "started", "interrupted")) {
      repository.mutate(
          items -> {
            items.get(0).put("status", status);
            return true;
          });
      assertThatThrownBy(() -> guarded.edit("request-a", edit("Do the work", "Replacement")))
          .isInstanceOf(ConflictException.class);
      assertThat(repository.list().get(0))
          .containsEntry("status", status)
          .containsEntry("prompt", "Do the work")
          .doesNotContainKey("enqueueFingerprint");
    }
  }

  @Test
  void invalidQueuedEditInputCannotAlterOrClaimTheRequest() {
    queue.enqueue(task, request(task, "request-a"), attachments);
    var before = queue.list(task.id);
    for (Object prompt : List.of("", " \n", "x".repeat(100_001), 123, List.of("text"))) {
      var invalid = edit("Do the work", "Replacement");
      invalid.put("prompt", prompt);
      assertThatThrownBy(() -> queue.edit("request-a", invalid))
          .isInstanceOf(IllegalArgumentException.class);
    }
    for (String missing : List.of("taskId", "expectedPrompt", "prompt")) {
      var invalid = edit("Do the work", "Replacement");
      invalid.remove(missing);
      assertThatThrownBy(() -> queue.edit("request-a", invalid))
          .isInstanceOf(IllegalArgumentException.class);
    }
    assertThatThrownBy(() -> queue.edit("request-a", null))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(queue.list(task.id)).isEqualTo(before);
    assertThat(queue.claim("request-a")).containsEntry("prompt", "Do the work");
  }

  @Test
  void failedEditOrDeletePersistenceLeavesBothDiskAndMemoryUnchanged() throws Exception {
    var store = spy(new AtomicJsonStore(mapper));
    var saved =
        new PromptQueueService(new PromptQueueRepository(properties, store, mapper), mapper);
    saved.enqueue(task, request(task, "request-a"), attachments);
    String before = Files.readString(root.resolve("prompt-queue.json"));
    doThrow(new IllegalStateException("Disk full"))
        .when(store)
        .write(eq(root.resolve("prompt-queue.json")), any());
    assertThatThrownBy(() -> saved.edit("request-a", edit("Do the work", "Replacement")))
        .hasMessageContaining("Disk full");
    assertThatThrownBy(() -> saved.remove("request-a")).hasMessageContaining("Disk full");
    assertThat(saved.list(task.id).get(0))
        .containsEntry("prompt", "Do the work")
        .containsEntry("status", "queued")
        .doesNotContainKeys("enqueueFingerprint", "updatedAt");
    assertThat(Files.readString(root.resolve("prompt-queue.json"))).isEqualTo(before);
    assertThat(reload().list(task.id)).isEqualTo(saved.list(task.id));
    doCallRealMethod().when(store).write(eq(root.resolve("prompt-queue.json")), any());
    assertThat(saved.edit("request-a", edit("Do the work", "Replacement")))
        .containsEntry("prompt", "Replacement");
  }

  @Test
  void concurrentEditsUseAnAtomicExpectedPromptComparison() throws Exception {
    queue.enqueue(task, request(task, "request-a"), attachments);
    var executor = Executors.newFixedThreadPool(2);
    var barrier = new CyclicBarrier(2);
    try {
      var first = executor.submit(() -> concurrentEdit(barrier, "request-a", "First revision"));
      var second = executor.submit(() -> concurrentEdit(barrier, "request-a", "Second revision"));
      var outcomes = List.of(first.get(5, TimeUnit.SECONDS), second.get(5, TimeUnit.SECONDS));
      assertThat(outcomes.stream().filter(Map.class::isInstance)).hasSize(1);
      assertThat(outcomes.stream().filter(ConflictException.class::isInstance)).hasSize(1);
      var winner = obj(outcomes.stream().filter(Map.class::isInstance).findFirst().orElseThrow());
      assertThat(queue.list(task.id)).containsExactly(winner);
      assertThat(reload().list(task.id)).containsExactly(winner);
    } finally {
      executor.shutdownNow();
    }
  }

  @Test
  void concurrentEditAndClaimEitherFreezeTheEditOrRejectItBeforeDispatch() throws Exception {
    var executor = Executors.newFixedThreadPool(2);
    try {
      for (int index = 0; index < 10; index++) {
        var chat = task("race-chat-" + index, "repo-a", "repository");
        String id = "race-request-" + index;
        queue.enqueue(chat, request(chat, id), attachments);
        var barrier = new CyclicBarrier(2);
        var editInput =
            fields("taskId", chat.id, "expectedPrompt", "Do the work", "prompt", "Revised");
        Future<Object> edit =
            executor.submit(
                () -> {
                  barrier.await();
                  try {
                    return queue.edit(id, editInput);
                  } catch (ConflictException error) {
                    return error;
                  }
                });
        var claim =
            executor.submit(
                () -> {
                  barrier.await();
                  return queue.claim(id);
                });
        Object editResult = edit.get(5, TimeUnit.SECONDS);
        var claimed = claim.get(5, TimeUnit.SECONDS);
        assertThat(claimed.get("prompt"))
            .isEqualTo(editResult instanceof Map ? "Revised" : "Do the work");
        if (!(editResult instanceof Map))
          assertThat(editResult).isInstanceOf(ConflictException.class);
        assertThat(queue.begin(id, claimed.get("dispatchToken"), input(claimed)))
            .containsEntry("attempted", true);
        assertThatThrownBy(() -> queue.remove(id)).isInstanceOf(ConflictException.class);
      }
    } finally {
      executor.shutdownNow();
    }
  }

  @Test
  void concurrentEditAndDeleteCannotResurrectAnItemOrLeavePartialChanges() throws Exception {
    queue.enqueue(task, request(task, "request-a"), attachments);
    var executor = Executors.newFixedThreadPool(2);
    var barrier = new CyclicBarrier(2);
    try {
      Future<Object> edit =
          executor.submit(
              () -> {
                barrier.await();
                try {
                  return queue.edit("request-a", edit("Do the work", "Revised"));
                } catch (NotFoundException error) {
                  return error;
                }
              });
      var remove =
          executor.submit(
              () -> {
                barrier.await();
                return queue.remove("request-a");
              });
      Object editResult = edit.get(5, TimeUnit.SECONDS);
      assertThat(editResult instanceof Map || editResult instanceof NotFoundException).isTrue();
      assertThat(remove.get(5, TimeUnit.SECONDS)).containsEntry("ok", true);
      assertThat(queue.list(task.id)).isEmpty();
      assertThat(reload().list(task.id)).isEmpty();
    } finally {
      executor.shutdownNow();
    }
  }

  Map<String, Object> edit(String expected, String prompt) {
    return fields("taskId", task.id, "expectedPrompt", expected, "prompt", prompt);
  }

  Object concurrentEdit(CyclicBarrier barrier, String id, String prompt) throws Exception {
    barrier.await();
    try {
      return queue.edit(id, edit("Do the work", prompt));
    } catch (ConflictException error) {
      return error;
    }
  }
}
