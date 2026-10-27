package com.argus.documents.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.workspace.domain.Repository;
import com.argus.workspace.dto.WorkspaceResponse;
import com.argus.workspace.service.WorkspaceService;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mockito;
import org.springframework.web.server.ResponseStatusException;

class SourceReferenceServiceTest {
  @TempDir Path directory;

  SourceReferenceService service(List<Repository> repositories, WordPreviewService word) {
    var workspace = Mockito.mock(WorkspaceService.class);
    Mockito.when(workspace.snapshot())
        .thenReturn(
            new WorkspaceResponse(1, null, Map.of(), repositories, List.of(), List.of(), Map.of()));
    return new SourceReferenceService(workspace, word) {
      @Override
      protected Path homeDirectory() {
        return directory.resolve("home");
      }
    };
  }

  Repository repo(Path root) throws Exception {
    Files.createDirectories(root);
    return new Repository(root.getFileName().toString(), "Reports", root.toString(), "");
  }

  static byte[] zip(Map<String, String> parts) throws Exception {
    var bytes = new ByteArrayOutputStream();
    try (var zip = new ZipOutputStream(bytes)) {
      for (var entry : parts.entrySet()) {
        zip.putNextEntry(new ZipEntry(entry.getKey()));
        zip.write(entry.getValue().getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
      }
    }
    return bytes.toByteArray();
  }

  static Map<String, String> document() {
    return Map.of(
        "[Content_Types].xml",
        "<Types/>",
        "word/document.xml",
        "<document><p>Formatted text</p></document>");
  }

  @Test
  void explicitLocalFilesOpenWithoutOnboardingAndIgnoreStaleRepositoryHints() throws Exception {
    var connected = repo(directory.resolve("repo"));
    Path home = Files.createDirectories(directory.resolve("home"));
    Path external = home.resolve("notes.md");
    Files.writeString(external, "# Local report\nsecond line\n");
    Path alias = directory.resolve("alias.md");
    Files.createSymbolicLink(alias, external);
    for (List<Repository> repositories : List.of(List.<Repository>of(), List.of(connected))) {
      var sources = service(repositories, new WordPreviewService());
      for (String target :
          List.of(
              external.toString(),
              external.toUri().toString(),
              "file://localhost" + external,
              "~/notes.md",
              "~//notes.md",
              "~///notes.md",
              alias.toString(),
              home + "/../home/notes.md")) {
        assertThat(sources.read(target + "#L2", "stale-repository"))
            .containsEntry("scope", "local")
            .containsEntry("repositoryId", null)
            .containsEntry("repositoryName", null)
            .containsEntry("file", external.toRealPath().toString())
            .containsEntry("path", external.toRealPath().toString())
            .containsEntry("line", 2)
            .containsEntry("content", "# Local report\nsecond line\n");
      }
      assertThatThrownBy(() -> sources.read("notes.md", null))
          .isInstanceOf(ResponseStatusException.class);
    }
  }

  @Test
  void externalPreviewAndEncodedDownloadUrlsKeepOriginalBytesAndSafeHeaders() throws Exception {
    var sources = service(List.of(), new WordPreviewService());
    byte[] pdf = "%PDF-1.7\nlocal".getBytes(StandardCharsets.UTF_8),
        docx = zip(document()),
        binary = new byte[] {0, 1, 2, (byte) 0xff};
    var files =
        Map.of("Résumé 日本語 100%25 + plan.pdf", pdf, "local.docx", docx, "local.bin", binary);
    for (var entry : files.entrySet()) {
      Path file = directory.resolve(entry.getKey());
      Files.write(file, entry.getValue());
      var metadata = sources.read(file.toString().replace("%", "%25"), null);
      String url = metadata.get("downloadUrl").toString();
      assertThat(url)
          .startsWith("/api/source-reference/content?target=")
          .doesNotContain("repositoryId", "null");
      // Simulate query decoding in Spring, followed by reference decoding in the service.
      String target =
          java.net.URLDecoder.decode(
              url.substring(url.indexOf('=') + 1, url.indexOf("&download=")),
              StandardCharsets.UTF_8);
      var download = sources.content(target, "stale", true, null);
      assertThat(download.bytes()).isEqualTo(entry.getValue());
      assertThat(download.headers())
          .containsEntry("cache-control", "no-store")
          .containsEntry("x-content-type-options", "nosniff")
          .containsEntry("content-security-policy", "default-src 'none'; sandbox")
          .containsEntry("cross-origin-resource-policy", "same-origin");
      assertThat(download.headers().get("content-disposition")).startsWith("attachment;");
      assertThat(metadata.get("previewType"))
          .isEqualTo(
              entry.getKey().endsWith(".pdf")
                  ? "pdf"
                  : entry.getKey().endsWith(".docx") ? "docx" : "download");
      if (entry.getKey().endsWith(".docx"))
        assertThat(sources.content(target, null, false, "docx").bytes()).isEqualTo(docx);
    }
  }

  @Test
  void externalMissingDevicesAndOversizedFilesKeepExplicitFailures() throws Exception {
    var sources = service(List.of(), new WordPreviewService());
    Path missing = directory.resolve("missing.md"), broken = directory.resolve("broken.md");
    Files.createSymbolicLink(broken, missing);
    for (Path target : List.of(missing, broken, Path.of("/dev/null"))) {
      assertThatThrownBy(() -> sources.read(target.toString(), null))
          .isInstanceOf(ResponseStatusException.class);
      assertThatThrownBy(() -> sources.content(target.toString(), null, true, null))
          .isInstanceOf(ResponseStatusException.class);
    }
    assertThatThrownBy(() -> sources.content(directory.toString(), null, true, null))
        .isInstanceOf(ResponseStatusException.class)
        .hasMessageContaining("regular file");
    Path largeText = directory.resolve("large.txt");
    Files.writeString(largeText, "a".repeat(2 * 1024 * 1024 + 1));
    assertThatThrownBy(() -> sources.read(largeText.toString(), null))
        .isInstanceOf(ResponseStatusException.class)
        .hasMessageContaining("2 MB");
    assertThat(sources.content(largeText.toString(), null, true, null).bytes())
        .hasSize(2 * 1024 * 1024 + 1);
    Path largeDocument = directory.resolve("large.pdf");
    try (var file = new java.io.RandomAccessFile(largeDocument.toFile(), "rw")) {
      file.setLength(WordPreviewService.MAX_BYTES + 1L);
    }
    assertThatThrownBy(() -> sources.content(largeDocument.toString(), null, true, null))
        .isInstanceOf(ResponseStatusException.class)
        .hasMessageContaining("50 MB");
  }

  @Test
  void pdfAndWordPreviewsKeepExactOriginalDownloadsAndMime() throws Exception {
    var repo = repo(directory.resolve("repo"));
    byte[] pdf = "%PDF-1.7\r\nfixture".getBytes(StandardCharsets.UTF_8), docx = zip(document());
    Files.write(Path.of(repo.path()).resolve("Résumé 100%.pdf"), pdf);
    Files.write(Path.of(repo.path()).resolve("report.docx"), docx);
    var sources = service(List.of(repo), new WordPreviewService());
    var metadata = sources.read("report.docx", repo.id());
    assertThat(metadata.get("previewType")).isEqualTo("docx");
    assertThat(metadata.get("contentUrl").toString()).endsWith("&preview=docx");
    assertThat(metadata.get("content")).isNull();
    assertThat(sources.content("report.docx", repo.id(), false, "docx").bytes()).isEqualTo(docx);
    var download = sources.content("report.docx", repo.id(), true, "docx");
    assertThat(download.bytes()).isEqualTo(docx);
    assertThat(download.headers().get("content-disposition")).startsWith("attachment;");
    var pdfMetadata = sources.read("Résumé 100%25.pdf", repo.id());
    assertThat(pdfMetadata.get("previewType")).isEqualTo("pdf");
    assertThat(
            sources
                .content("Résumé 100%25.pdf", repo.id(), false, null)
                .headers()
                .get("content-disposition"))
        .startsWith("inline;");
    assertThat(sources.content("Résumé 100%25.pdf", repo.id(), true, null).bytes()).isEqualTo(pdf);
  }

  @Test
  void citationPositionAndHostileReferencesRespectConnectedRoot() throws Exception {
    var repo = repo(directory.resolve("repo"));
    Files.writeString(Path.of(repo.path()).resolve("plan.md"), "# Title\r\nText\r\n");
    var sources = service(List.of(repo), new WordPreviewService());
    var markdown = sources.read("plan.md:2:9", repo.id());
    assertThat(markdown.get("content")).isEqualTo("# Title\r\nText\r\n");
    assertThat(markdown.get("line")).isEqualTo(2);
    assertThat(markdown.get("column")).isEqualTo(5);
    Path secret = directory.resolve("outside.md");
    Files.writeString(secret, "secret");
    Files.createSymbolicLink(Path.of(repo.path()).resolve("escape.md"), secret);
    for (String target :
        List.of("../outside.md", "escape.md", "https://evil.test/a", "file://evil/a", "plan.md%00"))
      assertThatThrownBy(() -> sources.content(target, repo.id(), true, null))
          .isInstanceOf(ResponseStatusException.class);
    var other = repo(directory.resolve("other"));
    Files.writeString(Path.of(other.path()).resolve("plan.md"), "other");
    var both = service(List.of(repo, other), new WordPreviewService());
    assertThatThrownBy(() -> both.read("plan.md", null))
        .isInstanceOf(ResponseStatusException.class);
    assertThat(both.read("plan.md", other.id()).get("content")).isEqualTo("other");
  }

  @Test
  void unsafeArchivesCannotCrossFormattedPreviewButRemainDownloadable() throws Exception {
    var repo = repo(directory.resolve("repo"));
    var sources = service(List.of(repo), new WordPreviewService());
    for (var parts :
        List.of(
            Map.of(
                "[Content_Types].xml",
                "<Types/>",
                "word/document.xml",
                "<!DOCTYPE d [<!ENTITY e SYSTEM 'file:///etc/passwd'>]><d>&e;</d>"),
            Map.of("word/document.xml", "<d/>"),
            Map.of("[Content_Types].xml", "<Types/>", "word/document.xml", "<bad>"),
            Map.of(
                "[Content_Types].xml",
                "<Types/>",
                "word/document.xml",
                "<d/>",
                "../escape.xml",
                "<e/>"))) {
      byte[] bytes = zip(parts);
      Files.write(Path.of(repo.path()).resolve("bad.docx"), bytes);
      assertThat(sources.read("bad.docx", repo.id()).get("previewType")).isEqualTo("download");
      assertThatThrownBy(() -> sources.content("bad.docx", repo.id(), false, "docx"))
          .isInstanceOf(ResponseStatusException.class);
      assertThat(sources.content("bad.docx", repo.id(), true, null).bytes()).isEqualTo(bytes);
    }
    assertThatThrownBy(() -> new WordPreviewService().validate(zip(document()), Duration.ZERO))
        .isInstanceOf(ResponseStatusException.class);
  }

  @Test
  void legacyPreviewConvertsOnlyInMemoryAndNeverChangesOriginalDownload() throws Exception {
    var repo = repo(directory.resolve("repo"));
    byte[] original = {1, 2, 3};
    byte[] converted = zip(document());
    Files.write(Path.of(repo.path()).resolve("old.doc"), original);
    var word =
        new WordPreviewService() {
          @Override
          protected byte[] convertLegacy(byte[] bytes) {
            assertThat(bytes).isEqualTo(original);
            return converted;
          }
        };
    var sources = service(List.of(repo), word);
    assertThat(sources.read("old.doc", repo.id()).get("previewType")).isEqualTo("docx");
    assertThat(sources.content("old.doc", repo.id(), false, "docx").bytes()).isEqualTo(converted);
    var originalDownload = sources.content("old.doc", repo.id(), true, "docx");
    assertThat(originalDownload.bytes()).isEqualTo(original);
    assertThat(originalDownload.headers().get("content-type")).isEqualTo("application/msword");
  }

  @Test
  void rootAliasesNestedRepositoriesAndLineRangesKeepTheOriginalScope() throws Exception {
    var outer = repo(directory.resolve("outer"));
    var nested = repo(Path.of(outer.path()).resolve("nested"));
    Path file = Path.of(nested.path()).resolve("a file.md");
    Files.writeString(file, "one\ntwo\nthree");
    var sources = service(List.of(outer, nested), new WordPreviewService());
    assertThat(sources.read(file + "#L2-L99", null))
        .containsEntry("repositoryId", nested.id())
        .containsEntry("line", 2)
        .containsEntry("endLine", 3);
    Path alias = directory.resolve("alias");
    Files.createSymbolicLink(alias, Path.of(nested.path()));
    Files.createSymbolicLink(Path.of(nested.path()).resolve("internal.md"), file);
    var aliasRepository = new Repository("alias", "Alias", alias.toString(), "");
    var aliased = service(List.of(aliasRepository), new WordPreviewService());
    assertThat(aliased.read(alias.resolve("internal.md") + ":999", null))
        .containsEntry("content", "one\ntwo\nthree")
        .containsEntry("line", 3);
    assertThat(aliased.read("file://localhost" + file + "#L2", null)).containsEntry("line", 2);
    var other = repo(directory.resolve("other"));
    Path outside = Path.of(other.path()).resolve("private.md");
    Files.writeString(outside, "other repository");
    Files.createSymbolicLink(Path.of(nested.path()).resolve("cross-root.md"), outside);
    var connected = service(List.of(nested, other), new WordPreviewService());
    assertThat(connected.read(Path.of(nested.path()).resolve("cross-root.md").toString(), null))
        .containsEntry("content", "other repository")
        .containsEntry("scope", "repository")
        .containsEntry("repositoryId", other.id());
    assertThatThrownBy(() -> connected.read("cross-root.md", nested.id()))
        .isInstanceOf(ResponseStatusException.class)
        .hasMessageContaining("outside its repository");
  }

  @Test
  void unsupportedDocumentsHtmlAndInvalidSignaturesRemainExactDownloadOnly() throws Exception {
    var repo = repo(directory.resolve("repo"));
    var sources = service(List.of(repo), new WordPreviewService());
    byte[] bytes = "<script>never execute</script>\r\n".getBytes(StandardCharsets.UTF_8);
    for (String name : List.of("invalid.pdf", "sheet.xlsx", "page.html")) {
      Files.write(Path.of(repo.path()).resolve(name), bytes);
      var download = sources.content(name, repo.id(), true, null);
      assertThat(download.bytes()).isEqualTo(bytes);
      assertThat(download.headers().get("content-disposition")).startsWith("attachment;");
      assertThat(download.headers().get("content-security-policy"))
          .contains("default-src 'none'", "sandbox");
      if (!name.endsWith("html"))
        assertThat(sources.read(name, repo.id()))
            .containsEntry("previewType", "download")
            .containsEntry("contentUrl", null);
      assertThatThrownBy(() -> sources.content(name, repo.id(), false, "docx"))
          .isInstanceOf(ResponseStatusException.class);
    }
    Files.write(Path.of(repo.path()).resolve("old.doc"), new byte[] {1, 2, 3});
    assertThat(sources.read("old.doc", repo.id())).containsEntry("previewType", "download");
    assertThat(sources.content("old.doc", repo.id(), true, null).bytes())
        .containsExactly((byte) 1, (byte) 2, (byte) 3);
  }

  @Test
  void missingBinaryOversizedAndCompressedExpansionInputsFailWithExplicitLimits() throws Exception {
    var repo = repo(directory.resolve("repo"));
    var sources = service(List.of(repo), new WordPreviewService());
    Files.write(Path.of(repo.path()).resolve("binary.bin"), new byte[] {0, 1});
    assertThatThrownBy(() -> sources.read("missing.md", repo.id()))
        .isInstanceOf(ResponseStatusException.class);
    Path text = Path.of(repo.path()).resolve("large.txt");
    Files.writeString(text, "a".repeat(2 * 1024 * 1024 + 1));
    assertThatThrownBy(() -> sources.read("large.txt", repo.id()))
        .isInstanceOf(ResponseStatusException.class)
        .hasMessageContaining("2 MB");
    assertThat(sources.content("large.txt", repo.id(), true, null).bytes())
        .hasSize(2 * 1024 * 1024 + 1);
    Path document = Path.of(repo.path()).resolve("large.pdf");
    try (var file = new java.io.RandomAccessFile(document.toFile(), "rw")) {
      file.setLength(WordPreviewService.MAX_BYTES + 1L);
    }
    assertThatThrownBy(() -> sources.content("large.pdf", repo.id(), true, null))
        .isInstanceOf(ResponseStatusException.class)
        .hasMessageContaining("50 MB");
    var parts = new java.util.LinkedHashMap<>(document());
    parts.put("word/document.xml", "<document>" + "A".repeat(1024 * 1024) + "</document>");
    byte[] compressed = zip(parts);
    Files.write(Path.of(repo.path()).resolve("bomb.docx"), compressed);
    assertThat(sources.read("bomb.docx", repo.id())).containsEntry("previewType", "download");
    assertThat(sources.content("bomb.docx", repo.id(), true, null).bytes()).isEqualTo(compressed);
  }

  @Test
  void unrecognizedBinaryFilesRetainSafeMetadataAndOriginalDownload() throws Exception {
    var repo = repo(directory.resolve("repo"));
    var sources = service(List.of(repo), new WordPreviewService());
    byte[] original = {0, 1, 2, 3, (byte) 0xff};
    for (String name : List.of("diagram.bin", "attachment", "report.unknown")) {
      Path file = Path.of(repo.path()).resolve(name);
      Files.write(file, original);
      var metadata = sources.read(file + "#L1", repo.id());
      assertThat(metadata)
          .containsEntry("kind", "document")
          .containsEntry("previewType", "download")
          .containsEntry("mimeType", "application/octet-stream")
          .containsEntry("name", name)
          .containsEntry("repositoryId", repo.id())
          .containsEntry("contentUrl", null);
      assertThat(metadata.get("previewNotice").toString()).contains("unchanged original");
      assertThat(metadata.get("downloadUrl").toString()).endsWith("&download=true");
      assertThat(metadata.get("content")).isNull();
      var download = sources.content(file.toString(), repo.id(), true, null);
      assertThat(download.bytes()).isEqualTo(original);
      assertThat(download.headers())
          .containsEntry("content-type", "application/octet-stream")
          .containsEntry("x-content-type-options", "nosniff")
          .containsEntry("content-security-policy", "default-src 'none'; sandbox");
      assertThat(download.headers().get("content-disposition")).startsWith("attachment;");
      assertThat(
              sources
                  .content(file.toString(), repo.id(), false, null)
                  .headers()
                  .get("content-disposition"))
          .startsWith("attachment;");
    }
    Path outside = directory.resolve("private.bin");
    Files.write(outside, original);
    Files.createSymbolicLink(Path.of(repo.path()).resolve("escape.bin"), outside);
    assertThat(sources.read(outside.toString(), repo.id())).containsEntry("scope", "local");
    assertThat(sources.content(outside.toString(), repo.id(), true, null).bytes())
        .isEqualTo(original);
    for (String target : List.of("escape.bin", "../private.bin")) {
      assertThatThrownBy(() -> sources.read(target, repo.id()))
          .isInstanceOf(ResponseStatusException.class);
      assertThatThrownBy(() -> sources.content(target, repo.id(), true, null))
          .isInstanceOf(ResponseStatusException.class);
    }
  }

  @Test
  void archiveBundlesAndLargeUnknownBinariesAreDownloadOnlyWithoutExtraction() throws Exception {
    var repo = repo(directory.resolve("repo"));
    var sources = service(List.of(repo), new WordPreviewService());
    byte[] archive = zip(Map.of("guide.md", "# Guide", "../never-extracted.txt", "No extraction"));
    Path root = Path.of(repo.path());
    Files.write(root.resolve("Guided_Help_PM_Map.ZIP"), archive);
    assertThat(sources.read("Guided_Help_PM_Map.ZIP", repo.id()))
        .containsEntry("name", "Guided_Help_PM_Map.ZIP")
        .containsEntry("kind", "document")
        .containsEntry("previewType", "download")
        .containsEntry("mimeType", "application/zip")
        .containsEntry("contentUrl", null);
    assertThat(sources.read("Guided_Help_PM_Map.ZIP", repo.id()).get("previewNotice").toString())
        .contains("archive", "downloadable bundle");
    assertThat(sources.content("Guided_Help_PM_Map.ZIP", repo.id(), true, null).bytes())
        .isEqualTo(archive);
    assertThat(sources.content("Guided_Help_PM_Map.ZIP", repo.id(), false, null).headers())
        .containsEntry("content-type", "application/zip");
    assertThat(Files.exists(directory.resolve("never-extracted.txt"))).isFalse();
    byte[] binary = new byte[2 * 1024 * 1024 + 1];
    Files.write(root.resolve("large.unknown"), binary);
    assertThat(sources.read("large.unknown", repo.id()))
        .containsEntry("kind", "document")
        .containsEntry("previewType", "download")
        .containsEntry("contentUrl", null);
    assertThat(sources.content("large.unknown", repo.id(), true, null).bytes()).isEqualTo(binary);
  }

  @Test
  void externalWordRelationshipsRemainBytesAndAreNeverResolvedDuringValidation() throws Exception {
    var repo = repo(directory.resolve("repo"));
    var parts = new java.util.LinkedHashMap<>(document());
    parts.put(
        "word/_rels/document.xml.rels",
        "<Relationships><Relationship Id=\"r1\" Target=\"https://external.invalid/private\" TargetMode=\"External\"/></Relationships>");
    byte[] original = zip(parts);
    Files.write(Path.of(repo.path()).resolve("external.docx"), original);
    var sources = service(List.of(repo), new WordPreviewService());
    assertThat(sources.read("external.docx", repo.id())).containsEntry("previewType", "docx");
    assertThat(sources.content("external.docx", repo.id(), false, "docx").bytes())
        .isEqualTo(original);
  }

  @Test
  void oversizedMarkdownKeepsDownloadMetadataWithoutReturningUnboundedText() throws Exception {
    var repo = repo(directory.resolve("repo"));
    var sources = service(List.of(repo), new WordPreviewService());
    byte[] original = ("# Report\n" + "a".repeat(2 * 1024 * 1024)).getBytes(StandardCharsets.UTF_8);
    for (String name : List.of("large.md", "large.MARKDOWN")) {
      Files.write(Path.of(repo.path()).resolve(name), original);
      var metadata = sources.read(name, repo.id());
      assertThat(metadata)
          .containsEntry("kind", "document")
          .containsEntry("previewType", "download")
          .containsEntry("mimeType", "text/markdown")
          .containsEntry("contentUrl", null);
      assertThat(metadata.get("content")).isNull();
      assertThat(metadata.get("downloadUrl").toString()).endsWith("&download=true");
      assertThat(metadata.get("previewNotice").toString()).contains("2 MB", "unchanged original");
      assertThat(sources.content(name, repo.id(), true, null).bytes()).isEqualTo(original);
    }
  }

  @Test
  void pdfHeaderSearchMatchesTheViewerAndPreservesLeadingBytes() throws Exception {
    var repo = repo(directory.resolve("repo"));
    var sources = service(List.of(repo), new WordPreviewService());
    for (int padding : List.of(0, 4, 1019, 1020, 1024)) {
      byte[] original =
          (" ".repeat(padding) + "%PDF-1.7\nfixture").getBytes(StandardCharsets.US_ASCII);
      Files.write(Path.of(repo.path()).resolve("leading.pdf"), original);
      assertThat(sources.read("leading.pdf", repo.id()).get("previewType"))
          .isEqualTo(padding <= 1019 ? "pdf" : "download");
      var content = sources.content("leading.pdf", repo.id(), false, null);
      assertThat(content.headers().get("content-disposition"))
          .startsWith(padding <= 1019 ? "inline;" : "attachment;");
      assertThat(content.bytes()).isEqualTo(original);
      assertThat(sources.content("leading.pdf", repo.id(), true, null).bytes()).isEqualTo(original);
    }
  }
}
