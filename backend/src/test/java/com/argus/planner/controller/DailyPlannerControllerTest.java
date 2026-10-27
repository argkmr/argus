package com.argus.planner.controller;

import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ApiExceptionHandler;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.planner.service.DailyPlannerService;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.ObjectMapper;

class DailyPlannerControllerTest {
  @TempDir Path root;
  MockMvc mvc;

  @BeforeEach
  void setup() {
    var service =
        new DailyPlannerService(
            new ArgusProperties(root, root, "test", ""),
            new AtomicJsonStore(new ObjectMapper()),
            Clock.fixed(Instant.parse("2026-09-25T10:00:00Z"), ZoneOffset.UTC));
    mvc =
        MockMvcBuilders.standaloneSetup(new DailyPlannerController(service))
            .setControllerAdvice(new ApiExceptionHandler())
            .build();
  }

  @Test
  void permanentTaskDeletionRequiresCurrentRevisionAndReturnsUpdatedSnapshot() throws Exception {
    var response =
        mvc.perform(
                post("/api/daily-planner/tasks")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"revision\":0,\"tasks\":[{\"title\":\"Delete me\",\"date\":\"2026-09-25\"}]}"))
            .andReturn()
            .getResponse();
    var taskId =
        new ObjectMapper()
            .readTree(response.getContentAsString())
            .get("tasks")
            .get(0)
            .get("id")
            .asString();
    assertThat(
            mvc.perform(delete("/api/daily-planner/tasks/" + taskId).param("revision", "0"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(409);
    assertThat(
            mvc.perform(delete("/api/daily-planner/tasks/" + taskId))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(400);
    var deleted =
        mvc.perform(delete("/api/daily-planner/tasks/" + taskId).param("revision", "1"))
            .andReturn()
            .getResponse();
    assertThat(deleted.getStatus()).isEqualTo(200);
    assertThat(deleted.getContentAsString())
        .contains("\"tasks\":[]", "\"events\":[]", "\"links\":[]");
    assertThat(
            mvc.perform(delete("/api/daily-planner/tasks/" + taskId).param("revision", "2"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(404);
  }

  @Test
  void createsTasksAndReturnsExplicitConflictForStaleRevision() throws Exception {
    var first =
        mvc.perform(
                post("/api/daily-planner/tasks")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"revision\":0,\"tasks\":[{\"title\":\"Task\",\"date\":\"2026-09-25\"}]}"))
            .andReturn()
            .getResponse();
    assertThat(first.getStatus()).isEqualTo(200);
    assertThat(first.getContentAsString())
        .contains("\"revision\":1", "\"today\":\"2026-09-25\"", "\"nextWorkday\":\"2026-09-28\"");
    var stale =
        mvc.perform(
                post("/api/daily-planner/tasks")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"revision\":0,\"tasks\":[{\"title\":\"Other\",\"date\":\"2026-09-25\"}]}"))
            .andReturn()
            .getResponse();
    assertThat(stale.getStatus()).isEqualTo(409);
    assertThat(stale.getContentAsString()).contains("draft has not been discarded");
  }

  @Test
  void invalidCalendarAndReportInputsAreReadable400s() throws Exception {
    var bad =
        mvc.perform(
                post("/api/daily-planner/tasks")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"revision\":0,\"tasks\":[{\"title\":\"Weekend\",\"date\":\"2026-09-26\"}]}"))
            .andReturn()
            .getResponse();
    assertThat(bad.getStatus()).isEqualTo(400);
    assertThat(bad.getContentAsString()).contains("weekday");
    assertThat(
            mvc.perform(
                    get("/api/daily-planner/report").param("from", "bad").param("to", "2026-09-25"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(400);
  }

  @Test
  void exportsUseSafeAttachmentNamesAndCorrectMediaTypes() throws Exception {
    var csv =
        mvc.perform(
                get("/api/daily-planner/report.csv")
                    .param("from", "2026-09-01")
                    .param("to", "2026-09-30"))
            .andReturn()
            .getResponse();
    assertThat(csv.getStatus()).isEqualTo(200);
    assertThat(csv.getContentType()).contains("text/csv");
    assertThat(csv.getHeader("Content-Disposition"))
        .isEqualTo("attachment; filename=\"argus-tasks-2026-09-01-2026-09-30.csv\"");
    assertThat(csv.getHeader("Cache-Control")).isEqualTo("no-store");
    var html =
        mvc.perform(
                get("/api/daily-planner/report.html")
                    .param("from", "2026-09-01")
                    .param("to", "2026-09-30")
                    .param("groupBy", "sprint"))
            .andReturn()
            .getResponse();
    assertThat(html.getStatus()).isEqualTo(200);
    assertThat(html.getContentType()).contains("text/html");
    assertThat(html.getContentAsString()).contains("Outside sprints");
  }

  @Test
  void remindersAreDisabledByDefaultAndArbitraryAcknowledgementsAreRejected() throws Exception {
    var reminders = mvc.perform(get("/api/daily-planner/reminders")).andReturn().getResponse();
    assertThat(reminders.getStatus()).isEqualTo(200);
    assertThat(reminders.getContentAsString())
        .contains("\"notifications\":[]", "\"remindersEnabled\":false");
    assertThat(
            mvc.perform(post("/api/daily-planner/reminders/made-up/ack"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(400);
  }

  @Test
  void manualAndApprovedAiTaskBatchesUseTheSameMonotonicKeyAllocation() throws Exception {
    var first =
        mvc.perform(
                post("/api/daily-planner/tasks")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"revision\":0,\"tasks\":[{\"title\":\"Manual task\",\"date\":\"2026-09-25\"}]}"))
            .andReturn()
            .getResponse();
    assertThat(first.getStatus()).isEqualTo(200);
    assertThat(first.getContentAsString()).contains("\"key\":\"TASK-1\"");
    var aiBatch =
        mvc.perform(
                post("/api/daily-planner/tasks")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"revision\":1,\"tasks\":[{\"title\":\"Approved AI task one\",\"date\":\"2026-09-25\"},{\"title\":\"Approved AI task two\",\"date\":\"2026-09-28\"}]}"))
            .andReturn()
            .getResponse();
    assertThat(aiBatch.getStatus()).isEqualTo(200);
    var result = new ObjectMapper().readTree(aiBatch.getContentAsString());
    assertThat(result.get("tasks").get(0).get("key").asText()).isEqualTo("TASK-1");
    assertThat(result.get("tasks").get(1).get("key").asText()).isEqualTo("TASK-2");
    assertThat(result.get("tasks").get(2).get("key").asText()).isEqualTo("TASK-3");
    assertThat(result.get("links").isArray()).isTrue();
  }

  @Test
  void linkRoutesUseUuidIdentitiesAndRequireRevisionForBothCreationAndDeletion() throws Exception {
    var created =
        mvc.perform(
                post("/api/daily-planner/tasks")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"revision\":0,\"tasks\":[{\"title\":\"First\",\"date\":\"2026-09-25\"},{\"title\":\"Next week\",\"date\":\"2026-09-28\"}]}"))
            .andReturn()
            .getResponse();
    var mapper = new ObjectMapper();
    var tasks = mapper.readTree(created.getContentAsString()).get("tasks");
    String first = tasks.get(0).get("id").asText(), second = tasks.get(1).get("id").asText();
    String body =
        "{\"revision\":1,\"sourceTaskId\":\""
            + first
            + "\",\"targetTaskId\":\""
            + second
            + "\",\"type\":\"related\"}";
    var linked =
        mvc.perform(
                post("/api/daily-planner/links")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(body))
            .andReturn()
            .getResponse();
    assertThat(linked.getStatus()).isEqualTo(200);
    var snapshot = mapper.readTree(linked.getContentAsString());
    String linkId = snapshot.get("links").get(0).get("id").asText();
    assertThat(snapshot.get("revision").asLong()).isEqualTo(2);
    assertThat(
            mvc.perform(
                    post("/api/daily-planner/links")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(409);
    String reverse =
        "{\"revision\":2,\"sourceTaskId\":\""
            + second
            + "\",\"targetTaskId\":\""
            + first
            + "\",\"type\":\"related\"}";
    assertThat(
            mvc.perform(
                    post("/api/daily-planner/links")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(reverse))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(409);
    assertThat(
            mvc.perform(delete("/api/daily-planner/links/" + linkId).param("revision", "1"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(409);
    var removed =
        mvc.perform(delete("/api/daily-planner/links/" + linkId).param("revision", "2"))
            .andReturn()
            .getResponse();
    assertThat(removed.getStatus()).isEqualTo(200);
    var after = mapper.readTree(removed.getContentAsString());
    assertThat(after.get("links").size()).isZero();
    assertThat(after.get("tasks")).isEqualTo(tasks);
    assertThat(after.get("events")).isEqualTo(snapshot.get("events"));
  }
}
