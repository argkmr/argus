package com.argus.tasks.service;

import static com.argus.agents.domain.AgentValues.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ApiExceptionHandler;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.tasks.controller.TaskMutationController;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.repository.PromptQueueRepository;
import com.argus.tasks.repository.TaskRepository;
import java.nio.file.Path;
import java.util.*;
import java.util.stream.IntStream;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.ObjectMapper;

class PromptNotesTest {
  @TempDir Path root;
  final ObjectMapper mapper = new ObjectMapper();
  TaskService tasks;
  PromptQueueService queue;
  ArgusProperties properties;

  @BeforeEach
  void setup() {
    properties = new ArgusProperties(root, null, "test", "");
    var store = new AtomicJsonStore(mapper);
    tasks = new TaskService(new TaskRepository(properties, store, mapper));
    queue = new PromptQueueService(new PromptQueueRepository(properties, store, mapper), mapper);
  }

  List<Map<String, Object>> notes(String text) {
    return List.of(fields("id", "note-one", "text", text, "enabled", true));
  }

  AiTask create(String scope) {
    return tasks.create(
        fields("scope", scope, "repositoryId", "repo-a", "promptNotes", notes("Original note")));
  }

  @Test
  void validatesBoundsIdsTypesAndMakesDeepImmutableCopies() {
    var source = new ArrayList<>(notes("  Keep exact user text\nwith spacing  "));
    var saved = PromptNotes.normalize(source);
    source.get(0).put("text", "Mutated");
    source.clear();
    assertThat(saved.get(0).get("text")).isEqualTo("  Keep exact user text\nwith spacing  ");
    assertThatThrownBy(() -> saved.add(Map.of())).isInstanceOf(UnsupportedOperationException.class);
    assertThatThrownBy(() -> saved.get(0).put("text", "Changed"))
        .isInstanceOf(UnsupportedOperationException.class);
    for (Object invalid :
        List.of(
            "text",
            List.of(Map.of()),
            List.of(fields("id", "unsafe/id", "text", "text", "enabled", true)),
            List.of(fields("id", "id", "text", "text", "enabled", "true")),
            notes(" "),
            notes("x\0y"),
            notes("x".repeat(4001)),
            List.of(notes("One").get(0), notes("Two").get(0)),
            IntStream.range(0, 21)
                .mapToObj(i -> fields("id", "n" + i, "text", "x", "enabled", true))
                .toList(),
            IntStream.range(0, 6)
                .mapToObj(i -> fields("id", "n" + i, "text", "x".repeat(4000), "enabled", true))
                .toList()))
      assertThatThrownBy(() -> PromptNotes.normalize(invalid))
          .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> PromptNotes.normalize(null))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void appendsOnlyEnabledUserNotesAfterEverythingElseWithoutRewritingRequest() {
    String original = "User question\nAttachment context\nProvider metadata";
    var snapshot =
        List.of(
            fields("id", "one", "text", "Keep it concise", "enabled", true),
            fields("id", "two", "text", "Disabled note", "enabled", false));
    String prompt = PromptNotes.append(original, snapshot);
    assertThat(prompt)
        .startsWith(original + "\n\nNOTE — user-authored instructions for this prompt:")
        .endsWith("1. Keep it concise")
        .doesNotContain("Disabled note");
    assertThat(PromptNotes.append(original, List.of())).isEqualTo(original);
    assertThat(PromptNotes.resolve(fields("promptNotes", List.of()), snapshot)).isEmpty();
  }

