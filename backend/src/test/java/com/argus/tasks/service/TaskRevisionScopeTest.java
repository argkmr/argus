package com.argus.tasks.service;

import static com.argus.agents.domain.AgentValues.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.agents.service.RepositoryScopeService;
import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ConflictException;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.repository.TaskRepository;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.dto.WorkspaceResponse;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Path;
import java.util.*;
import java.util.stream.IntStream;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class TaskRevisionScopeTest {
  @TempDir Path root;
  ObjectMapper mapper = new ObjectMapper();
  WorkspaceService workspace = mock(WorkspaceService.class);
  TaskRepository repository;
  TaskActivityService activity;
  TaskService tasks;
  TaskService legacyTasks;

  @BeforeEach
  void setup() {
    repository =
        new TaskRepository(
            new ArgusProperties(root, null, "test", ""), new AtomicJsonStore(mapper), mapper);
    activity = new TaskActivityService();
    tasks =
        new TaskService(
            repository, activity, mapper, null, workspace, new RepositoryScopeService());
    legacyTasks = new TaskService(repository, activity, mapper);
    connected("new-a", "new-b");
  }

  void connected(String... ids) {
    var repositories =
        Arrays.stream(ids)
            .map(id -> new Repository(id, id, root.resolve(id).toString(), "", "main"))
            .toList();
    when(workspace.snapshot())
        .thenReturn(
            new WorkspaceResponse(
                2,
                ids.length == 0 ? "" : ids[0],
                Map.of(),
                repositories,
                List.of(),
                List.of(),
                Map.of()));
  }

  AiTask original(String... ids) {
    var task = tasks.create(fields("scope", "global", "repositoryIds", List.of(ids)));
    tasks.appendUser(
        task.id,
        fields("prompt", "Original"),
        List.of(fields("id", "attachment", "path", "retained.txt")));
    tasks.completeAgentJob(
        fields(
            "id",
            "old-job",
            "taskId",
            task.id,
            "status",
            "completed",
            "output",
            "Original answer"));
    return tasks.get(task.id);
  }

  Map<String, Object> edit(AiTask task) {
    return fields(
        "requestId",
        "edit",
        "expectedRevisionCount",
        0,
        "messageId",
        task.messages.get(0).id,
        "expectedContent",
        "Original",
        "prompt",
        "Revised");
  }

  AiTask pending(String... ids) {
    var original = original(ids);
    // Restored revisions predate connected-scope preflight and remain repairable.
    return (AiTask) legacyTasks.revise(original.id, edit(original)).get("task");
  }

  Map<String, Object> patch(AiTask pending) {
    var draft = obj(pending.additionalProperties().get("revisionDraft"));
    return fields(
        "expectedPrompt",
        draft.get("prompt"),
        "prompt",
        draft.get("prompt"),
        "expectedRevisionCount",
        1,
        "expectedRunRequestId",
        draft.get("runRequestId"));
  }

  String runId(AiTask task) {
    return text(obj(task.additionalProperties().get("revisionDraft")).get("runRequestId"));
  }

  @Test
  void explicitSelectionRepairsRestoredScopeAndArchivesOriginalExactly() {
    var original = original("disconnected-old");
    var request = edit(original);
    request.putAll(
        fields("repositoryIds", List.of("new-a"), "expectedRepositoryIds", original.repositoryIds));
    var response = tasks.revise(original.id, request);
    var revised = (AiTask) response.get("task");
    assertThat(revised.id).isEqualTo(original.id);
    assertThat(revised.repositoryIds).containsExactly("new-a");
    assertThat(obj(revised.additionalProperties().get("revisionOf")))
        .containsEntry("originalRepositoryIds", List.of("disconnected-old"));
    assertThat(obj(revised.additionalProperties().get("revisionDraft")).get("attachments"))
        .isEqualTo(original.messages.get(0).attachments);
    var archived = tasks.revision(original.id, text(response.get("revisionId"))).get("task");
    assertThat((Object) mapper.valueToTree(archived)).isEqualTo(mapper.valueToTree(original));
    assertThat(tasks.revise(original.id, request)).containsEntry("replayed", true);
    request.put("repositoryIds", List.of("new-b"));
    assertThatThrownBy(() -> tasks.revise(original.id, request))
        .hasMessageContaining("different content");
    assertThat(tasks.revisions(original.id)).hasSize(1);
  }

  @Test
  void disconnectedOrInvalidPostLeavesOriginalAndHistoryUntouched() {
    var original = original("old");
    var request = edit(original);
    assertThatThrownBy(() -> tasks.revise(original.id, request))
        .hasMessageContaining("Select connected repositories");
    request.putAll(
        fields(
            "repositoryIds", List.of("unknown"), "expectedRepositoryIds", original.repositoryIds));
    assertThatThrownBy(() -> tasks.revise(original.id, request))
        .hasMessageContaining("no longer connected");
    request.put("repositoryIds", List.of("new-a"));
    request.put("expectedRepositoryIds", List.of("other-old"));
    assertThatThrownBy(() -> tasks.revise(original.id, request))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("selection changed");
    request.remove("expectedRepositoryIds");
    assertThatThrownBy(() -> tasks.revise(original.id, request))
        .hasMessageContaining("saved repository selection is required");
    assertThat((Object) mapper.valueToTree(tasks.get(original.id)))
        .isEqualTo(mapper.valueToTree(original));
    assertThat(tasks.revisions(original.id)).isEmpty();
  }

  @Test
  void scopeOnlyPatchRotatesRunIdentityPreservesOriginalAndReplaysLostResponse() {
    var pending = pending("old");
    repository.mutate(
        pending.id,
        item ->
            item.additionalProperties()
                .put("cliSessions", fields("codex", fields("id", "stale-session"))));
    var originalSnapshot =
        tasks.revision(pending.id, text(tasks.revisions(pending.id).get(0).get("id"))).get("task");
    var request = patch(pending);
    request.putAll(
        fields("repositoryIds", List.of("new-a"), "expectedRepositoryIds", List.of("old")));
    var repaired = (AiTask) tasks.updateRevisionDraft(pending.id, request).get("task");
    assertThat(repaired.repositoryIds).containsExactly("new-a");
    assertThat(runId(repaired)).isNotEqualTo(runId(pending));
    assertThat(obj(repaired.additionalProperties().get("cliSessions"))).isEmpty();
    assertThat(((Number) repaired.additionalProperties().get("revisionCount")).intValue())
        .isEqualTo(1);
    assertThat(obj(repaired.additionalProperties().get("revisionOf")))
        .containsEntry("originalRepositoryIds", List.of("old"));
    assertThat(runId((AiTask) tasks.updateRevisionDraft(pending.id, request).get("task")))
        .isEqualTo(runId(repaired));
    assertThat(runId((AiTask) tasks.updateRevisionDraft(pending.id, patch(repaired)).get("task")))
        .isEqualTo(runId(repaired));
    assertThat(tasks.revisions(pending.id)).hasSize(1);
    assertThat(
            (Object)
                mapper.valueToTree(
                    tasks
                        .revision(pending.id, text(tasks.revisions(pending.id).get(0).get("id")))
                        .get("task")))
        .isEqualTo(mapper.valueToTree(originalSnapshot));
  }

  @Test
  void divergentStalePatchCannotReplaceScopePromptOrNotes() {
    var pending = pending("new-a");
    var change = patch(pending);
    change.put(
        "promptNotes", List.of(fields("id", "note", "text", "Latest notes", "enabled", true)));
    var updated = (AiTask) tasks.updateRevisionDraft(pending.id, change).get("task");
    var stale = patch(pending);
    stale.put("promptNotes", List.of());
    assertThatThrownBy(() -> tasks.updateRevisionDraft(pending.id, stale))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("draft changed");
    var wrongScope = patch(updated);
    wrongScope.putAll(
        fields("repositoryIds", List.of("new-b"), "expectedRepositoryIds", List.of("stale")));
    assertThatThrownBy(() -> tasks.updateRevisionDraft(pending.id, wrongScope))
        .hasMessageContaining("selection changed");
    assertThat(runId(tasks.get(pending.id))).isEqualTo(runId(updated));
    assertThat(tasks.get(pending.id).repositoryIds).containsExactly("new-a");
  }

  @Test
  void invalidPatchNeverConsumesOrChangesSavedDraft() {
    var pending = pending("old");
    var request = patch(pending);
    assertThatThrownBy(() -> tasks.updateRevisionDraft(pending.id, request))
        .hasMessageContaining("Select connected repositories");
    request.putAll(
        fields("repositoryIds", List.of("unknown"), "expectedRepositoryIds", List.of("old")));
    assertThatThrownBy(() -> tasks.updateRevisionDraft(pending.id, request))
        .hasMessageContaining("no longer connected");
    request.put("repositoryIds", List.of());
    connected();
    assertThatThrownBy(() -> tasks.updateRevisionDraft(pending.id, request))
        .hasMessageContaining("Connect a repository");
    assertThat(mapper.valueToTree(tasks.get(pending.id)).toString())
        .isEqualTo(mapper.valueToTree(pending).toString());
  }

  @Test
  void patchBlocksSavedQueuesAndInvalidatesEarlierQueuePreparation() {
    var pending = pending("new-a");
    var queue = mock(PromptQueueService.class);
    var guarded =
        new TaskService(
            repository, activity, mapper, queue, workspace, new RepositoryScopeService());
    when(queue.list(pending.id)).thenReturn(List.of(fields("requestId", "queued")));
    assertThatThrownBy(() -> guarded.updateRevisionDraft(pending.id, patch(pending)))
        .hasMessageContaining("queued prompts");
    assertThat(runId(tasks.get(pending.id))).isEqualTo(runId(pending));
    when(queue.list(pending.id)).thenReturn(List.of());
    long epoch = activity.queueEpoch(pending.id);
    guarded.updateRevisionDraft(pending.id, patch(pending));
    assertThatThrownBy(() -> activity.acceptQueuedPrompt(pending.id, epoch, () -> "must not save"))
        .isInstanceOf(ConflictException.class);
  }

  @Test
  void explicitAutoSelectionFreezesAllAndHistoricalLargeScopesStayValid() {
    var ids = IntStream.range(0, 8).mapToObj(i -> "connected-" + i).toArray(String[]::new);
    connected(ids);
    var pending = pending("old");
    var request = patch(pending);
    request.putAll(fields("repositoryIds", List.of(ids), "expectedRepositoryIds", List.of("old")));
    assertThatThrownBy(() -> tasks.updateRevisionDraft(pending.id, request))
        .hasMessageContaining("up to 6");
    request.put("repositoryIds", List.of());
    var auto = (AiTask) tasks.updateRevisionDraft(pending.id, request).get("task");
    assertThat(auto.repositoryIds).containsExactly(ids);
    var unchanged = patch(auto);
    unchanged.putAll(fields("repositoryIds", List.of(ids), "expectedRepositoryIds", List.of(ids)));
    assertThat(runId((AiTask) tasks.updateRevisionDraft(pending.id, unchanged).get("task")))
        .isEqualTo(runId(auto));
    assertThat(runId((AiTask) tasks.updateRevisionDraft(pending.id, patch(auto)).get("task")))
        .isEqualTo(runId(auto));
  }
}
