package com.argus.context.service;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ApiExceptionHandler;
import com.argus.common.error.NotFoundException;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.context.controller.ContextPreviewController;
import com.argus.context.domain.ContextAttachment;
import com.argus.context.dto.SaveContextRequest;
import com.argus.context.repository.ContextRepository;
import com.argus.documents.service.WordPreviewService;
import com.argus.platform.LocalApiBoundaryFilter;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.domain.TaskCheckpoint;
import com.argus.tasks.domain.TaskMessage;
import com.argus.tasks.dto.TaskSummary;
import com.argus.tasks.repository.TaskRepository;
import java.io.ByteArrayOutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;

class ContextPreviewServiceTest {
  @TempDir Path directory;

  record Fixture(
      ContextService contexts,
      ContextRepository repository,
      TaskRepository tasks,
      ContextPreviewService previews,
      ObjectMapper mapper,
      ArgusProperties properties) {}

  Fixture fixture() {
    var mapper = new ObjectMapper();
    var properties = new ArgusProperties(directory, directory.resolve("source"), "test", "token");
    var repository = new ContextRepository(properties, new AtomicJsonStore(mapper), mapper);
    var contexts = new ContextService(repository);
    var tasks = mock(TaskRepository.class);
    when(tasks.list()).thenReturn(List.of());
    return new Fixture(
        contexts,
        repository,
        tasks,
        new ContextPreviewService(contexts, repository, tasks, new WordPreviewService(), mapper),
        mapper,
        properties);
  }

  ContextAttachment file(Fixture f, String name, String mime, byte[] bytes) {
    return f.contexts.save(
        new SaveContextRequest(
            "file", name, null, null, Base64.getEncoder().encodeToString(bytes), mime, "repo"));
  }

  static byte[] bytes(String text) {
    return text.getBytes(StandardCharsets.UTF_8);
  }

  @Test
  void textAndPastedContextShowExactTextAndDownloadUnchangedStorageBytes() throws Exception {
    var f = fixture();
    String text = "  First line\n<script>never execute()</script>\nLast line\n";
    for (String name :
        List.of(
            "notes.txt",
            "code.js",
            "config.json",
            "rows.csv",
            "notes.md",
            "page.html",
            "icon.svg")) {
      var item = file(f, name, "image/png", bytes(text));
      var preview = f.previews.preview(item.id());
      assertThat(preview)
          .containsEntry("previewType", "text")
          .containsEntry("content", text)
          .containsEntry("kind", "file");
      assertThat(preview).doesNotContainKey("path");
      var content = f.previews.content(item.id(), false, null);
      assertThat(content.headers()).containsEntry("content-type", "text/plain; charset=utf-8");
      assertThat(content.bytes()).isEqualTo(bytes(text));
    }
    for (String kind : List.of("paste", "browser")) {
      var item =
          f.contexts.save(
              new SaveContextRequest(
                  kind, "Saved context", "https://example.test/", text, null, null, "repo"));
      byte[] stored = Files.readAllBytes(Path.of(item.path()));
      assertThat(f.previews.preview(item.id()))
          .containsEntry("content", text)
          .containsEntry("kind", kind);
      assertThat(f.previews.content(item.id(), true, null).bytes()).isEqualTo(stored);
      assertThat(new String(stored, StandardCharsets.UTF_8))
          .contains("Captured: " + item.createdAt());
    }
  }

  @Test
  void storageHeaderIsOnlyRemovedWhenTheExactSavedPrefixMatches() throws Exception {
    var f = fixture();
    var item =
        f.contexts.save(
            new SaveContextRequest("paste", "Saved", null, "Original", null, null, "repo"));
    String changed = "# Saved\n\nCaptured: not-the-recorded-time\n\n---\n\nKeep this whole text\n";
    Files.writeString(Path.of(item.path()), changed);
    assertThat(f.previews.preview(item.id())).containsEntry("content", changed);
  }