  @Test
  void defaultsAreDurablePerTaskAndNeverRewriteSentUserMessages() {
    var repositoryTask = create("repository");
    var nexusTask = create("global");
    tasks.appendUser(
        repositoryTask.id,
        fields("prompt", "Raw request", "promptNotes", notes("Only this turn")),
        List.of());
    tasks.updatePromptNotes(repositoryTask.id, fields("promptNotes", notes("Future default")));
    var reloaded =
        new TaskService(new TaskRepository(properties, new AtomicJsonStore(mapper), mapper));
    var task = reloaded.get(repositoryTask.id);
    assertThat(task.promptNotes).isEqualTo(notes("Future default"));
    assertThat(task.messages.get(0).content).isEqualTo("Raw request");
    assertThat(task.messages.get(0).additionalProperties().get("promptNotes"))
        .isEqualTo(notes("Only this turn"));
    assertThat(reloaded.get(nexusTask.id).promptNotes).isEqualTo(notes("Original note"));
    tasks.updatePromptNotes(repositoryTask.id, fields("promptNotes", List.of()));
    assertThat(tasks.get(repositoryTask.id).promptNotes).isEmpty();
    assertThat(
            tasks.get(repositoryTask.id).messages.get(0).additionalProperties().get("promptNotes"))
        .isEqualTo(notes("Only this turn"));
  }

  @Test
  void newTaskCanSaveDefaultsDifferentFromTheFirstPromptOverride() {
    var task =
        tasks.create(
            fields(
                "repositoryId",
                "repo-a",
                "taskPromptNotes",
                notes("Default"),
                "promptNotes",
                List.of()));
    tasks.appendUser(
        task.id, fields("prompt", "No notes this time", "promptNotes", List.of()), List.of());
    assertThat(tasks.get(task.id).promptNotes).isEqualTo(notes("Default"));
    assertThat(tasks.get(task.id).messages.get(0).additionalProperties().get("promptNotes"))
        .isEqualTo(List.of());
  }

  @Test
  void revisionKeepsOriginalTurnNotesAndIndependentCurrentTaskDefaults() {
    var task = create("global");
    tasks.appendUser(
        task.id, fields("prompt", "Original", "promptNotes", notes("Then")), List.of());
    tasks.updatePromptNotes(task.id, fields("promptNotes", notes("Now")));
    var source = tasks.get(task.id);
    var revised =
        (AiTask)
            tasks
                .revise(
                    task.id,
                    fields(
                        "requestId",
                        "edit-notes",
                        "expectedRevisionCount",
                        0,
                        "messageId",
                        source.messages.get(0).id,
                        "expectedContent",
                        "Original",
                        "prompt",
                        "Revised"))
                .get("task");
    assertThat(revised.promptNotes).isEqualTo(notes("Now"));
    assertThat(obj(revised.additionalProperties().get("revisionDraft")).get("promptNotes"))
        .isEqualTo(notes("Then"));
    tasks.updateRevisionDraft(
        revised.id,
        fields("expectedPrompt", "Revised", "prompt", "Again", "promptNotes", List.of()));
    assertThat(
            obj(tasks.get(revised.id).additionalProperties().get("revisionDraft"))
                .get("promptNotes"))
        .isEqualTo(List.of());
    var archiveId = tasks.revisions(task.id).get(0).get("id").toString();
    var archived = (AiTask) tasks.revision(task.id, archiveId).get("task");
    assertThat(archived.messages.get(0).additionalProperties().get("promptNotes"))
        .isEqualTo(notes("Then"));
  }

  Map<String, Object> queued(AiTask task) {
    return fields(
        "requestId",
        "queued-one",
        "taskId",
        task.id,
        "scope",
        task.scope,
        "repositoryId",
        task.repositoryId,
        "repositoryIds",
        List.of(),
        "providerId",
        "codex",
        "mode",
        "edit",
        "modelSettings",
        fields("model", "fixture", "effort", "high", "speed", "standard"),
        "contextMode",
        "fresh",
        "prompt",
        "Queued request",
        "attachmentIds",
        List.of());
  }

  Map<String, Object> dispatch(Map<String, Object> saved) {
    var request = new LinkedHashMap<>(saved);
    request.put("provider", saved.get("providerId"));
    request.putAll(obj(saved.get("modelSettings")));
    return request;
  }

