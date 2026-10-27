package com.argus.tasks.controller;

import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ApiExceptionHandler;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.platform.LocalApiBoundaryFilter;
import com.argus.tasks.repository.TaskRepository;
import com.argus.tasks.service.TaskService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.ObjectMapper;

class TaskRevisionHttpTest {
  @TempDir Path root;

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

  @Test
  void listsAndReadsSnapshotsWithoutMutatingTaskOrExposingInternalReceipts() throws Exception {
    var mapper = new ObjectMapper();
    var properties = new ArgusProperties(root, null, "test", "fixture");
    var tasks =
        new TaskService(new TaskRepository(properties, new AtomicJsonStore(mapper), mapper));
    var task = tasks.create(Map.of("scope", "global"));
    task = tasks.appendUser(task.id, Map.of("prompt", "Original question"), List.of());
    var revised =
        tasks.revise(
            task.id,
            Map.of(
                "messageId",
                task.messages.get(0).id,
                "expectedContent",
                "Original question",
                "prompt",
                "Changed question",
                "requestId",
                "http-edit",
                "expectedRevisionCount",
                0));
    var mvc =
        MockMvcBuilders.standaloneSetup(new TaskController(tasks))
            .setControllerAdvice(new ApiExceptionHandler())
            .addFilters(new LocalApiBoundaryFilter(properties))
            .build();
    String route = "/api/ai-tasks/" + task.id + "/revisions";
    byte[] before = Files.readAllBytes(root.resolve("ai-tasks").resolve(task.id + ".json"));
    var list = mvc.perform(local(get(route))).andReturn().getResponse();
    assertThat(list.getStatus()).isEqualTo(200);
    var summary = mapper.readTree(list.getContentAsString());
    assertThat(summary.isArray()).isTrue();
    assertThat(summary.size()).isEqualTo(1);
    assertThat(list.getContentAsString())
        .doesNotContain("fingerprint", "requestId", "runRequestId", "\"task\"");
    var detail =
        mvc.perform(local(get(route + "/" + revised.get("revisionId")))).andReturn().getResponse();
    assertThat(detail.getStatus()).isEqualTo(200);
    assertThat(
            mapper
                .readTree(detail.getContentAsString())
                .path("task")
                .path("messages")
                .get(0)
                .path("content")
                .asText())
        .isEqualTo("Original question");
    assertThat(detail.getContentAsString()).doesNotContain("fingerprint", "http-edit");
    assertThat(mvc.perform(local(get(route + "/missing"))).andReturn().getResponse().getStatus())
        .isEqualTo(404);
    assertThat(
            mvc.perform(local(get("/api/ai-tasks/missing/revisions")))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(404);
    assertThat(
            mvc.perform(local(get(route)).header("Origin", "https://example.invalid"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(403);
    assertThat(
            mvc.perform(local(post(route + "/" + revised.get("revisionId"))))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(405);
    assertThat(Files.readAllBytes(root.resolve("ai-tasks").resolve(task.id + ".json")))
        .isEqualTo(before);
  }
}
