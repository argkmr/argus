package com.argus.tasks.controller;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ApiExceptionHandler;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.platform.LocalApiBoundaryFilter;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.repository.TaskRepository;
import com.argus.tasks.service.TaskCommandService;
import com.argus.tasks.service.TaskService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.ObjectMapper;

/** Exercises the public same-chat edit contract, rather than calling revise directly. */
class TaskRevisionFlowHttpTest {
  @TempDir Path root;
  final ObjectMapper mapper = new ObjectMapper();
  TaskRepository repository;
  TaskService tasks;
  TaskCommandService commands;
  MockMvc mvc;

  @BeforeEach
  void setup() {
    var properties = new ArgusProperties(root, null, "test", "fixture");
    repository = new TaskRepository(properties, new AtomicJsonStore(mapper), mapper);
    tasks = new TaskService(repository);
    commands = mock(TaskCommandService.class);
    mvc =
        MockMvcBuilders.standaloneSetup(
                new TaskController(tasks), new TaskMutationController(tasks, commands))
            .setControllerAdvice(new ApiExceptionHandler())
            .addFilters(new LocalApiBoundaryFilter(properties))
            .build();
  }

  MockHttpServletRequestBuilder local(MockHttpServletRequestBuilder request) {
    return request
        .header("Host", "127.0.0.1:4173")
        .with(
            value -> {
              value.setRemoteAddr("127.0.0.1");
              value.setLocalPort(4173);
              return value;
            });
  }

  String route(String taskId) {
    return "/api/ai-tasks/" + taskId + "/revisions";
  }

  AiTask source(String scope) {
    var task =
        tasks.create(
            Map.of(
                "scope",
                scope,
                "repositoryId",
                "fixture-repo",
                "repositoryIds",
                List.of("fixture-repo"),
                "title",
                "Keep original title"));
    tasks.appendUser(task.id, Map.of("prompt", "Earlier request"), List.of());
    tasks.completeAgentJob(
        Map.of(
            "id", "prefix-job",
            "taskId", task.id,
            "status", "completed",
            "output", "Earlier answer"));
    tasks.appendUser(
        task.id,
        Map.of("prompt", "Original request"),
        List.of(Map.of("id", "evidence", "title", "fixture.txt", "kind", "file")));
    tasks.completeAgentJob(
        Map.of(
            "id", "cancelled-job",
            "taskId", task.id,
            "status", "cancelled",
            "output", "Cancelled partial reply"));
    return tasks.get(task.id);
  }

  Map<String, Object> edit(AiTask task) {
    return Map.of(
        "messageId", task.messages.get(2).id,
        "expectedContent", "Original request",
        "prompt", "Edited request",
        "requestId", "http-same-chat-edit",
        "expectedRevisionCount", 0);
  }

  MockHttpServletRequestBuilder postRevision(String id, Map<String, Object> input) {
    return local(
        post(route(id))
            .contentType(MediaType.APPLICATION_JSON)
            .content(mapper.writeValueAsString(input)));
  }

  record FileState(String bytes, FileTime modifiedAt) {}

  Map<String, FileState> fixtureFiles() throws Exception {
    var files = new LinkedHashMap<String, FileState>();
    try (var stream = Files.walk(root)) {
      for (var path : stream.filter(Files::isRegularFile).sorted().toList()) {
        files.put(
            root.relativize(path).toString(),
            new FileState(
                Base64.getEncoder().encodeToString(Files.readAllBytes(path)),
                Files.getLastModifiedTime(path)));
      }
    }
    return files;
  }

