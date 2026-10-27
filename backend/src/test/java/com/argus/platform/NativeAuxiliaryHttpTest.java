package com.argus.platform;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.argus.apiclient.controller.*;
import com.argus.apiclient.repository.*;
import com.argus.apiclient.service.*;
import com.argus.background.service.*;
import com.argus.backup.controller.BackupController;
import com.argus.backup.service.*;
import com.argus.browser.controller.BrowserPairingController;
import com.argus.browser.service.BrowserPairingService;
import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ApiExceptionHandler;
import com.argus.common.security.KeychainSecretStore;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.documents.controller.SourceReferenceController;
import com.argus.documents.service.*;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.dto.WorkspaceResponse;
import com.argus.workspace.service.WorkspaceService;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.ObjectMapper;

/**
 * Real native controllers and services in an isolated Spring MVC runtime; no bridge or live
 * credentials.
 */
class NativeAuxiliaryHttpTest {
  @TempDir Path temporary;
  final ObjectMapper json = new ObjectMapper();

  ArgusProperties properties() {
    return new ArgusProperties(
        temporary.resolve("data"), temporary.resolve("source"), "test", "token");
  }

  MockMvc mvc(Object... controllers) {
    return MockMvcBuilders.standaloneSetup(controllers)
        .setControllerAdvice(new ApiExceptionHandler())
        .addFilters(new LocalApiBoundaryFilter(properties()))
        .build();
  }

