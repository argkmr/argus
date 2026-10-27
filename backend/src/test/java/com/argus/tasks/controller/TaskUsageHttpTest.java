package com.argus.tasks.controller;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ApiExceptionHandler;
import com.argus.common.error.NotFoundException;
import com.argus.platform.LocalApiBoundaryFilter;
import com.argus.platform.RestoreMaintenanceGate;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.domain.TaskMessage;
import com.argus.tasks.repository.TaskRepository;
import com.argus.tasks.service.TaskUsageService;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.ObjectMapper;

class TaskUsageHttpTest {
  @TempDir Path root;
  final TaskRepository tasks = mock(TaskRepository.class);
  final TaskUsageService usage =
      new TaskUsageService(tasks, new ObjectMapper(), new RestoreMaintenanceGate());
  MockMvc mvc;
  final String route = "/api/ai-tasks/task/messages/message/usage";

  @BeforeEach
  void setup() {
    mvc =
        MockMvcBuilders.standaloneSetup(new TaskUsageController(usage))
            .setControllerAdvice(new ApiExceptionHandler())
            .addFilters(
                new LocalApiBoundaryFilter(new ArgusProperties(root, null, "test", "fixture")))
            .build();
  }

  @AfterEach
  void close() {
    usage.close();
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
  void asynchronouslyReturnsScopedNumericProjectionAndMissingMessageError() throws Exception {
    var task = new AiTask();
    var message = new TaskMessage();
    message.id = "message";
    message.execution =
        Map.of(
            "tokenUsage",
            Map.of("reported", true, "exact", false, "status", "partial", "totalTokens", 1100));
    task.messages.add(message);
    when(tasks.get("task")).thenReturn(task);
    var started = mvc.perform(local(get(route))).andExpect(request().asyncStarted()).andReturn();
    mvc.perform(asyncDispatch(started))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.recovered").value(false))
        .andExpect(jsonPath("$.tokenUsage.totalTokens").value(1100))
        .andExpect(jsonPath("$.tokenUsage.exact").value(false));

    when(tasks.get("task")).thenThrow(new NotFoundException("Task message not found"));
    started = mvc.perform(local(get(route))).andExpect(request().asyncStarted()).andReturn();
    mvc.perform(asyncDispatch(started))
        .andExpect(status().isNotFound())
        .andExpect(jsonPath("$.error").value("Task message not found"));
  }

  @Test
  void remoteAndCrossOriginClientsCannotReadLocalAccounting() throws Exception {
    assertThat(
            mvc.perform(local(get(route)).header("Origin", "https://example.invalid"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(403);
    assertThat(
            mvc.perform(
                    local(get(route))
                        .with(
                            request -> {
                              request.setRemoteAddr("192.0.2.1");
                              return request;
                            }))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(403);
    verifyNoInteractions(tasks);
  }
}
