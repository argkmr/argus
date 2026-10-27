package com.argus.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.argus.browser.service.BrowserPairingService;
import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ApiExceptionHandler;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.context.controller.ContextController;
import com.argus.context.repository.ContextRepository;
import com.argus.context.service.ContextService;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mockito;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.ObjectMapper;

class BrowserContextBoundaryTest {
  private static final String EXTENSION = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  @Test
  void nativeUploadsVerifyPairingBeforeAnyPrivateWrite(@TempDir Path directory) throws Exception {
    var properties = new ArgusProperties(directory, directory.resolve("source"), "test", "token");
    var mapper = new ObjectMapper();
    var repository = new ContextRepository(properties, new AtomicJsonStore(mapper), mapper);
    var contexts = new ContextService(repository);
    var pairing = Mockito.mock(BrowserPairingService.class);
    Mockito.when(pairing.verify("paired-extension-token")).thenReturn(true);
    var mvc =
        MockMvcBuilders.standaloneSetup(new ContextController(contexts, pairing))
            .setControllerAdvice(new ApiExceptionHandler())
            .addFilters(new LocalApiBoundaryFilter(properties))
            .build();
    String payload =
        "{\"title\":\"Shared tab\",\"url\":\"https://example.test/page\",\"content\":\"Saved browser text\",\"repositoryId\":\"repo-a\"}";
    var unpaired =
        mvc.perform(localPost(payload).header("Origin", EXTENSION)).andReturn().getResponse();
    assertThat(unpaired.getStatus()).isEqualTo(401);
    assertThat(unpaired.getHeader("Access-Control-Allow-Origin")).isEqualTo(EXTENSION);
    assertThat(repository.list()).isEmpty();
    var paired =
        mvc.perform(
                localPost(payload)
                    .header("Origin", EXTENSION)
                    .header("Authorization", "Bearer paired-extension-token"))
            .andReturn()
            .getResponse();
    assertThat(paired.getStatus()).isEqualTo(201);
    assertThat(repository.list()).hasSize(1);
    var saved = repository.list().get(0);
    assertThat(saved.kind()).isEqualTo("browser");
    assertThat(saved.repositoryId()).isEqualTo("repo-a");
    assertThat(Files.readString(Path.of(saved.path())))
        .contains("Saved browser text", "Source: https://example.test/page");
    var hostile =
        mvc.perform(localPost(payload).header("Origin", "https://attacker.example"))
            .andReturn()
            .getResponse();
    assertThat(hostile.getStatus()).isEqualTo(403);
    assertThat(repository.list()).hasSize(1);
    var local =
        mvc.perform(localPost(payload).header("Origin", "http://127.0.0.1:4173"))
            .andReturn()
            .getResponse();
    assertThat(local.getStatus()).isEqualTo(201);
    assertThat(repository.list()).hasSize(2);
  }

  private static MockHttpServletRequestBuilder localPost(String body) {
    return post("/api/browser-context")
        .contentType(MediaType.APPLICATION_JSON)
        .content(body)
        .header("Host", "127.0.0.1:4173")
        .with(
            request -> {
              request.setRemoteAddr("127.0.0.1");
              request.setLocalPort(4173);
              return request;
            });
  }
}