  @ParameterizedTest
  @ValueSource(strings = {"global", "repository"})
  void postContinuesSameChatAndReadOnlyHistoryRetainsCancelledSuffixWithoutTouchingLegacyFork(
      String scope) throws Exception {
    var original = source(scope);
    var sibling =
        tasks.create(
            Map.of("scope", scope, "repositoryId", "fixture-repo", "title", "Legacy fork"));
    tasks.appendUser(sibling.id, Map.of("prompt", "Independent legacy fork"), List.of());
    repository.mutate(
        sibling.id,
        task ->
            task.additionalProperties()
                .put("revisionOf", Map.of("taskId", original.id, "pending", false)));
    byte[] siblingBefore =
        Files.readAllBytes(root.resolve("ai-tasks").resolve(sibling.id + ".json"));
    Files.writeString(root.resolve("repository-source.txt"), "Already changed repository file");

    var response = mvc.perform(postRevision(original.id, edit(original))).andReturn().getResponse();
    assertThat(response.getStatus()).isEqualTo(201);
    var revised = mapper.readTree(response.getContentAsString());
    assertThat(revised.path("originalTaskId").asText()).isEqualTo(original.id);
    assertThat(revised.path("task").path("id").asText()).isEqualTo(original.id);
    assertThat(revised.path("task").path("title").asText()).isEqualTo(original.title);
    assertThat(revised.path("task").path("createdAt").asText()).isEqualTo(original.createdAt);
    assertThat(revised.path("task").path("revisionCount").asLong()).isEqualTo(1);
    assertThat(revised.path("task").path("messages").size()).isEqualTo(2);
    assertThat(revised.path("task").path("revisionDraft").path("prompt").asText())
        .isEqualTo("Edited request");
    assertThat(revised.path("task").path("revisionDraft").path("attachments").size()).isEqualTo(1);
    assertThat(tasks.list(scope, null)).hasSize(2);
    assertThat(Files.readAllBytes(root.resolve("ai-tasks").resolve(sibling.id + ".json")))
        .isEqualTo(siblingBefore);

    var filesAfterEdit = fixtureFiles();
    String revisionId = revised.path("revisionId").asText();
    var list = mvc.perform(local(get(route(original.id)))).andReturn().getResponse();
    assertThat(list.getStatus()).isEqualTo(200);
    var history = mapper.readTree(list.getContentAsString());
    assertThat(history.size()).isEqualTo(1);
    assertThat(history.get(0).path("id").asText()).isEqualTo(revisionId);
    assertThat(history.get(0).path("messageCount").asInt()).isEqualTo(4);
    assertThat(history.get(0).path("editedMessageId").asText())
        .isEqualTo(original.messages.get(2).id);
    assertThat(history.get(0).path("promptPreview").asText()).isEqualTo("Original request");
    var detail =
        mvc.perform(local(get(route(original.id) + "/" + revisionId))).andReturn().getResponse();
    assertThat(detail.getStatus()).isEqualTo(200);
    var archived = mapper.readTree(detail.getContentAsString()).path("task");
    // Compare the complete HTTP JSON contract on both sides. valueToTree keeps
    // Java Long nodes where an HTTP JSON round-trip produces equivalent Int nodes.
    assertThat(archived).isEqualTo(mapper.readTree(mapper.writeValueAsString(original)));
    assertThat(archived.path("messages").get(3).path("status").asText()).isEqualTo("cancelled");
    assertThat(archived.path("messages").get(3).path("content").asText())
        .isEqualTo("Cancelled partial reply");

    var retry = mvc.perform(postRevision(original.id, edit(original))).andReturn().getResponse();
    assertThat(retry.getStatus()).isEqualTo(201);
    var replayed = mapper.readTree(retry.getContentAsString());
    assertThat(replayed.path("replayed").asBoolean()).isTrue();
    assertThat(replayed.path("revisionId").asText()).isEqualTo(revisionId);
    assertThat(replayed.path("task").path("revisionCount").asLong()).isEqualTo(1);
    assertThat(tasks.revisions(original.id)).hasSize(1);
    assertThat(fixtureFiles()).isEqualTo(filesAfterEdit);
    assertThat(
            mvc.perform(local(get(route(sibling.id) + "/" + revisionId)))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(404);
    verifyNoInteractions(commands);
  }

  @Test
  void postRequiresStableRequestIdentityAndExpectedRevisionBeforeWritingAnything()
      throws Exception {
    var task = source("repository");
    var before = fixtureFiles();
    for (String omitted : List.of("requestId", "expectedRevisionCount")) {
      var input = new LinkedHashMap<>(edit(task));
      input.remove(omitted);
      var response = mvc.perform(postRevision(task.id, input)).andReturn().getResponse();
      assertThat(response.getStatus()).isEqualTo(400);
      assertThat(mapper.readTree(response.getContentAsString()).path("error").asText())
          .isNotBlank();
    }
    assertThat(tasks.revisions(task.id)).isEmpty();
    assertThat(fixtureFiles()).isEqualTo(before);
    verifyNoInteractions(commands);
  }

  @Test
  void crossOriginAndNonLoopbackCannotReadOrCreateRevisions() throws Exception {
    var task = source("global");
    var before = fixtureFiles();
    assertThat(
            mvc.perform(
                    postRevision(task.id, edit(task)).header("Origin", "https://example.invalid"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(403);
    assertThat(
            mvc.perform(
                    postRevision(task.id, edit(task))
                        .with(
                            request -> {
                              request.setRemoteAddr("192.0.2.1");
                              return request;
                            }))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(403);
    assertThat(
            mvc.perform(
                    local(get(route(task.id)))
                        .with(
                            request -> {
                              request.setRemoteAddr("192.0.2.1");
                              return request;
                            }))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(403);
    assertThat(tasks.revisions(task.id)).isEmpty();
    assertThat(fixtureFiles()).isEqualTo(before);
    verifyNoInteractions(commands);
  }
}
