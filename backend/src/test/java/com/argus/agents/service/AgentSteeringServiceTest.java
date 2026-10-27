package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ConflictException;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.context.domain.ContextAttachment;
import com.argus.context.service.ContextService;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.repository.PromptQueueRepository;
import com.argus.tasks.service.*;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.dto.WorkspaceResponse;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.ObjectMapper;

class AgentSteeringServiceTest {
  @TempDir Path root;
  final ObjectMapper mapper = new ObjectMapper();
  final TaskService tasks = mock(TaskService.class);
  final TaskActivityService activity = new TaskActivityService();
  final WorkspaceService workspace = mock(WorkspaceService.class);
  final ContextService contexts = mock(ContextService.class);
  final AgentExecutionService agents = mock(AgentExecutionService.class);
  final AgentPromptService prompts = mock(AgentPromptService.class);
  PromptQueueService queue;
  AgentSteeringService service;
  AiTask task;
  Map<String, Object> job;

  PromptQueueService reload() {
    return new PromptQueueService(
        new PromptQueueRepository(
            new ArgusProperties(root, null, "test", ""), new AtomicJsonStore(mapper), mapper),
        mapper);
  }

  @BeforeEach
  void setup() {
    queue = reload();
    task = new AiTask();
    task.id = "chat";
    task.scope = "repository";
    task.repositoryId = "repo";
    when(tasks.get("chat")).thenReturn(task);
    doReturn(task).when(tasks).appendSteeredUser(eq("chat"), anyMap(), anyMap());
    connected(List.of(new Repository("repo", "Test", root.toString(), "now")));
    when(contexts.get("attachment"))
        .thenReturn(
            new ContextAttachment(
                "attachment",
                "file",
                "spec.txt",
                "",
                root.resolve("spec.txt").toString(),
                4,
                "text/plain",
                "repo",
                "now"));
    when(prompts.steering(anyMap(), anyList())).thenReturn("assembled addition");
    job =
        fields(
            "id",
            "job",
            "taskId",
            "chat",
            "nativeTurnId",
            "turn",
            "scope",
            "repository",
            "repositoryId",
            "repo",
            "repositoryIds",
            List.of("repo"),
            "provider",
            "codex",
            "mode",
            "edit",
            "model",
            "model",
            "effort",
            "high",
            "speed",
            "standard",
            "steering",
            Map.of("available", true));
    when(agents.get("job")).thenAnswer(invocation -> new LinkedHashMap<>(job));
    when(agents.steer("job", "turn", "assembled addition"))
        .thenReturn(fields("accepted", true, "turnId", "turn", "threadId", "thread"));
    service =
        new AgentSteeringService(
            queue, tasks, activity, workspace, contexts, agents, prompts, mapper);
    enqueue("first");
  }

  Map<String, Object> request(String id) {
    return fields(
        "requestId",
        id,
        "taskId",
        "chat",
        "scope",
        "repository",
        "repositoryId",
        "repo",
        "repositoryIds",
        List.of(),
        "providerId",
        "codex",
        "mode",
        "edit",
        "modelSettings",
        fields("model", "model", "effort", "high", "speed", "standard"),
        "prompt",
        "Also preserve the audit trail",
        "promptNotes",
        List.of(),
        "contextMode",
        "history",
        "attachmentIds",
        List.of("attachment"));
  }

  void connected(List<Repository> repositories) {
    when(workspace.snapshot())
        .thenReturn(
            new WorkspaceResponse(
                1, "repo", Map.of(), repositories, List.of(), List.of(), Map.of()));
  }

  void enqueue(String id) {
    queue.enqueue(task, request(id), List.of(Map.of("id", "attachment", "title", "spec.txt")));
  }

  @AfterEach
  void stopRecovery() {
    service.close();
  }

  Map<String, Object> acceptForRecovery(String id) {
    var claim = queue.claimSteer(id, queue.fingerprint(queue.get(id)), input());
    return queue.acceptSteer(
        id,
        claim.get("dispatchToken"),
        fields(
            "accepted", true,
            "turnId", "turn",
            "threadId", "thread",
            "acceptedAt", "2026-10-13T07:00:00Z"));
  }

  Map<String, Object> input() {
    return fields(
        "taskId",
        "chat",
        "jobId",
        "job",
        "expectedTurnId",
        "turn",
        "expectedPrompt",
        "Also preserve the audit trail",
        "expectedPromptNotes",
        List.of());
  }