  static MockHttpServletRequestBuilder local(MockHttpServletRequestBuilder request) {
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
  void documentUrlsServeFormattedBytesAndExactDownloadsWithScopeAndSecurityHeaders()
      throws Exception {
    Path root = temporary.toRealPath().resolve("repository");
    Files.createDirectories(root);
    var repository = new Repository("repo", "Repository", root.toString(), "");
    var workspace = mock(WorkspaceService.class);
    when(workspace.snapshot())
        .thenReturn(
            new WorkspaceResponse(
                1, "repo", Map.of(), List.of(repository), List.of(), List.of(), Map.of()));
    byte[] pdf = "%PDF-1.7\nfixture".getBytes(java.nio.charset.StandardCharsets.UTF_8);
    Files.write(root.resolve("Résumé + 100%.pdf"), pdf);
    Files.writeString(root.resolve("guide.md"), "# Heading\n\n**Bold**");
    var bytes = new ByteArrayOutputStream();
    try (var zip = new ZipOutputStream(bytes)) {
      for (String name : List.of("[Content_Types].xml", "word/document.xml")) {
        zip.putNextEntry(new ZipEntry(name));
        zip.write("<document/>".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        zip.closeEntry();
      }
    }
    Files.write(root.resolve("report.docx"), bytes.toByteArray());
    var word = new WordPreviewService();
    try {
      var mvc =
          mvc(
              new SourceReferenceController(
                  new SourceReferenceService(workspace, word),
                  mock(SourceReferenceRevealService.class)));
      var metadataResponse =
          mvc.perform(
                  local(
                      get("/api/source-reference")
                          .param("target", "Résumé + 100%25.pdf")
                          .param("repositoryId", "repo")))
              .andReturn()
              .getResponse();
      assertThat(metadataResponse.getStatus()).isEqualTo(200);
      Map<?, ?> metadata = json.readValue(metadataResponse.getContentAsByteArray(), Map.class);
      assertThat(metadata.get("previewType")).isEqualTo("pdf");
      var inline =
          mvc.perform(local(get(URI.create(metadata.get("contentUrl").toString()))))
              .andReturn()
              .getResponse();
      assertThat(inline.getStatus()).isEqualTo(200);
      assertThat(inline.getContentAsByteArray()).isEqualTo(pdf);
      assertThat(inline.getHeader("Content-Disposition")).startsWith("inline;");
      var download =
          mvc.perform(local(get(URI.create(metadata.get("downloadUrl").toString()))))
              .andReturn()
              .getResponse();
      assertThat(download.getContentAsByteArray()).isEqualTo(pdf);
      assertThat(download.getHeader("Content-Disposition")).startsWith("attachment;");
      assertThat(download.getHeader("Cache-Control")).isEqualTo("no-store");
      assertThat(download.getHeader("X-Content-Type-Options")).isEqualTo("nosniff");
      var docx =
          mvc.perform(
                  local(
                      get("/api/source-reference/content")
                          .param("target", "report.docx")
                          .param("preview", "docx")))
              .andReturn()
              .getResponse();
      assertThat(docx.getStatus()).isEqualTo(200);
      assertThat(docx.getContentAsByteArray()).isEqualTo(bytes.toByteArray());
      var markdown =
          mvc.perform(local(get("/api/source-reference").param("target", "guide.md")))
              .andReturn()
              .getResponse();
      assertThat(json.readValue(markdown.getContentAsByteArray(), Map.class))
          .containsEntry("kind", "text")
          .containsEntry("content", "# Heading\n\n**Bold**");
      assertThat(
              mvc.perform(
                      local(
                          get("/api/source-reference/content")
                              .param("target", "../outside")
                              .param("download", "true")))
                  .andReturn()
                  .getResponse()
                  .getStatus())
          .isEqualTo(403);
      assertThat(
              mvc.perform(
                      local(get("/api/source-reference").param("target", "guide.md"))
                          .header("Origin", "https://evil.test"))
                  .andReturn()
                  .getResponse()
                  .getStatus())
          .isEqualTo(403);
    } finally {
      word.close();
    }
  }

  @Test
  void nativeCollectionAndEnvironmentRoutesPersistWithoutLegacyBridge() throws Exception {
    var workspace = mock(WorkspaceService.class);
    when(workspace.snapshot())
        .thenReturn(
            new WorkspaceResponse(1, "", Map.of(), List.of(), List.of(), List.of(), Map.of()));
    var store = new AtomicJsonStore(json);
    var collections =
        new ApiCollectionService(
            new ApiCollectionRepository(temporary.resolve("api"), store), workspace);
    var environments = new ApiEnvironmentService(new ApiEnvironmentRepository(store, properties()));
    var files = mock(ApiFileService.class);
    var mvc =
        mvc(
            new ApiCollectionController(collections, files),
            new ApiEnvironmentController(environments));
    var created =
        mvc.perform(
                local(
                    post("/api/api-collections")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(
                            "{\"repositoryId\":\"standalone-api-client\",\"name\":\"Local\"}")))
            .andReturn()
            .getResponse();
    assertThat(created.getStatus()).isEqualTo(201);
    String id = json.readValue(created.getContentAsByteArray(), Map.class).get("id").toString();
    var request =
        mvc.perform(
                local(
                    post("/api/api-requests")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(
                            json.writeValueAsString(
                                Map.of(
                                    "repositoryId",
                                    "standalone-api-client",
                                    "collectionId",
                                    id,
                                    "url",
                                    "https://example.test",
                                    "name",
                                    "A request")))))
            .andReturn()
            .getResponse();
    assertThat(request.getStatus()).isEqualTo(201);
    var listed =
        mvc.perform(local(get("/api/repositories/standalone-api-client/api-requests")))
            .andReturn()
            .getResponse();
    assertThat(json.readValue(listed.getContentAsByteArray(), List.class)).hasSize(1);
    var environment =
        mvc.perform(
                local(
                    post("/api/api-environments")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(
                            "{\"name\":\"Development\",\"valuesText\":\"HOST=localhost;PORT=3000\"}")))
            .andReturn()
            .getResponse();
    assertThat(environment.getStatus()).isEqualTo(201);
    assertThat(environments.list()).hasSize(1);
    assertThat(environments.list().get(0).values()).containsEntry("PORT", "3000");
    verifyNoInteractions(files);
  }

  @Test
  void pairingCodesAndBackupConfirmationsDoNotExposeTokensOrStartUnconfirmedWrites()
      throws Exception {
    var secrets = mock(KeychainSecretStore.class);
    when(secrets.getLocal(anyString(), anyString())).thenReturn("");
    var pairing = new BrowserPairingService(secrets);
    var backup = mock(BackupService.class);
    when(backup.plan(anyString(), anyString()))
        .thenReturn(Map.of("retention", "latest snapshot only"));
    var workspace = mock(WorkspaceService.class);
    when(workspace.snapshot())
        .thenReturn(
            new WorkspaceResponse(
                1,
                "",
                Map.of(
                    "backup",
                    Map.of(
                        "repositoryUrl",
                        "https://bitbucket.org/example/backup",
                        "driveDirectory",
                        temporary.toString())),
                List.of(),
                List.of(),
                List.of(),
                Map.of()));
    var jobs = new BackgroundJobService(new AtomicJsonStore(json), properties());
    var maintenance = mock(RestoreMaintenanceService.class);
    var owner = mock(BackupOwnerAccess.class);
    when(owner.allowed()).thenReturn(true);
    var coordinator =
        new BackupCoordinator(
            backup,
            workspace,
            secrets,
            mock(GoogleDriveDetector.class),
            jobs,
            new BackgroundOperationService(jobs),
            maintenance,
            owner);
    try {
      var mvc =
          mvc(
              new BrowserPairingController(pairing),
              new BackupController(coordinator, mock(DataStorageService.class)));
      var pairingStart =
          mvc.perform(local(post("/api/browser-extension/pair/start"))).andReturn().getResponse();
      assertThat(pairingStart.getStatus()).isEqualTo(201);
      assertThat(json.readValue(pairingStart.getContentAsByteArray(), Map.class))
          .containsKey("code")
          .doesNotContainKey("token");
      var unconfirmed =
          mvc.perform(
                  local(
                      post("/api/backup/sync")
                          .contentType(MediaType.APPLICATION_JSON)
                          .content("{}")))
              .andReturn()
              .getResponse();
      assertThat(unconfirmed.getStatus()).isEqualTo(409);
      var confirmation =
          mvc.perform(
                  local(
                      post("/api/backup/confirmation")
                          .contentType(MediaType.APPLICATION_JSON)
                          .content(
                              json.writeValueAsString(
                                  Map.of(
                                      "repositoryUrl",
                                      "https://bitbucket.org/example/backup",
                                      "driveDirectory",
                                      temporary.toString())))))
              .andReturn()
              .getResponse();
      assertThat(confirmation.getStatus()).isEqualTo(201);
      assertThat(json.readValue(confirmation.getContentAsByteArray(), Map.class))
          .containsKeys("confirmationId", "expiresAt", "plan");
      verify(backup, never()).sync(anyString(), anyString(), anyString(), anyList(), any());
      verifyNoInteractions(maintenance);
      verify(secrets, never()).setLocal(anyString(), anyString(), anyString());
    } finally {
      coordinator.close();
    }
  }
}
