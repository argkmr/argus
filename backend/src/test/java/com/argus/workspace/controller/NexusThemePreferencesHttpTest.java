package com.argus.workspace.controller;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;

import com.argus.background.service.BackgroundJobService;
import com.argus.backup.service.BackupOwnerAccess;
import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ApiExceptionHandler;
import com.argus.common.process.CommandRunner;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.onboarding.service.RepositoryDiscoveryService;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.domain.Workspace;
import com.argus.workspace.repository.WorkspaceRepository;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

class NexusThemePreferencesHttpTest {
  @TempDir Path directory;
  private final ObjectMapper mapper = new ObjectMapper();
  private final CommandRunner commands = mock(CommandRunner.class);
  private final RepositoryDiscoveryService discovery = mock(RepositoryDiscoveryService.class);
  private final BackgroundJobService background = mock(BackgroundJobService.class);

  @Test
  void separateDarkAndLightThemesPersistThroughHttpAndRestartWithoutChangingOtherData()
      throws Exception {
    var properties = new ArgusProperties(directory, directory, "test", "");
    var path = directory.resolve("workspace.json");
    var state = new Workspace();
    state.repositories.add(new Repository("api", "API", "/fixture/api", "first", "main"));
    state.activeRepositoryId = "api";
    state.preferences.putAll(
        Map.of(
            "nexusTheme", "sand",
            "fontFamily", "comic-sans",
            "theme", "dark",
            "globalDraft", "Keep this Nexus draft",
            "repositoryDrafts", Map.of("api", "Keep this repository draft"),
            "repositoryTabGroups", List.of(Map.of("id", "api-group", "collapsed", true)),
            "futurePreference", Map.of("nested", true)));
    state.preserveAdditionalProperty("futureWorkspaceField", List.of("preserve", "unchanged"));
    var expected = (ObjectNode) mapper.valueToTree(state);
    new AtomicJsonStore(mapper).write(path, state);

    for (var choice :
        List.of(
            Map.of("dark", "forest", "light", "midnight"),
            Map.of("dark", "ocean", "light", "violet"))) {
      var service =
          new WorkspaceService(
              new WorkspaceRepository(new AtomicJsonStore(mapper), properties), commands);
      var request = Map.of("nexusTheme", choice.get("dark"), "nexusThemes", choice);
      var response =
          http(service)
              .perform(
                  patch("/api/preferences")
                      .contentType(MediaType.APPLICATION_JSON)
                      .content(mapper.writeValueAsBytes(request)))
              .andReturn()
              .getResponse();
      assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(200);
      var expectedPreferences = (ObjectNode) expected.path("preferences");
      expectedPreferences.put("nexusTheme", choice.get("dark"));
      expectedPreferences.set("nexusThemes", mapper.valueToTree(choice));
      assertThat(mapper.readTree(response.getContentAsByteArray())).isEqualTo(expectedPreferences);
      assertThat(mapper.readTree(Files.readAllBytes(path))).isEqualTo(expected);

      var restarted =
          new WorkspaceService(
              new WorkspaceRepository(new AtomicJsonStore(mapper), properties), commands);
      var restored = http(restarted).perform(get("/api/workspace")).andReturn().getResponse();
      assertThat(restored.getStatus()).isEqualTo(200);
      JsonNode snapshot = mapper.readTree(restored.getContentAsByteArray());
      assertThat(snapshot.path("preferences")).isEqualTo(expectedPreferences);
      assertThat(snapshot.path("repositories")).isEqualTo(expected.path("repositories"));
      assertThat(snapshot.path("activeRepositoryId"))
          .isEqualTo(expected.path("activeRepositoryId"));
    }
    verifyNoInteractions(commands, discovery, background);
  }

  private MockMvc http(WorkspaceService service) {
    var owner = mock(BackupOwnerAccess.class);
    when(owner.visiblePreferences(anyMap())).thenAnswer(invocation -> invocation.getArgument(0));
    return MockMvcBuilders.standaloneSetup(
            new NativeWorkspaceController(service, discovery, commands, background, owner),
            new WorkspaceController(service, owner))
        .setControllerAdvice(new ApiExceptionHandler())
        .build();
  }
}