  @Test
  void acceptedAdditionUsesSameTurnAndLeavesEarlierAndLaterQueueItemsIntact() {
    enqueue("second");
    enqueue("third");
    try (var running = activity.reserve("chat")) {
      assertThat(service.steer("second", input()))
          .containsEntry("accepted", true)
          .containsEntry("turnId", "turn");
    }
    assertThat(queue.list("chat"))
        .extracting(item -> item.get("requestId"))
        .containsExactly("first", "third");
    assertThat(queue.get("second"))
        .containsEntry("delivery", "steer")
        .containsEntry("status", "started")
        .containsKey("acceptedAt");
    verify(tasks)
        .appendSteeredUser(
            eq("chat"), argThat(item -> "second".equals(item.get("requestId"))), anyMap());
    verify(agents, never()).start(anyMap());
    verify(agents, never()).stop(anyString());
  }

  @Test
  void lostReplyReplaysReceiptNotNativeInstructionEvenAfterTurnEndsOrRestart() {
    service.steer("first", input());
    when(agents.get("job")).thenThrow(new IllegalArgumentException("Turn gone"));
    var restarted =
        new AgentSteeringService(
            reload(), tasks, activity, workspace, contexts, agents, prompts, mapper);
    assertThat(restarted.steer("first", input())).containsEntry("accepted", true);
    verify(agents, times(1)).steer(anyString(), anyString(), anyString());
  }

  @Test
  void historyWriteFailureCanBeRepairedWithoutSendingAgain() {
    when(tasks.appendSteeredUser(eq("chat"), anyMap(), anyMap()))
        .thenThrow(new IllegalStateException("disk busy"))
        .thenReturn(task);
    assertThatThrownBy(() -> service.steer("first", input())).hasMessage("disk busy");
    assertThat(queue.get("first")).containsEntry("status", "started");
    assertThat(service.reconcile("first", input())).containsEntry("accepted", true);
    verify(agents, times(1)).steer(anyString(), anyString(), anyString());
  }

  @Test
  void restartedRecoveryWritesOnlyAcceptedMissingHistoryAndNeverCallsAnAgent() {
    acceptForRecovery("first");
    enqueue("normal");
    queue.claim("normal");
    queue.started("normal", "another-job");
    enqueue("queued");
    enqueue("unknown");
    enqueue("recorded");
    var claim = queue.claimSteer("unknown", queue.fingerprint(queue.get("unknown")), input());
    queue.interrupted("unknown", "Native delivery outcome unknown", claim.get("dispatchToken"));
    acceptForRecovery("recorded");
    queue.steeringHistoryRecorded("recorded");
    var restartedQueue = reload();
    var restarted =
        new AgentSteeringService(
            restartedQueue, tasks, activity, workspace, contexts, agents, prompts, mapper);
    try {
      restarted.recoverAccepted();
      assertThat(restartedQueue.get("first"))
          .containsEntry("historyRecorded", true)
          .containsEntry("acceptedAt", "2026-10-13T07:00:00Z");
      assertThat(restartedQueue.pendingSteeringReceipts()).isEmpty();
      restarted.recoverAccepted();
      verify(tasks, times(1))
          .appendSteeredUser(
              eq("chat"), argThat(item -> "first".equals(item.get("requestId"))), anyMap());
      verifyNoMoreInteractions(tasks);
      verifyNoInteractions(agents, contexts, prompts);
      assertThat(restartedQueue.list("chat"))
          .extracting(item -> item.get("requestId"))
          .containsExactly("queued", "unknown");
      assertThat(reload().get("first")).containsEntry("historyRecorded", true);
    } finally {
      restarted.close();
    }
  }

  @Test
  void recoveryMarksOnlyAfterHistorySucceedsAndContinuesAfterIndividualFailure() {
    enqueue("second");
    var firstReceipt = acceptForRecovery("first");
    acceptForRecovery("second");
    when(tasks.appendSteeredUser(eq("chat"), anyMap(), anyMap()))
        .thenAnswer(
            invocation -> {
              Map<String, Object> receipt = invocation.getArgument(2);
              String id = receipt.get("requestId").toString();
              assertThat(queue.get(id)).containsEntry("historyRecorded", false);
              if ("first".equals(id))
                throw new IllegalStateException("Task file is temporarily busy");
              return task;
            });
    service.recoverAccepted();
    assertThat(queue.get("first")).isEqualTo(firstReceipt);
    assertThat(queue.get("second")).containsEntry("historyRecorded", true);
    assertThat(queue.pendingSteeringReceipts())
        .extracting(item -> item.get("requestId"))
        .containsExactly("first");
    doReturn(task).when(tasks).appendSteeredUser(eq("chat"), anyMap(), anyMap());
    service.recoverAccepted();
    assertThat(queue.pendingSteeringReceipts()).isEmpty();
    verify(tasks, times(2))
        .appendSteeredUser(
            eq("chat"), argThat(item -> "first".equals(item.get("requestId"))), anyMap());
    verify(tasks, times(1))
        .appendSteeredUser(
            eq("chat"), argThat(item -> "second".equals(item.get("requestId"))), anyMap());
    verifyNoInteractions(agents, contexts, prompts);
  }

