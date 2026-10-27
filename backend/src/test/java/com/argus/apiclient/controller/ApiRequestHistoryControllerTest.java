package com.argus.apiclient.controller;

import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.argus.apiclient.service.ApiRequestHistoryService;
import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ApiExceptionHandler;
import com.argus.common.storage.AtomicJsonStore;
import java.nio.file.Path;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.ObjectMapper;

class ApiRequestHistoryControllerTest {
  @TempDir Path root;
  MockMvc mvc;
  final ObjectMapper mapper = new ObjectMapper();

  @BeforeEach
  void setup() {
    mvc =
        MockMvcBuilders.standaloneSetup(
                new ApiRequestHistoryController(
                    new ApiRequestHistoryService(
                        new AtomicJsonStore(mapper), new ArgusProperties(root, root, "test", ""))))
            .setControllerAdvice(new ApiExceptionHandler())
            .build();
  }

  @Test
  void createsListsRestoresUpdatesAndDeletesWithoutLeakingBodiesIntoTheList() throws Exception {
    String id = UUID.randomUUID().toString();
    String request =
        """
        {"id":"%s","snapshot":{"version":1,"kind":"draft","request":{"name":"My API","method":"POST","url":"{{URL}}/"},"editor":{"body":"unfinished secret draft"},"environmentId":"qa","response":null}}
        """
            .formatted(id);
    var saved =
        mvc.perform(
                post("/api/api-request-history")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(request))
            .andReturn()
            .getResponse();
    assertThat(saved.getStatus()).isEqualTo(201);
    assertThat(saved.getHeader("Cache-Control")).isEqualTo("no-store");
    assertThat(saved.getContentAsString())
        .contains(id, "My API")
        .doesNotContain("unfinished secret draft");
    var list = mvc.perform(get("/api/api-request-history")).andReturn().getResponse();
    assertThat(list.getStatus()).isEqualTo(200);
    assertThat(list.getHeader("Cache-Control")).isEqualTo("no-store");
    assertThat(mapper.readTree(list.getContentAsString())).hasSize(1);
    assertThat(list.getContentAsString())
        .doesNotContain("unfinished secret draft", "snapshot", "editor");
    var restored = mvc.perform(get("/api/api-request-history/" + id)).andReturn().getResponse();
    assertThat(restored.getStatus()).isEqualTo(200);
    assertThat(restored.getHeader("Cache-Control")).isEqualTo("no-store");
    assertThat(mapper.readTree(restored.getContentAsString()).get("snapshot"))
        .isEqualTo(mapper.readTree(request).get("snapshot"));
    var updated =
        mvc.perform(
                post("/api/api-request-history")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(request.replace("\"kind\":\"draft\"", "\"kind\":\"failed\"")))
            .andReturn()
            .getResponse();
    assertThat(updated.getStatus()).isEqualTo(201);
    assertThat(updated.getContentAsString()).contains("\"kind\":\"failed\"");
    assertThat(
            mvc.perform(delete("/api/api-request-history/" + id))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(200);
    assertThat(
            mvc.perform(get("/api/api-request-history/" + id))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(404);
  }

  @Test
  void malformedPayloadAndIdsReturnSafeReadable400s() throws Exception {
    for (String value :
        new String[] {"null", "[]", "{}", "{", "{\"id\":\"bad\",\"snapshot\":{}}"}) {
      var response =
          mvc.perform(
                  post("/api/api-request-history")
                      .contentType(MediaType.APPLICATION_JSON)
                      .content(value))
              .andReturn()
              .getResponse();
      assertThat(response.getStatus()).isEqualTo(400);
      assertThat(response.getContentAsString()).contains("error");
    }
    assertThat(
            mvc.perform(get("/api/api-request-history/not-a-uuid"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(400);
    assertThat(
            mvc.perform(delete("/api/api-request-history/not-a-uuid"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(400);
    assertThat(
            mvc.perform(get("/api/api-request-history/" + UUID.randomUUID()))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(404);
  }
}
