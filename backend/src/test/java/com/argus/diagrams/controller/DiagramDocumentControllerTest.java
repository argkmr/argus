package com.argus.diagrams.controller;

import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ApiExceptionHandler;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.diagrams.service.DiagramDocumentService;
import java.nio.file.Path;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

class DiagramDocumentControllerTest {
  @TempDir Path root;
  final ObjectMapper mapper = new ObjectMapper();
  MockMvc mvc;
  static final String CREATE =
      """
      {"name":"Architecture","snapshot":{
        "structured":{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}},
        "sketch":{"elements":[],"appState":{},"files":{},"libraryItems":[]}}}
      """;

  @BeforeEach
  void setup() {
    var service =
        new DiagramDocumentService(
            new ArgusProperties(root, root, "test", ""), new AtomicJsonStore(mapper), mapper);
    mvc =
        MockMvcBuilders.standaloneSetup(new DiagramDocumentController(service))
            .setControllerAdvice(new ApiExceptionHandler())
            .build();
  }

  @Test
  void roundTripsCreatesUpdatesSummariesArchivingAndRestoration() throws Exception {
    var created =
        mvc.perform(post("/api/diagrams").contentType(MediaType.APPLICATION_JSON).content(CREATE))
            .andReturn()
            .getResponse();
    assertThat(created.getStatus()).isEqualTo(201);
    assertThat(created.getHeader("Cache-Control")).isEqualTo("no-store");
    JsonNode doc = mapper.readTree(created.getContentAsString());
    String path = "/api/diagrams/" + doc.path("id").asText();
    assertThat(doc.path("revision").longValue()).isEqualTo(1);
    var list = mvc.perform(get("/api/diagrams")).andReturn().getResponse();
    assertThat(mapper.readTree(list.getContentAsString()).get(0).has("snapshot")).isFalse();
    var update = mapper.createObjectNode().put("name", "Revised").put("revision", 1);
    update.set("snapshot", doc.get("snapshot"));
    var saved =
        mvc.perform(
                put(path)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(mapper.writeValueAsString(update)))
            .andReturn()
            .getResponse();
    assertThat(saved.getStatus()).isEqualTo(200);
    assertThat(mapper.readTree(saved.getContentAsString()).path("revision").longValue())
        .isEqualTo(2);
    assertThat(
            mvc.perform(
                    put(path)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(update)))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(409);
    assertThat(mvc.perform(delete(path)).andReturn().getResponse().getStatus()).isEqualTo(409);
    assertThat(
            mvc.perform(delete(path).param("revision", "2")).andReturn().getResponse().getStatus())
        .isEqualTo(200);
    assertThat(
            mapper
                .readTree(
                    mvc.perform(get("/api/diagrams"))
                        .andReturn()
                        .getResponse()
                        .getContentAsString())
                .size())
        .isZero();
    assertThat(
            mapper
                .readTree(
                    mvc.perform(get("/api/diagrams").param("archived", "true"))
                        .andReturn()
                        .getResponse()
                        .getContentAsString())
                .get(0)
                .path("archived")
                .booleanValue())
        .isTrue();
    assertThat(
            mvc.perform(
                    post(path + "/restore")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"revision\":3}"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(200);
    JsonNode restored =
        mapper.readTree(mvc.perform(get(path)).andReturn().getResponse().getContentAsString());
    assertThat(restored.path("revision").longValue()).isEqualTo(4);
    assertThat(restored.path("archived").booleanValue()).isFalse();
    assertThat(restored.path("snapshot")).isEqualTo(doc.path("snapshot"));
  }

  @Test
  void malformedDocumentsAndIdsReturnReadableClientErrors() throws Exception {
    assertThat(
            mvc.perform(post("/api/diagrams").contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(400);
    assertThat(mvc.perform(get("/api/diagrams/not-a-uuid")).andReturn().getResponse().getStatus())
        .isEqualTo(400);
    assertThat(
            mvc.perform(get("/api/diagrams/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(404);
  }

  @Test
  void permanentDeleteIsExplicitRevisionCheckedAndNotRestorable() throws Exception {
    JsonNode doc =
        mapper.readTree(
            mvc.perform(
                    post("/api/diagrams").contentType(MediaType.APPLICATION_JSON).content(CREATE))
                .andReturn()
                .getResponse()
                .getContentAsString());
    String path = "/api/diagrams/" + doc.path("id").asText();
    assertThat(mvc.perform(delete(path + "/permanent")).andReturn().getResponse().getStatus())
        .isEqualTo(409);
    assertThat(
            mvc.perform(delete(path + "/permanent").param("revision", "0"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(409);
    assertThat(mvc.perform(get(path)).andReturn().getResponse().getStatus()).isEqualTo(200);
    var deleted =
        mvc.perform(delete(path + "/permanent").param("revision", "1")).andReturn().getResponse();
    assertThat(deleted.getStatus()).isEqualTo(204);
    assertThat(deleted.getHeader("Cache-Control")).isEqualTo("no-store");
    assertThat(mvc.perform(get(path)).andReturn().getResponse().getStatus()).isEqualTo(404);
    assertThat(
            mvc.perform(
                    post(path + "/restore")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"revision\":1}"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(404);
  }
}
