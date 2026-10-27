package com.argus.documents.service;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ApiExceptionHandler;
import com.argus.common.process.CommandResult;
import com.argus.common.process.CommandRunner;
import com.argus.documents.controller.SourceReferenceController;
import com.argus.platform.LocalApiBoundaryFilter;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.dto.WorkspaceResponse;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;

class SourceReferenceFolderTest {
  @TempDir Path temporary;

  SourceReferenceService sources(List<Repository> repositories) {
    var workspace = mock(WorkspaceService.class);
    when(workspace.snapshot())
        .thenReturn(
            new WorkspaceResponse(1, null, Map.of(), repositories, List.of(), List.of(), Map.of()));
    return new SourceReferenceService(workspace, mock(WordPreviewService.class)) {
      @Override
      protected Path homeDirectory() {
        return temporary;
      }
    };
  }

  Repository repository(String name) throws Exception {
    Path root = Files.createDirectories(temporary.resolve(name)).toRealPath();
    return new Repository(name, name, root.toString(), "");
  }

  SourceReferenceRevealService finder(
      SourceReferenceService sources, CommandRunner commands, boolean supported) {
    return new SourceReferenceRevealService(sources, commands) {
      @Override
      protected boolean supportsFinder() {
        return supported;
      }
    };
  }

  static String target(Path path) {
    return path.toString().replace("%", "%25");
  }

  @Test
  void folderMetadataIsBoundedAndKeepsLocalRootHomeAndEncodedPathsWithoutReadingChildren()
      throws Exception {
    Path folder = Files.createDirectory(temporary.resolve("Résumé 100%25 + plan")).toRealPath();
    Files.writeString(folder.resolve("private.txt"), "DO_NOT_READ_CHILDREN");
    var sources = sources(List.of());
    for (String reference :
        List.of(target(folder), folder.toUri().toString(), "~/Résumé 100%2525 + plan")) {
      var result = sources.read(reference, "offboarded-repository");
      assertThat(result)
          .containsEntry("kind", "directory")
          .containsEntry("previewType", "directory")
          .containsEntry("scope", "local")
          .containsEntry("path", folder.toString())
          .containsEntry("name", folder.getFileName().toString())
          .containsEntry("size", null)
          .containsEntry("downloadUrl", null)
          .containsEntry("contentUrl", null)
          .doesNotContainKeys("content", "children", "line");
      assertThatThrownBy(() -> sources.content(reference, null, false, null))
          .isInstanceOf(ResponseStatusException.class)
          .hasMessageContaining("regular file");
      assertThatThrownBy(() -> sources.content(reference, null, true, null))
          .isInstanceOf(ResponseStatusException.class)
          .hasMessageContaining("regular file");
    }
    assertThat(sources.read("/", null))
        .containsEntry("name", "/")
        .containsEntry("kind", "directory");
    assertThat(Files.readString(folder.resolve("private.txt"))).isEqualTo("DO_NOT_READ_CHILDREN");
  }

  @Test
  void relativeFolderLookupKeepsPreferredRootAmbiguityAndSymlinkBoundaries() throws Exception {
    var first = repository("first");
    var second = repository("second");
    Path firstDocs = Files.createDirectory(Path.of(first.path()).resolve("docs"));
    Files.createDirectory(Path.of(second.path()).resolve("docs"));
    Files.createSymbolicLink(Path.of(first.path()).resolve("inside"), firstDocs);
    Files.createSymbolicLink(Path.of(first.path()).resolve("escape"), Path.of(second.path()));
    var sources = sources(List.of(first, second));
    assertThat(sources.read("docs", first.id()))
        .containsEntry("repositoryId", first.id())
        .containsEntry("path", firstDocs.toString());
    assertThat(sources.read("inside", first.id())).containsEntry("path", firstDocs.toString());
    assertThat(sources.read(".", first.id()))
        .containsEntry("kind", "directory")
        .containsEntry("path", first.path());
    assertThatThrownBy(() -> sources.read("docs", null))
        .isInstanceOf(ResponseStatusException.class)
        .hasMessageContaining("409");
    for (String reference : List.of("escape", "../second", "docs#L2")) {
      assertThatThrownBy(() -> sources.directory(reference, first.id()))
          .isInstanceOf(ResponseStatusException.class);
    }
    assertThat(sources.read(Path.of(first.path()).resolve("escape").toString(), first.id()))
        .containsEntry("repositoryId", second.id())
        .containsEntry("path", second.path());
    var nested = new Repository("nested", "Nested", firstDocs.toString(), "");
    assertThat(sources(List.of(first, nested)).read(firstDocs.toString(), null))
        .containsEntry("repositoryId", "nested");
  }

