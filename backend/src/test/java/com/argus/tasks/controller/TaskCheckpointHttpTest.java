package com.argus.tasks.controller;

import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ApiExceptionHandler;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.platform.LocalApiBoundaryFilter;
import com.argus.tasks.repository.TaskRepository;
import com.argus.tasks.service.TaskCheckpointService;
import com.argus.tasks.service.TaskService;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.ObjectMapper;

class TaskCheckpointHttpTest {
  @TempDir Path root;
  final ObjectMapper mapper = new ObjectMapper();
  MockMvc mvc;
  TaskService tasks;
  String taskId;
  String messageId;

  @BeforeEach
  void setup() {
    var properties = new ArgusProperties(root, null, "test", "fixture");
    var repository = new TaskRepository(properties, new AtomicJsonStore(mapper), mapper);
    tasks = new TaskService(repository);
    var task = tasks.create(Map.of("scope", "global"));
    task = tasks.appendUser(task.id, Map.of("prompt", "Checkpoint test"), List.of());
    taskId = task.id;
    messageId = task.messages.get(0).id;
    mvc =
        MockMvcBuilders.standaloneSetup(
                new TaskCheckpointController(new TaskCheckpointService(repository, mapper)))
            .setControllerAdvice(new ApiExceptionHandler())
            .addFilters(new LocalApiBoundaryFilter(properties))
            .build();
  }

  String route(String id) {
    return "/api/ai-tasks/" + taskId + "/checkpoints/" + id;
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

  @Test
  void localPutDeleteReturnDurableTaskAndStructuredStaleMessageError() throws Exception {
    var marked = mvc.perform(local(put(route(messageId)))).andReturn().getResponse();
    assertThat(marked.getStatus()).isEqualTo(200);
    var body = mapper.readTree(marked.getContentAsString());
    assertThat(body.path("checkpoints").size()).isEqualTo(1);
    assertThat(body.path("checkpoints").get(0).path("messageId").asText()).isEqualTo(messageId);
    assertThat(body.path("checkpointRevision").asLong()).isEqualTo(1);
    assertThat(mvc.perform(local(put(route(messageId)))).andReturn().getResponse().getStatus())
        .isEqualTo(200);
    var removed = mvc.perform(local(delete(route(messageId)))).andReturn().getResponse();
    assertThat(removed.getStatus()).isEqualTo(200);
    assertThat(mapper.readTree(removed.getContentAsString()).path("checkpointRevision").asLong())
        .isEqualTo(2);
    var stale = mvc.perform(local(put(route("not-saved")))).andReturn().getResponse();
    assertThat(stale.getStatus()).isEqualTo(404);
    assertThat(mapper.readTree(stale.getContentAsString()).path("error").asText())
        .contains("no longer available");
  }

  @Test
  void crossOriginAndNonLoopbackCallersCannotChangeMarkers() throws Exception {
    assertThat(
            mvc.perform(local(put(route(messageId))).header("Origin", "https://example.invalid"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(403);
    assertThat(
            mvc.perform(
                    local(put(route(messageId)))
                        .with(
                            request -> {
                              request.setRemoteAddr("192.0.2.1");
                              return request;
                            }))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(403);
    assertThat(tasks.get(taskId).checkpoints).isEmpty();
    assertThat(tasks.get(taskId).checkpointRevision).isZero();
  }
}
