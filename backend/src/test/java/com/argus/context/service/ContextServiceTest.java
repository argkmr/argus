package com.argus.context.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.context.dto.SaveContextRequest;
import com.argus.context.repository.ContextRepository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mockito;
import tools.jackson.databind.ObjectMapper;

class ContextServiceTest {
  @Test
  void pureUploadValidationPreservesJavaDefaultsAndTwentyMegabyteBinaryLimitWithoutWrites() {
    var repository = Mockito.mock(ContextRepository.class);
    var service = new ContextService(repository);
    var paste =
        service.validatedRequest(
            new SaveContextRequest(null, " ", null, "Context", null, null, null));
    assertThat(paste.kind()).isEqualTo("paste");
    assertThat(paste.title()).isEqualTo("Pasted context");
    assertThat(paste.url()).isEmpty();
    assertThat(paste.repositoryId()).isEmpty();
    String binary = Base64.getEncoder().encodeToString(new byte[20_000_000]);
    assertThat(
            service
                .validatedRequest(
                    new SaveContextRequest("file", "file.bin", null, null, binary, null, "repo-a"))
                .contentBase64())
        .isEqualTo(binary);
    String oversized = Base64.getEncoder().encodeToString(new byte[20_000_001]);
    assertThatThrownBy(
            () ->
                service.validatedRequest(
                    new SaveContextRequest(
                        "file", "file.bin", null, null, oversized, null, "repo-a")))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("20 MB");
    assertThatThrownBy(
            () ->
                service.validatedRequest(
                    new SaveContextRequest(
                        "file", "file.bin", null, null, "%%%invalid-base64", null, "repo-a")))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("invalid");
    assertThatThrownBy(
            () ->
                service.validatedRequest(
                    new SaveContextRequest("image", null, null, null, "AA==", null, "repo-a")))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("PNG");
    Mockito.verifyNoInteractions(repository);
  }

  @Test
  void savesPastedImagesAsPrivateBinaryAttachments(@TempDir Path directory) throws Exception {
    ObjectMapper mapper = new ObjectMapper();
    ArgusProperties properties =
        new ArgusProperties(directory, directory.resolve("source"), "test", "token");
    ContextRepository repository =
        new ContextRepository(properties, new AtomicJsonStore(mapper), mapper);
    ContextService service = new ContextService(repository);
    byte[] png = {(byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a};

    var attachment =
        service.save(
            new SaveContextRequest(
                "image",
                "Screenshot.png",
                null,
                null,
                Base64.getEncoder().encodeToString(png),
                "image/png",
                "orders"));

    assertThat(attachment.kind()).isEqualTo("image");
    assertThat(attachment.mimeType()).isEqualTo("image/png");
    assertThat(attachment.path()).endsWith(".png");
    assertThat(Files.readAllBytes(Path.of(attachment.path()))).isEqualTo(png);
    assertThat(repository.require(attachment.id())).isEqualTo(attachment);
  }

  @Test
  void savesSelectedFilesWithoutChangingTheirBytes(@TempDir Path directory) throws Exception {
    ObjectMapper mapper = new ObjectMapper();
    ArgusProperties properties =
        new ArgusProperties(directory, directory.resolve("source"), "test", "token");
    ContextRepository repository =
        new ContextRepository(properties, new AtomicJsonStore(mapper), mapper);
    ContextService service = new ContextService(repository);
    byte[] pdf = "%PDF-1.7\nprivate context".getBytes(java.nio.charset.StandardCharsets.UTF_8);

    var attachment =
        service.save(
            new SaveContextRequest(
                "file",
                "incident-report.pdf",
                null,
                null,
                Base64.getEncoder().encodeToString(pdf),
                "application/pdf",
                "orders"));

    assertThat(attachment.kind()).isEqualTo("file");
    assertThat(attachment.mimeType()).isEqualTo("application/pdf");
    assertThat(attachment.path()).endsWith(".pdf");
    assertThat(Files.readAllBytes(Path.of(attachment.path()))).isEqualTo(pdf);
  }
}