  @Test
  void finderRevealUsesCanonicalDirectoryAndBoundedArgumentsNeverShellOrApplicationLaunch()
      throws Exception {
    Path folder =
        Files.createDirectory(temporary.resolve("--$(touch nope) + 100%25.app")).toRealPath();
    Path alias = temporary.resolve("alias");
    Files.createSymbolicLink(alias, folder);
    var commands = mock(CommandRunner.class);
    when(commands.run(anyString(), anyList(), isNull(), any()))
        .thenReturn(new CommandResult("", "", 0));
    var sources = sources(List.of());
    sources.read(alias.toString(), null);
    verifyNoInteractions(commands);
    assertThat(finder(sources, commands, true).reveal(alias.toString(), null))
        .containsEntry("opened", true)
        .containsEntry("path", folder.toString());
    verify(commands)
        .run("/usr/bin/open", List.of("-R", "--", folder.toString()), null, Duration.ofSeconds(10));
    verifyNoMoreInteractions(commands);
  }

  @Test
  void folderRevealRoundTripsOriginalCitationsWithPunctuationAndSymlinkAliases() throws Exception {
    var repository = repository("punctuated");
    var sources = sources(List.of(repository));
    var commands = mock(CommandRunner.class);
    when(commands.run(anyString(), anyList(), isNull(), any()))
        .thenReturn(new CommandResult("", "", 0));
    var reveal = finder(sources, commands, true);
    Path numbered = Files.createDirectory(Path.of(repository.path()).resolve("project:42"));
    Path special = Files.createDirectory(Path.of(repository.path()).resolve("plan#draft? 100%25 "));
    Path alias =
        Files.createSymbolicLink(Path.of(repository.path()).resolve("friendly-alias"), special);
    for (var entry :
        Map.of(target(numbered) + "/", numbered, alias.getFileName().toString(), special)
            .entrySet()) {
      assertThat(sources.read(entry.getKey(), repository.id()))
          .containsEntry("kind", "directory")
          .containsEntry("path", entry.getValue().toString());
      verifyNoInteractions(commands);
      assertThat(reveal.reveal(entry.getKey(), repository.id()))
          .containsEntry("opened", true)
          .containsEntry("path", entry.getValue().toString());
      verify(commands)
          .run(
              "/usr/bin/open",
              List.of("-R", "--", entry.getValue().toString()),
              null,
              Duration.ofSeconds(10));
      clearInvocations(commands);
    }
  }

  @Test
  void finderNeverRunsForFilesDevicesMissingFoldersOrUnsafeReferences() throws Exception {
    var repository = repository("repo");
    Files.writeString(Path.of(repository.path()).resolve("file.txt"), "text");
    Path external = Files.createDirectory(temporary.resolve("external"));
    Files.createSymbolicLink(Path.of(repository.path()).resolve("escape"), external);
    var commands = mock(CommandRunner.class);
    var reveal = finder(sources(List.of(repository)), commands, true);
    for (String reference :
        List.of(
            "file.txt",
            "missing",
            "/dev/null",
            "escape",
            "../external",
            "https://evil.test/a",
            "file://evil/folder",
            "repo%00",
            ""))
      assertThatThrownBy(() -> reveal.reveal(reference, repository.id()))
          .isInstanceOf(ResponseStatusException.class);
    assertThatThrownBy(() -> reveal.reveal(null, repository.id()))
        .isInstanceOf(ResponseStatusException.class);
    verifyNoInteractions(commands);
  }

