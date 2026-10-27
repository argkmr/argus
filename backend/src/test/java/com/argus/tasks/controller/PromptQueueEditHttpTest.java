package com.argus.tasks.controller;

import static com.argus.agents.domain.AgentValues.fields;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.argus.agents.service.AgentRunService;
import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ApiExceptionHandler;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.repository.PromptQueueRepository;
import com.argus.tasks.service.PromptQueueService;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.ObjectMapper;

class PromptQueueEditHttpTest {
  private static final String ROUTE = "/api/prompt-queue/request-a";
  private static final String ORIGINAL = "Original queued prompt";
  @TempDir Path directory;
  private final ObjectMapper mapper = new ObjectMapper();
  private ArgusProperties properties;
  private PromptQueueService queue;
  private AgentRunService runs;
  private MockMvc mvc;
  private Map<String, Object> original;

  @BeforeEach
  void setup() {
    properties = new ArgusProperties(directory, directory, "test", "");
    queue = reload();
    runs = mock(AgentRunService.class);
    mvc =
        MockMvcBuilders.standaloneSetup(new PromptQueueController(queue, runs))
            .setControllerAdvice(new ApiExceptionHandler())
            .build();
    var task = new AiTask();
    task.id = "task-a";
    task.repositoryId = "repo-a";
    task.scope = "repository";
    original =
        queue.enqueue(
            task,
            fields(
                "requestId", "request-a",
                "taskId", "task-a",
                "repositoryId", "repo-a",
                "repositoryIds", List.of(),
                "providerId", "codex",
                "providerName", "Codex",
                "mode", "edit",
                "modelSettings", fields("model", "fixture", "effort", "high", "speed", "standard"),
                "contextMode", "history",
                "prompt", ORIGINAL,
                "attachmentIds", List.of("attachment-a")),
            List.of(fields("id", "attachment-a", "title", "Saved evidence")));
  }

  @AfterEach
  void neverDispatchesAnAgent() {
    verify(runs, never()).enqueue(anyMap());
    verify(runs, never()).run(anyMap());
    verify(runs, never()).answerQuestion(anyMap());
    verifyNoMoreInteractions(runs);
  }

  @Test
  void editsOnlyPromptAndReturnsTheDurableFullItemWithoutChangingExecutionSettings()
      throws Exception {
    String edited = "  Revised café prompt\nwith exact whitespace.  ";
    var input = editInput(edited);
    input.putAll(
        fields(
            "requestId", "replacement-id",
            "repositoryId", "another-repo",
            "repositoryIds", List.of("another-repo"),
            "scope", "global",
            "providerId", "another-provider",
            "providerName", "Another provider",
            "mode", "plan",
            "modelSettings", Map.of("model", "another-model"),
            "contextMode", "fresh",
            "attachmentIds", List.of(),
            "attachments", List.of(),
            "status", "started",
            "dispatchToken", "forged-token",
            "attempted", true,
            "enqueueFingerprint", "forged-fingerprint",
            "receiptFingerprint", "forged-receipt",
            "createdAt", "forged-timestamp"));

    var response = edit(ROUTE, input);
    assertThat(response.getStatus()).isEqualTo(200);
    var saved = mapper.readTree(response.getContentAsByteArray());
    assertThat(saved.path("prompt").asText()).isEqualTo(edited);
    for (var entry : original.entrySet()) {
      if (!"prompt".equals(entry.getKey())) {
        assertThat(saved.get(entry.getKey()))
            .as(entry.getKey())
            .isEqualTo(mapper.valueToTree(entry.getValue()));
      }
    }
    assertThat(saved.path("enqueueFingerprint").asText()).isEqualTo(queue.fingerprint(original));
    assertThat(saved.path("updatedAt").asText()).isNotBlank();
    assertThat(
            saved.has("dispatchToken") || saved.has("attempted") || saved.has("receiptFingerprint"))
        .isFalse();
    assertThat(reload().list("task-a").get(0)).containsEntry("prompt", edited);
    var readback =
        mvc.perform(get("/api/prompt-queue").param("taskId", "task-a")).andReturn().getResponse();
    assertThat(readback.getStatus()).isEqualTo(200);
    assertThat(mapper.readTree(readback.getContentAsByteArray()).get(0)).isEqualTo(saved);
  }