  @Test
  void supportedMediaRequiresMatchingBytesRatherThanTrustingClaimedMime() {
    var f = fixture();
    Map<String, byte[]> fixtures =
        Map.ofEntries(
            Map.entry("screen.png", new byte[] {(byte) 0x89, 80, 78, 71, 13, 10, 26, 10}),
            Map.entry("photo.jpg", new byte[] {(byte) 0xff, (byte) 0xd8, (byte) 0xff, 0}),
            Map.entry("animation.gif", bytes("GIF89a")),
            Map.entry("screen.webp", bytes("RIFF1234WEBP")),
            Map.entry("voice.mp3", bytes("ID3recording")),
            Map.entry("voice.wav", bytes("RIFF1234WAVE")),
            Map.entry("voice.ogg", bytes("OggSrecording")),
            Map.entry("voice.flac", bytes("fLaCrecording")),
            Map.entry(
                "voice.m4a", new byte[] {0, 0, 0, 24, 'f', 't', 'y', 'p', 'M', '4', 'A', ' '}),
            Map.entry(
                "movie.mp4", new byte[] {0, 0, 0, 24, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm'}),
            Map.entry("movie.webm", new byte[] {0x1a, 0x45, (byte) 0xdf, (byte) 0xa3, 0}));
    for (var entry : fixtures.entrySet()) {
      var item = file(f, entry.getKey(), "text/html", entry.getValue());
      String type =
          entry.getKey().startsWith("voice")
              ? "audio"
              : entry.getKey().startsWith("movie") ? "video" : "image";
      var preview = f.previews.preview(item.id());
      assertThat(preview).containsEntry("previewType", type);
      assertThat(preview.get("contentUrl")).isEqualTo("/api/context/" + item.id() + "/content");
      var content = f.previews.content(item.id(), false, null);
      assertThat(content.headers().get("content-type")).startsWith(type + "/");
      assertThat(content.headers().get("content-disposition")).startsWith("inline;");
      assertThat(content.bytes()).isEqualTo(entry.getValue());
    }
    for (String name : List.of("spoof.png", "spoof.mp3", "spoof.mp4", "spoof.webm")) {
      var item = file(f, name, "image/png", bytes("<html><script>bad()</script></html>"));
      assertThat(f.previews.preview(item.id())).containsEntry("previewType", "text");
      assertThat(f.previews.content(item.id(), false, null).headers())
          .containsEntry("content-type", "text/plain; charset=utf-8");
    }
  }

  @Test
  void pdfAndWordUseTheExistingSafeDocumentPipelineAndOriginalDownloads() throws Exception {
    var f = fixture();
    var pdf = file(f, "Résumé 日本語.pdf", "application/pdf", bytes("%PDF-1.7\nfixture"));
    assertThat(f.previews.preview(pdf.id())).containsEntry("previewType", "pdf");
    assertThat(f.previews.content(pdf.id(), false, null).headers())
        .containsEntry("content-type", "application/pdf");
    byte[] original;
    var output = new ByteArrayOutputStream();
    try (var zip = new ZipOutputStream(output)) {
      for (var part :
          Map.of(
                  "[Content_Types].xml",
                  "<Types/>",
                  "word/document.xml",
                  "<document><p>Safe text</p></document>")
              .entrySet()) {
        zip.putNextEntry(new ZipEntry(part.getKey()));
        zip.write(bytes(part.getValue()));
        zip.closeEntry();
      }
    }
    original = output.toByteArray();
    var word = file(f, "report.docx", "application/octet-stream", original);
    assertThat(f.previews.preview(word.id()))
        .containsEntry("previewType", "docx")
        .containsEntry("contentUrl", "/api/context/" + word.id() + "/content?preview=docx");
    assertThat(f.previews.content(word.id(), false, "docx").bytes()).isEqualTo(original);
    assertThat(f.previews.content(word.id(), true, "docx").bytes()).isEqualTo(original);
    var invalid =
        file(f, "invalid.docx", "application/octet-stream", bytes("<script>no archive</script>"));
    assertThat(f.previews.preview(invalid.id()))
        .containsEntry("previewType", "download")
        .containsEntry("contentUrl", null);
    assertThatThrownBy(() -> f.previews.content(invalid.id(), false, "docx"))
        .isInstanceOf(ResponseStatusException.class);
    assertThat(f.previews.content(invalid.id(), true, null).bytes())
        .isEqualTo(bytes("<script>no archive</script>"));
  }

  @Test
  void unknownBinaryAndOversizedTextKeepAnOriginalDownloadWithoutUnsafePreview() {
    var f = fixture();
    for (byte[] body :
        List.of(
            new byte[] {0, 1, 2, 3},
            new byte[] {(byte) 0xff, (byte) 0xfe},
            bytes("x".repeat(2 * 1024 * 1024 + 1)))) {
      var item = file(f, "unknown.bin", "text/html", body);
      assertThat(f.previews.preview(item.id()))
          .containsEntry("previewType", "download")
          .containsEntry("contentUrl", null);
      var content = f.previews.content(item.id(), false, null);
      assertThat(content.headers()).containsEntry("content-type", "application/octet-stream");
      assertThat(content.headers().get("content-disposition")).startsWith("attachment;");
      assertThat(content.bytes()).isEqualTo(body);
    }
  }

  @Test
  void missingIdsMalformedIdsMissingFilesAndDirectoriesFailClosed() throws Exception {
    var f = fixture();
    for (String id : List.of("../secret", "%2e%2e%2fsecret", "/etc/passwd", "not-an-id"))
      assertThatThrownBy(() -> f.previews.preview(id))
          .isInstanceOf(ResponseStatusException.class)
          .satisfies(
              error ->
                  assertThat(((ResponseStatusException) error).getStatusCode().value())
                      .isEqualTo(400));
    assertThatThrownBy(() -> f.previews.preview(UUID.randomUUID().toString()))
        .isInstanceOf(NotFoundException.class);
    var item = file(f, "gone.txt", "text/plain", bytes("gone"));
    Files.delete(Path.of(item.path()));
    assertThatThrownBy(() -> f.previews.content(item.id(), false, null))
        .isInstanceOf(NotFoundException.class);
    Files.createDirectory(Path.of(item.path()));
    assertThatThrownBy(() -> f.previews.preview(item.id()))
        .isInstanceOf(ResponseStatusException.class)
        .satisfies(
            error ->
                assertThat(((ResponseStatusException) error).getStatusCode().value())
                    .isEqualTo(403));
  }

  @Test
  void savedPathTraversalAndSymlinkEscapesNeverExposeOutsideFiles() throws Exception {
    var f = fixture();
    var item = file(f, "safe.txt", "text/plain", bytes("inside"));
    Path outside = Files.writeString(directory.resolve("private.txt"), "outside secret");
    for (String unsafe :
        List.of(
            outside.toString(), f.repository.directory().resolve("../private.txt").toString())) {
      f.repository.replace(List.of(copy(item, unsafe)));
      assertThatThrownBy(() -> f.previews.content(item.id(), true, null))
          .isInstanceOf(ResponseStatusException.class);
    }
    Path link = f.repository.directory().resolve("link.txt");
    Files.createSymbolicLink(link, outside);
    f.repository.replace(List.of(copy(item, link.toString())));
    assertThatThrownBy(() -> f.previews.preview(item.id()))
        .isInstanceOf(ResponseStatusException.class);
    assertThat(Files.readString(outside)).isEqualTo("outside secret");
  }

  @Test
  void oversizedAndUnreadableSavedFilesAreRejectedWithoutTrustingIndexSize() throws Exception {
    var f = fixture();
    var item = file(f, "large.bin", "application/octet-stream", bytes("small"));
    try (var file = new RandomAccessFile(item.path(), "rw")) {
      file.setLength(20_000_000 + 65_537);
    }
    assertThatThrownBy(() -> f.previews.content(item.id(), true, null))
        .isInstanceOf(ResponseStatusException.class)
        .satisfies(
            error ->
                assertThat(((ResponseStatusException) error).getStatusCode().value())
                    .isEqualTo(413));
    var unreadable = file(f, "unreadable.txt", "text/plain", bytes("private"));
    Path path = Path.of(unreadable.path());
    var permissions = Files.getPosixFilePermissions(path);
    try {
      Files.setPosixFilePermissions(path, Set.of());
      if (!Files.isReadable(path))
        assertThatThrownBy(() -> f.previews.preview(unreadable.id()))
            .isInstanceOf(ResponseStatusException.class);
    } finally {
      Files.setPosixFilePermissions(path, permissions);
    }
  }

  @Test
  void oldSavedMessagesCheckpointsAndRevisionsResolveTrimmedIdsWithoutWritingIndexes()
      throws Exception {
    var f = fixture();
    var item = file(f, "older.txt", "text/plain", bytes("Saved in older chat"));
    @SuppressWarnings("unchecked")
    Map<String, Object> attachment = f.mapper.convertValue(item, Map.class);
    var task = new AiTask();
    task.id = "task";
    var message = new TaskMessage();
    message.id = "message";
    message.attachments = List.of(attachment);
    var summary =
        new TaskSummary(
            "task",
            "repository",
            "repo",
            List.of(),
            "Older chat",
            "codex",
            "edit",
            null,
            null,
            null,
            "history",
            1,
            1,
            0,
            "now",
            "now",
            null,
            null,
            null,
            0L);
    when(f.tasks.list()).thenReturn(List.of(summary));
    when(f.tasks.readTask("task")).thenReturn(task);
    f.repository.replace(List.of());
    byte[] index = Files.readAllBytes(f.repository.directory().resolve("index.json"));
    for (String location : List.of("message", "checkpoint", "revision", "archive")) {
      task.messages = location.equals("message") ? List.of(message) : List.of();
      task.checkpoints =
          location.equals("checkpoint")
              ? List.of(new TaskCheckpoint("message", "now", message))
              : List.of();
      task.additionalProperties().clear();
      if (location.equals("revision"))
        task.additionalProperties()
            .put("revisionDraft", Map.of("attachments", List.of(attachment)));
      if (location.equals("archive")) {
        task.additionalProperties().put("revisionCount", 1);
        var previous = new AiTask();
        previous.messages = List.of(message);
        when(f.tasks.revisions("task")).thenReturn(List.of(Map.of("id", "version")));
        when(f.tasks.revision("task", "version")).thenReturn(Map.of("task", previous));
      }
      var previews =
          new ContextPreviewService(
              f.contexts, f.repository, f.tasks, new WordPreviewService(), f.mapper);
      assertThat(previews.preview(item.id())).containsEntry("content", "Saved in older chat");
    }
    assertThat(Files.readAllBytes(f.repository.directory().resolve("index.json"))).isEqualTo(index);
  }

  @Test
  void recoveredIdentityCacheAvoidsRepeatTaskScansButNeverCachesBytesOrSafetyChecks()
      throws Exception {
    var f = fixture();
    var item = file(f, "old.txt", "text/plain", bytes("Original"));
    @SuppressWarnings("unchecked")
    Map<String, Object> metadata = f.mapper.convertValue(item, Map.class);
    savedTask(f, List.of(metadata));
    f.repository.replace(List.of());
    assertThat(f.previews.preview(item.id())).containsEntry("content", "Original");
    Path path = Path.of(item.path());
    Files.writeString(path, "Changed on disk");
    assertThat(f.previews.content(item.id(), true, null).bytes())
        .isEqualTo(bytes("Changed on disk"));
    verify(f.tasks, times(1)).readTask("task");
    Files.delete(path);
    assertThatThrownBy(() -> f.previews.preview(item.id())).isInstanceOf(NotFoundException.class);
    Files.writeString(path, "Recovered after missing file");
    assertThat(f.previews.preview(item.id()))
        .containsEntry("content", "Recovered after missing file");
    verify(f.tasks, times(3)).readTask("task");
    Path outside = Files.writeString(directory.resolve("private.txt"), "Private outside context");
    Files.delete(path);
    Files.createSymbolicLink(path, outside);
    assertThatThrownBy(() -> f.previews.content(item.id(), true, null))
        .isInstanceOf(ResponseStatusException.class);
    assertThat(Files.readString(outside)).isEqualTo("Private outside context");
  }

  @Test
  void recoveredIdentityCacheRetainsAtMost128SuccessfulEntries() {
    var f = fixture();
    var item = file(f, "older.txt", "text/plain", bytes("Existing stored file"));
    @SuppressWarnings("unchecked")
    Map<String, Object> metadata = f.mapper.convertValue(item, Map.class);
    var snapshots = new ArrayList<Map<String, Object>>();
    for (int index = 0; index < 129; index++) {
      var snapshot = new LinkedHashMap<>(metadata);
      snapshot.put("id", UUID.randomUUID().toString());
      snapshots.add(snapshot);
    }
    savedTask(f, snapshots);
    f.repository.replace(List.of());
    for (var snapshot : snapshots) f.previews.preview((String) snapshot.get("id"));
    verify(f.tasks, times(129)).readTask("task");
    f.previews.preview((String) snapshots.get(128).get("id"));
    verify(f.tasks, times(129)).readTask("task");
    f.previews.preview((String) snapshots.get(0).get("id"));
    verify(f.tasks, times(130)).readTask("task");
  }

  private static void savedTask(Fixture f, List<Map<String, Object>> attachments) {
    var task = new AiTask();
    task.id = "task";
    var message = new TaskMessage();
    message.attachments = attachments;
    task.messages = List.of(message);
    var summary =
        new TaskSummary(
            "task",
            "repository",
            "repo",
            List.of(),
            "Older chat",
            "codex",
            "edit",
            null,
            null,
            null,
            "history",
            1,
            1,
            0,
            "now",
            "now",
            null,
            null,
            null,
            0L);
    when(f.tasks.list()).thenReturn(List.of(summary));
    when(f.tasks.readTask("task")).thenReturn(task);
  }

  @Test
  void restoredDirectoryPrefixesResolveOnlyAnExactSavedBasenameInsideCurrentStorage()
      throws Exception {
    var f = fixture();
    var item = file(f, "restored.txt", "text/plain", bytes("Restored safely"));
    String oldPath =
        directory
            .resolve("missing-old-data/context-attachments")
            .resolve(Path.of(item.path()).getFileName())
            .toString();
    f.repository.replace(List.of(copy(item, oldPath)));
    assertThat(f.previews.preview(item.id())).containsEntry("content", "Restored safely");
    assertThat(f.repository.require(item.id()).path()).isEqualTo(oldPath);
  }

  @Test
  void existingOldDirectoryNeverWinsOverTheRestoredCurrentRootCopy() throws Exception {
    var f = fixture();
    var item = file(f, "restored.txt", "text/plain", bytes("Current root restored copy"));
    Path current = Path.of(item.path());
    Path oldRoot = Files.createDirectories(directory.resolve("old-data/context-attachments"));
    Path oldFile =
        Files.writeString(oldRoot.resolve(current.getFileName()), "Old root private bytes");
    f.repository.replace(List.of(copy(item, oldFile.toString())));
    for (int attempt = 0; attempt < 2; attempt++) {
      assertThat(f.previews.preview(item.id()))
          .containsEntry("content", "Current root restored copy");
      assertThat(f.previews.content(item.id(), true, null).bytes())
          .isEqualTo(bytes("Current root restored copy"));
    }
    assertThat(Files.readString(oldFile)).isEqualTo("Old root private bytes");
    assertThat(f.repository.require(item.id()).path()).isEqualTo(oldFile.toString());
    Files.delete(current);
    assertThatThrownBy(() -> f.previews.content(item.id(), true, null))
        .isInstanceOf(NotFoundException.class);
    Files.createSymbolicLink(current, oldFile);
    assertThatThrownBy(() -> f.previews.preview(item.id()))
        .isInstanceOf(ResponseStatusException.class);
    assertThat(Files.readString(oldFile)).isEqualTo("Old root private bytes");
  }

  @Test
  void httpEndpointsEnforceSafeHeadersDownloadsAndLocalOriginBoundary() throws Exception {
    var f = fixture();
    var item = file(f, "Résumé 日本語;\"\r\n.svg", "image/svg+xml", bytes("<svg onload=\"bad()\"/>"));
    var mvc =
        MockMvcBuilders.standaloneSetup(new ContextPreviewController(f.previews))
            .setControllerAdvice(new ApiExceptionHandler())
            .addFilters(new LocalApiBoundaryFilter(f.properties))
            .build();
    String url = "/api/context/" + item.id();
    var response =
        mvc.perform(get(url + "/content").header("Host", "127.0.0.1:80")).andReturn().getResponse();
    assertThat(response.getStatus()).isEqualTo(200);
    assertThat(response.getContentType()).isEqualTo("text/plain; charset=utf-8");
    assertThat(response.getHeader("X-Content-Type-Options")).isEqualTo("nosniff");
    assertThat(response.getHeader("Content-Security-Policy"))
        .isEqualTo("default-src 'none'; sandbox");
    assertThat(response.getHeader("Cache-Control")).isEqualTo("no-store");
    assertThat(response.getHeader("Cross-Origin-Resource-Policy")).isEqualTo("same-origin");
    assertThat(response.getHeader("Content-Disposition"))
        .doesNotContain("\r", "\n")
        .contains("filename*=UTF-8''");
    var download =
        mvc.perform(get(url + "/content?download=true").header("Host", "127.0.0.1:80"))
            .andReturn()
            .getResponse();
    assertThat(download.getHeader("Content-Disposition")).startsWith("attachment;");
    assertThat(download.getContentAsByteArray()).isEqualTo(bytes("<svg onload=\"bad()\"/>"));
    var metadata =
        mvc.perform(get(url + "/preview").header("Host", "127.0.0.1:80")).andReturn().getResponse();
    assertThat(metadata.getStatus()).isEqualTo(200);
    assertThat(metadata.getHeader("Cache-Control")).isEqualTo("no-store");
    var hostile =
        mvc.perform(
                get(url + "/content")
                    .header("Host", "127.0.0.1:80")
                    .header("Origin", "https://attacker.test"))
            .andReturn()
            .getResponse();
    assertThat(hostile.getStatus()).isEqualTo(403);
    var missing =
        mvc.perform(
                get("/api/context/" + UUID.randomUUID() + "/preview")
                    .header("Host", "127.0.0.1:80"))
            .andReturn()
            .getResponse();
    assertThat(missing.getStatus()).isEqualTo(404);
  }

  private static ContextAttachment copy(ContextAttachment item, String path) {
    return new ContextAttachment(
        item.id(),
        item.kind(),
        item.title(),
        item.url(),
        path,
        item.size(),
        item.mimeType(),
        item.repositoryId(),
        item.createdAt());
  }
}