  @Test
  void startupRecoveryRepairsAcknowledgedReceiptWithoutHistoryFlag() throws Exception {
    acceptForRecovery("first");
    var store = new AtomicJsonStore(mapper);
    List<Map<String, Object>> journal = store.read(root.resolve("prompt-queue.json"), List.class);
    journal.get(0).remove("historyRecorded");
    store.write(root.resolve("prompt-queue.json"), journal);
    var restartedQueue = spy(reload());
    var repaired = new CountDownLatch(1);
    doAnswer(
            invocation -> {
              invocation.callRealMethod();
              repaired.countDown();
              return null;
            })
        .when(restartedQueue)
        .steeringHistoryRecorded("first");
    var restarted =
        new AgentSteeringService(
            restartedQueue, tasks, activity, workspace, contexts, agents, prompts, mapper);
    try {
      restarted.startRecovery();
      restarted.startRecovery();
      assertThat(repaired.await(5, TimeUnit.SECONDS)).isTrue();
      assertThat(restartedQueue.get("first")).containsEntry("historyRecorded", true);
      verify(tasks, times(1))
          .appendSteeredUser(
              eq("chat"), argThat(item -> "first".equals(item.get("requestId"))), anyMap());
      verifyNoInteractions(agents, contexts, prompts);
    } finally {
      restarted.close();
    }
  }

  @Test
  void oldQueuedPromptWithoutNotesCanBeSteeredAndReconciledWithoutCurrentDefaults() {
    task.promptNotes =
        List.of(Map.of("id", "new-note", "text", "New task default", "enabled", true));
    var store = new AtomicJsonStore(mapper);
    List<Map<String, Object>> journal = store.read(root.resolve("prompt-queue.json"), List.class);
    journal.get(0).remove("promptNotes");
    store.write(root.resolve("prompt-queue.json"), journal);
    queue = reload();
    service.close();
    service =
        new AgentSteeringService(
            queue, tasks, activity, workspace, contexts, agents, prompts, mapper);
    assertThat(service.steer("first", input())).containsEntry("accepted", true);
    assertThat(service.reconcile("first", input())).containsEntry("accepted", true);
    verify(prompts).steering(argThat(item -> !item.containsKey("promptNotes")), anyList());
    verify(tasks, times(1))
        .appendSteeredUser(eq("chat"), argThat(item -> !item.containsKey("promptNotes")), anyMap());
    verify(agents, times(1)).steer(anyString(), anyString(), anyString());
  }

  @Test
  void recordedReceiptIsCompactAndReplaysAfterRestartWithoutNativeOrHistoryWrites() {
    service.steer("first", input());
    var receipt = reload().get("first");
    assertThat(receipt)
        .containsEntry("status", "started")
        .containsEntry("delivery", "steer")
        .containsEntry("historyRecorded", true)
        .containsEntry("jobId", "job")
        .containsEntry("turnId", "turn")
        .containsKeys("acceptedAt", "receiptFingerprint", "steeringPayloadFingerprint")
        .doesNotContainKeys("prompt", "attachments", "attachmentIds");
    assertThat(mapper.writeValueAsString(receipt))
        .doesNotContain("Also preserve the audit trail", "spec.txt");
    var restarted =
        new AgentSteeringService(
            reload(), tasks, activity, workspace, contexts, agents, prompts, mapper);
    try {
      assertThat(restarted.steer("first", input())).containsEntry("accepted", true);
      assertThat(restarted.reconcile("first", input())).containsEntry("accepted", true);
      var stale = input();
      stale.put("expectedPrompt", "Unrelated prompt using the same request ID");
      assertThatThrownBy(() -> restarted.steer("first", stale))
          .isInstanceOf(ConflictException.class);
      assertThatThrownBy(() -> restarted.reconcile("first", stale))
          .isInstanceOf(ConflictException.class);
      var changedNotes = input();
      changedNotes.put(
          "expectedPromptNotes",
          List.of(Map.of("id", "added", "text", "Extra instruction", "enabled", true)));
      assertThatThrownBy(() -> restarted.steer("first", changedNotes))
          .isInstanceOf(ConflictException.class);
      restarted.recoverAccepted();
      verify(tasks, times(1)).appendSteeredUser(eq("chat"), anyMap(), anyMap());
      verify(agents, times(1)).steer(anyString(), anyString(), anyString());
      verify(agents, times(1)).get("job");
    } finally {
      restarted.close();
    }
  }