  @Test
  void rejectsForeignChatAndStalePromptWithoutOverwritingTheSavedEdit() throws Exception {
    var foreign = editInput("Foreign edit");
    foreign.put("taskId", "another-task");
    assertThat(edit(ROUTE, foreign).getStatus()).isEqualTo(409);
    assertThat(queue.list("task-a").get(0)).isEqualTo(original);
    assertThat(edit(ROUTE, editInput("First edit")).getStatus()).isEqualTo(200);
    assertThat(edit(ROUTE, editInput("Stale second edit")).getStatus()).isEqualTo(409);
    assertThat(queue.list("task-a").get(0)).containsEntry("prompt", "First edit");
  }

  @Test
  void claimedInterruptedAndStartedRequestsCannotBeEdited() throws Exception {
    when(runs.claimQueuedPrompt("request-a")).thenAnswer(call -> queue.claim(call.getArgument(0)));
    var claimed = mvc.perform(post(ROUTE + "/claim")).andReturn().getResponse();
    assertThat(claimed.getStatus()).isEqualTo(200);
    verify(runs).claimQueuedPrompt("request-a");
    String token = mapper.readTree(claimed.getContentAsByteArray()).path("dispatchToken").asText();
    assertThat(edit(ROUTE, editInput("Too late")).getStatus()).isEqualTo(409);
    assertThat(mvc.perform(delete(ROUTE)).andReturn().getResponse().getStatus()).isEqualTo(409);
    queue.interrupted("request-a", "Synthetic interrupted dispatch", token);
    assertThat(edit(ROUTE, editInput("Interrupted edit")).getStatus()).isEqualTo(409);
    queue.started("request-a", "fixture-job");
    assertThat(edit(ROUTE, editInput("Started edit")).getStatus()).isEqualTo(409);
    assertThat(queue.list("task-a")).isEmpty();
  }

  @Test
  void malformedBodiesAndInvalidFieldsReturn400WithoutChangingQueueContent() throws Exception {
    var invalid = new ArrayList<Map<String, Object>>();
    for (String key : List.of("taskId", "expectedPrompt", "prompt")) {
      var missing = editInput("Valid edit");
      missing.remove(key);
      invalid.add(missing);
      var wrongType = editInput("Valid edit");
      wrongType.put(key, 42);
      invalid.add(wrongType);
      var nullValue = editInput("Valid edit");
      nullValue.put(key, null);
      invalid.add(nullValue);
    }
    var blankTask = editInput("Valid edit");
    blankTask.put("taskId", " ");
    invalid.add(blankTask);
    invalid.add(editInput(" \n\t"));
    invalid.add(editInput("x".repeat(100_001)));
    for (Map<String, Object> input : invalid) {
      assertThat(edit(ROUTE, input).getStatus()).isEqualTo(400);
      assertThat(queue.list("task-a").get(0)).isEqualTo(original);
    }
    for (String body : List.of("", "{", "[]", "null")) {
      var response =
          mvc.perform(patch(ROUTE).contentType(MediaType.APPLICATION_JSON).content(body))
              .andReturn()
              .getResponse();
      assertThat(response.getStatus()).isEqualTo(400);
    }
    assertThat(queue.list("task-a").get(0)).isEqualTo(original);
    assertThat(edit(ROUTE, editInput("x".repeat(100_000))).getStatus()).isEqualTo(200);
  }

  @Test
  void missingAndDeletedRequestsReturn404AndCannotBeRecreatedByEditing() throws Exception {
    assertThat(edit("/api/prompt-queue/missing", editInput("Missing edit")).getStatus())
        .isEqualTo(404);
    assertThat(mvc.perform(delete(ROUTE)).andReturn().getResponse().getStatus()).isEqualTo(200);
    assertThat(edit(ROUTE, editInput("Deleted edit")).getStatus()).isEqualTo(404);
    assertThat(reload().list("task-a")).isEmpty();
  }

  private LinkedHashMap<String, Object> editInput(String prompt) {
    return new LinkedHashMap<>(
        Map.of("taskId", "task-a", "expectedPrompt", ORIGINAL, "prompt", prompt));
  }

  private MockHttpServletResponse edit(String route, Map<String, Object> input) throws Exception {
    return mvc.perform(
            patch(route)
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsBytes(input)))
        .andReturn()
        .getResponse();
  }

  private PromptQueueService reload() {
    return new PromptQueueService(
        new PromptQueueRepository(properties, new AtomicJsonStore(mapper), mapper), mapper);
  }
}