  @Test
  void queueFreezesNotesAcrossDefaultChangesReloadAndDispatch() {
    var task = create("repository");
    queue.enqueue(task, queued(task), List.of());
    tasks.updatePromptNotes(task.id, fields("promptNotes", notes("Changed later")));
    var reloaded =
        new PromptQueueService(
            new PromptQueueRepository(properties, new AtomicJsonStore(mapper), mapper), mapper);
    var claim = reloaded.claim("queued-one");
    assertThat(claim.get("promptNotes")).isEqualTo(notes("Original note"));
    var input = dispatch(claim);
    input.remove(
        "promptNotes"); // Legacy clients must still receive the queued snapshot, not new defaults.
    reloaded.begin("queued-one", claim.get("dispatchToken"), input);
    assertThat(input.get("promptNotes")).isEqualTo(notes("Original note"));
  }

  @Test
  void queueRejectsChangedDispatchAndAllowsExplicitOptimisticNoteEdits() {
    var task = create("global");
    var original = queue.enqueue(task, queued(task), List.of());
    assertThatThrownBy(
            () ->
                queue.edit(
                    "queued-one",
                    fields(
                        "taskId",
                        task.id,
                        "expectedPrompt",
                        "Queued request",
                        "prompt",
                        "Edited",
                        "promptNotes",
                        List.of())))
        .hasMessageContaining("original queued prompt notes");
    var edited =
        queue.edit(
            "queued-one",
            fields(
                "taskId",
                task.id,
                "expectedPrompt",
                "Queued request",
                "prompt",
                "Edited",
                "promptNotes",
                List.of(),
                "expectedPromptNotes",
                original.get("promptNotes")));
    assertThat(edited.get("promptNotes")).isEqualTo(List.of());
    var claim = queue.claim("queued-one");
    var input = dispatch(claim);
    input.put("promptNotes", notes("Tampered"));
    assertThatThrownBy(() -> queue.begin("queued-one", claim.get("dispatchToken"), input))
        .hasMessageContaining("settings changed");
  }

  @Test
  void legacyQueueReceiptIdentitySurvivesAddingItsFirstNote() {
    var task = create("repository");
    var original = queued(task);
    var legacy = new LinkedHashMap<>(original);
    legacy.put("status", "queued");
    new PromptQueueRepository(properties, new AtomicJsonStore(mapper), mapper)
        .mutate(
            items -> {
              items.add(legacy);
              return null;
            });
    var empty = new LinkedHashMap<>(original);
    empty.put("promptNotes", List.of());
    assertThat(queue.fingerprint(empty)).isEqualTo(queue.fingerprint(original));
    queue.edit(
        "queued-one",
        fields(
            "taskId",
            task.id,
            "expectedPrompt",
            "Queued request",
            "prompt",
            "Edited legacy",
            "expectedPromptNotes",
            List.of(),
            "promptNotes",
            notes("First note")));
    var retried = queue.enqueue(task, original, List.of());
    assertThat(retried.get("prompt")).isEqualTo("Edited legacy");
    assertThat(retried.get("promptNotes")).isEqualTo(notes("First note"));
    var claim = queue.claim("queued-one");
    var input = dispatch(claim);
    queue.begin("queued-one", claim.get("dispatchToken"), input);
    assertThat(input.get("promptNotes")).isEqualTo(notes("First note"));
  }

  @Test
  void httpEndpointValidatesAndPersistsWithoutStartingWork() throws Exception {
    var task = create("repository");
    var commands = mock(TaskCommandService.class);
    var mvc =
        MockMvcBuilders.standaloneSetup(new TaskMutationController(tasks, commands))
            .setControllerAdvice(new ApiExceptionHandler())
            .build();
    var response =
        mvc.perform(
                put("/api/ai-tasks/" + task.id + "/prompt-notes")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(mapper.writeValueAsString(fields("promptNotes", notes("Saved")))))
            .andReturn()
            .getResponse();
    assertThat(response.getStatus()).isEqualTo(200);
    assertThat(mapper.readValue(response.getContentAsString(), AiTask.class).promptNotes)
        .isEqualTo(notes("Saved"));
    assertThat(
            mvc.perform(
                    put("/api/ai-tasks/unknown-task/prompt-notes")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"promptNotes\":[]}"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(404);
    assertThatThrownBy(
            () ->
                tasks.updatePromptNotes(
                    task.id, fields("promptNotes", List.of(), "repositoryId", "other")))
        .hasMessageContaining("different chat");
    verifyNoInteractions(commands);
  }
}