  @Test
  void historyRepairRetainsExactNativeAcceptanceTime() {
    when(agents.steer("job", "turn", "assembled addition"))
        .thenReturn(
            fields(
                "accepted", true,
                "turnId", "turn",
                "threadId", "thread",
                "acceptedAt", "2026-10-13T07:00:00.123Z"));
    service.steer("first", input());
    assertThat(queue.get("first"))
        .containsEntry("acceptedAt", "2026-10-13T07:00:00.123Z")
        .containsEntry("historyRecorded", true);
    verify(tasks)
        .appendSteeredUser(
            eq("chat"),
            anyMap(),
            argThat(receipt -> "2026-10-13T07:00:00.123Z".equals(receipt.get("acceptedAt"))));
  }

  @Test
  void reconcileNeverSendsAnUnacceptedPrompt() {
    assertThat(service.reconcile("first", input())).containsEntry("accepted", false);
    verifyNoInteractions(agents);
    var token =
        queue
            .claimSteer("first", queue.fingerprint(queue.get("first")), input())
            .get("dispatchToken");
    queue.interrupted("first", "unknown", token);
    assertThat(service.reconcile("first", input())).containsEntry("accepted", false);
    verifyNoInteractions(agents);
    assertThat(queue.get("first")).containsEntry("status", "interrupted");
  }

  @ParameterizedTest
  @ValueSource(
      strings = {
        "taskId",
        "nativeTurnId",
        "provider",
        "mode",
        "scope",
        "repositoryId",
        "model",
        "effort",
        "speed"
      })
  void mismatchDoesNotClaimOrSend(String key) {
    job.put(key, "different");
    assertThatThrownBy(() -> service.steer("first", input())).isInstanceOf(ConflictException.class);
    assertThat(queue.get("first")).containsEntry("status", "queued");
    verify(agents, never()).steer(anyString(), anyString(), anyString());
  }

  @Test
  void stalePromptAndUnsupportedProviderPreserveQueue() {
    var stale = input();
    stale.put("expectedPrompt", "old");
    assertThatThrownBy(() -> service.steer("first", stale)).isInstanceOf(ConflictException.class);
    job.put("steering", Map.of("available", false));
    assertThatThrownBy(() -> service.steer("first", input())).hasMessageContaining("cannot accept");
    assertThat(queue.get("first")).containsEntry("status", "queued");
    verify(agents, never()).steer(anyString(), anyString(), anyString());
  }

  @Test
  void missingAttachmentAndDisconnectedRepoNeverSend() {
    when(contexts.get("attachment")).thenThrow(new IllegalArgumentException("Attachment missing"));
    assertThatThrownBy(() -> service.steer("first", input()))
        .hasMessageContaining("Attachment missing");
    connected(List.of());
    assertThatThrownBy(() -> service.steer("first", input())).hasMessageContaining("disconnected");
    verify(agents, never()).steer(anyString(), anyString(), anyString());
    assertThat(queue.get("first")).containsEntry("status", "queued");
  }

  @Test
  void cancellationBarrierAndPausedQueueDoNotSend() {
    try (var cancelling = activity.preventNewActivity("chat")) {
      assertThatThrownBy(() -> service.steer("first", input()))
          .isInstanceOf(ConflictException.class);
    }
    queue.pauseTask("chat", "question");
    assertThatThrownBy(() -> service.steer("first", input())).hasMessageContaining("paused");
    verify(agents, never()).steer(anyString(), anyString(), anyString());
  }

  @Test
  void unexpectedDeliveryFailureIsInterruptedAndNeverReplayed() {
    when(agents.steer(anyString(), anyString(), anyString()))
        .thenThrow(new IllegalStateException("Disconnected"));
    assertThatThrownBy(() -> service.steer("first", input()))
        .hasMessageContaining("could not be confirmed");
    assertThat(queue.get("first")).containsEntry("status", "interrupted");
    assertThatThrownBy(() -> service.steer("first", input())).isInstanceOf(ConflictException.class);
    verify(agents, times(1)).steer(anyString(), anyString(), anyString());
    verify(tasks, never()).appendSteeredUser(anyString(), anyMap(), anyMap());
  }