  @Test
  void finderDoesNotReportSuccessOnUnsupportedPlatformTimeoutOrCommandFailure() throws Exception {
    Path folder = temporary.toRealPath();
    var sources = sources(List.of());
    var commands = mock(CommandRunner.class);
    assertThatThrownBy(() -> finder(sources, commands, false).reveal(folder.toString(), null))
        .isInstanceOf(ResponseStatusException.class)
        .hasMessageContaining("Copy the folder path");
    verifyNoInteractions(commands);
    when(commands.run(anyString(), anyList(), isNull(), any()))
        .thenThrow(new IllegalStateException("timed out with private output"));
    assertThatThrownBy(() -> finder(sources, commands, true).reveal(folder.toString(), null))
        .isInstanceOf(ResponseStatusException.class)
        .hasMessageContaining("Finder could not")
        .hasMessageNotContaining("private output");
    reset(commands);
    when(commands.run(anyString(), anyList(), isNull(), any()))
        .thenReturn(new CommandResult("", "private error", 1));
    assertThatThrownBy(() -> finder(sources, commands, true).reveal(folder.toString(), null))
        .isInstanceOf(ResponseStatusException.class)
        .hasMessageContaining("Finder could not");
  }

  @Test
  void folderIsRevalidatedAtActionTimeAndCannotTurnIntoFileOrSymlink() throws Exception {
    Path folder = Files.createDirectory(temporary.resolve("changed"));
    var sources = sources(List.of());
    sources.read(folder.toString(), null);
    Files.delete(folder);
    Files.writeString(folder, "not a folder any longer");
    var commands = mock(CommandRunner.class);
    assertThatThrownBy(() -> finder(sources, commands, true).reveal(folder.toString(), null))
        .isInstanceOf(ResponseStatusException.class);
    Files.delete(folder);
    Files.createSymbolicLink(folder, Files.createDirectory(temporary.resolve("different")));
    // Simulates replacement after resolution but before launching Finder.
    var racedSources = mock(SourceReferenceService.class);
    when(racedSources.directory(anyString(), isNull())).thenReturn(folder);
    assertThatThrownBy(() -> finder(racedSources, commands, true).reveal(folder.toString(), null))
        .isInstanceOf(ResponseStatusException.class)
        .hasMessageContaining("changed location");
    verifyNoInteractions(commands);
  }

  @Test
  void httpRevealIsJsonPostOnlyAndInheritsLocalOriginBoundaryWithoutGetSideEffects()
      throws Exception {
    var commands = mock(CommandRunner.class);
    when(commands.run(anyString(), anyList(), isNull(), any()))
        .thenReturn(new CommandResult("", "", 0));
    var sources = sources(List.of());
    var controller = new SourceReferenceController(sources, finder(sources, commands, true));
    var mvc =
        MockMvcBuilders.standaloneSetup(controller)
            .setControllerAdvice(new ApiExceptionHandler())
            .addFilters(
                new LocalApiBoundaryFilter(new ArgusProperties(null, null, "test", "token")))
            .build();
    String folder = temporary.toRealPath().toString();
    String body = new ObjectMapper().writeValueAsString(Map.of("target", folder));
    assertThat(
            mvc.perform(local(get("/api/source-reference").param("target", folder)))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(200);
    assertThat(
            mvc.perform(local(get("/api/source-reference/reveal").param("target", folder)))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(405);
    assertThat(
            mvc.perform(
                    local(
                        post("/api/source-reference/reveal")
                            .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                            .content("target=" + folder)))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(415);
    for (String origin : List.of("https://evil.test", "chrome-extension://untrusted", "null"))
      assertThat(
              mvc.perform(
                      local(
                              post("/api/source-reference/reveal")
                                  .contentType(MediaType.APPLICATION_JSON)
                                  .content(body))
                          .header("Origin", origin))
                  .andReturn()
                  .getResponse()
                  .getStatus())
          .isEqualTo(403);
    assertThat(
            mvc.perform(
                    local(
                            post("/api/source-reference/reveal")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content(body))
                        .header("Sec-Fetch-Site", "cross-site"))
                .andReturn()
                .getResponse()
                .getStatus())
        .isEqualTo(403);
    verifyNoInteractions(commands);
    var response =
        mvc.perform(
                local(
                        post("/api/source-reference/reveal")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(body))
                    .header("Origin", "http://127.0.0.1:4173"))
            .andReturn()
            .getResponse();
    assertThat(response.getStatus()).isEqualTo(200);
    assertThat(response.getContentAsString()).contains("\"opened\":true");
    verify(commands)
        .run("/usr/bin/open", List.of("-R", "--", folder), null, Duration.ofSeconds(10));
    verifyNoMoreInteractions(commands);
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
}