  @Test
  void definitiveNativeRejectionReturnsToQueueWithoutHistory() {
    when(agents.steer(anyString(), anyString(), anyString()))
        .thenThrow(new SteerDeliveryException("Turn already completed", false));
    assertThatThrownBy(() -> service.steer("first", input()))
        .hasMessageContaining("already completed");
    assertThat(queue.get("first"))
        .containsEntry("status", "queued")
        .doesNotContainKeys("delivery", "attempted", "dispatchToken");
    verify(tasks, never()).appendSteeredUser(anyString(), anyMap(), anyMap());
  }

  @Test
  void uncertainNativeReplyNeverReturnsToQueue() {
    when(agents.steer(anyString(), anyString(), anyString()))
        .thenThrow(new SteerDeliveryException("Reply timed out", true));
    assertThatThrownBy(() -> service.steer("first", input()))
        .hasMessageContaining("may already be");
    assertThat(queue.get("first"))
        .containsEntry("status", "interrupted")
        .containsEntry("attempted", true);
  }

  @Test
  void mismatchedProviderAckIsNeverRepresentedAsAccepted() {
    when(agents.steer(anyString(), anyString(), anyString()))
        .thenReturn(fields("accepted", true, "turnId", "another", "threadId", "thread"));
    assertThatThrownBy(() -> service.steer("first", input()))
        .hasMessageContaining("receipt could not be saved");
    assertThat(queue.get("first")).containsEntry("status", "interrupted");
    verify(tasks, never()).appendSteeredUser(anyString(), anyMap(), anyMap());
  }

  @Test
  void queueEditRacingPreparationInvalidatesFrozenClaim() {
    when(prompts.steering(anyMap(), anyList()))
        .thenAnswer(
            invocation -> {
              queue.edit(
                  "first",
                  fields(
                      "taskId",
                      "chat",
                      "expectedPrompt",
                      "Also preserve the audit trail",
                      "prompt",
                      "Changed while preparing"));
              return "assembled addition";
            });
    assertThatThrownBy(() -> service.steer("first", input())).hasMessageContaining("changed");
    assertThat(queue.get("first"))
        .containsEntry("status", "queued")
        .containsEntry("prompt", "Changed while preparing");
    verify(agents, never()).steer(anyString(), anyString(), anyString());
  }

  @Test
  void cancellationDuringPreparationCannotClaimThePrompt() {
    when(prompts.steering(anyMap(), anyList()))
        .thenAnswer(
            invocation -> {
              try (var barrier = activity.preventNewActivity("chat")) {
                /* Deliberately changes epoch. */
              }
              return "assembled addition";
            });
    assertThatThrownBy(() -> service.steer("first", input())).hasMessageContaining("cancelled");
    assertThat(queue.get("first")).containsEntry("status", "queued");
    verify(agents, never()).steer(anyString(), anyString(), anyString());
  }

  @Test
  void nexusSteeringCannotExpandOrReplaceRepositoryScope() {
    task.scope = "global";
    task.repositoryId = "global";
    var global = request("nexus");
    global.put("scope", "global");
    global.put("repositoryId", "global");
    global.put("repositoryIds", List.of("repo", "other"));
    queue.enqueue(task, global, List.of());
    job.put("scope", "global");
    job.put("repositoryId", "global");
    assertThatThrownBy(() -> service.steer("nexus", input()))
        .hasMessageContaining("repository selection");
    job.put("repositoryIds", List.of("other", "repo"));
    connected(
        List.of(
            new Repository("repo", "Test", root.toString(), "now"),
            new Repository("other", "Other", root.toString(), "now")));
    assertThat(service.steer("nexus", input())).containsEntry("accepted", true);
  }

  @Test
  void crashAfterClaimStaysInterruptedOnRestart() {
    queue.claimSteer("first", queue.fingerprint(queue.get("first")), input());
    assertThat(reload().get("first"))
        .containsEntry("status", "interrupted")
        .containsEntry("attempted", true);
  }

  @Test
  void simultaneousClicksOnlyOneNativeSend() throws Exception {
    var entered = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    when(agents.steer(anyString(), anyString(), anyString()))
        .thenAnswer(
            invocation -> {
              entered.countDown();
              assertThat(release.await(5, TimeUnit.SECONDS)).isTrue();
              return fields("accepted", true, "turnId", "turn", "threadId", "thread");
            });
    var executor = Executors.newSingleThreadExecutor();
    try {
      var first = executor.submit(() -> service.steer("first", input()));
      assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
      assertThatThrownBy(() -> service.steer("first", input()))
          .isInstanceOf(ConflictException.class);
      release.countDown();
      assertThat(first.get(5, TimeUnit.SECONDS)).containsEntry("accepted", true);
    } finally {
      release.countDown();
      executor.shutdownNow();
    }
    verify(agents, times(1)).steer(anyString(), anyString(), anyString());
  }
}
