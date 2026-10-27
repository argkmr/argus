package com.argus.workspace.controller;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
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
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

class FontPreferencesHttpTest {
  @TempDir Path directory;
  private final ObjectMapper mapper = new ObjectMapper();
  private final CommandRunner commands = mock(CommandRunner.class);
  private final RepositoryDiscoveryService discovery = mock(RepositoryDiscoveryService.class);
  private final BackgroundJobService background = mock(BackgroundJobService.class);
  private ArgusProperties properties;
  private Path workspacePath;
  private AtomicJsonStore store;
  private WorkspaceService workspace;
  private MockMvc mvc;
  private ObjectNode original;

  @BeforeEach
  void setup() {
    properties = new ArgusProperties(directory, directory, "test", "");
    workspacePath = directory.resolve("workspace.json");
    store = spy(new AtomicJsonStore(mapper));
    var state = new Workspace();
    state.repositories.addAll(
        List.of(
            new Repository("a", "API", "/fixture/api", "first", "main"),
            new Repository("b", "Backend", "/fixture/backend", "second", "release")));
    state.activeRepositoryId = "b";
    state.preferences.put("theme", "light");
    state.preferences.put("fontSize", "comfortable");
    state.preferences.put("nexusTheme", "midnight");
    state.preferences.put("repositoryDrafts", Map.of("a", "Keep my repository draft"));
    state.preferences.put("globalDraft", "Keep my Nexus draft");
    state.preferences.put("futurePreference", Map.of("nested", List.of("keep", "unchanged")));
    state.preferences.put(
        "repositoryTabGroups",
        List.of(
            Map.of(
                "id", "services",
                "name", "Services",
                "color", "violet",
                "collapsed", true,
                "repositoryIds", List.of("b", "a"))));
    state.preferences.put("repositoryTabOrder", List.of(Map.of("type", "group", "id", "services")));
    state.runConfigurations.add(Map.of("id", "run-a", "repositoryId", "a"));
    state.apiRequests.add(Map.of("id", "request-a", "repositoryId", "a"));
    state.javaProjectSettings.put("a", Map.of("javaHome", "/fixture/jdk"));
    state.preserveAdditionalProperty("futureField", Map.of("keep", true));
    original = mapper.valueToTree(state);
    store.write(workspacePath, state);
    clearInvocations(store);
    workspace = reload(store);
    mvc = http(workspace);
  }

  @AfterEach
  void fontChangesNeverStartCommandsDiscoveryOrBackgroundWork() {
    verifyNoInteractions(commands, discovery, background);
  }

  @ParameterizedTest
  @ValueSource(strings = {"system", "serif", "mono", "comic-sans"})
  void eachFontPersistsThroughHttpAndReloadWithoutChangingOtherData(String font) throws Exception {
    assertThat(workspace.snapshot().preferences()).doesNotContainKey("fontFamily");
    var expected = expectedWorkspace(font);
    assertThat(patchFont(font)).isEqualTo(expected.path("preferences"));
    verify(store, times(1)).write(eq(workspacePath), any());
    assertThat(mapper.readTree(Files.readAllBytes(workspacePath))).isEqualTo(expected);

    var restarted = reload(new AtomicJsonStore(mapper));
    assertThat(mapper.<JsonNode>valueToTree(restarted.snapshot().preferences()))
        .isEqualTo(expected.path("preferences"));
    var response = http(restarted).perform(get("/api/workspace")).andReturn().getResponse();
    assertThat(response.getStatus()).isEqualTo(200);
    var snapshot = mapper.readTree(response.getContentAsByteArray());
    assertThat(snapshot.path("preferences")).isEqualTo(expected.path("preferences"));
    assertThat(snapshot.path("repositories")).isEqualTo(original.path("repositories"));
    assertThat(snapshot.path("activeRepositoryId")).isEqualTo(original.path("activeRepositoryId"));
  }

  @Test
  void switchingBackToDefaultReplacesOnlyFontAndSurvivesSubsequentReload() throws Exception {
    for (String font : List.of("comic-sans", "mono", "serif", "system")) {
      clearInvocations(store);
      assertThat(patchFont(font)).isEqualTo(expectedWorkspace(font).path("preferences"));
      verify(store, times(1)).write(eq(workspacePath), any());
      assertThat(mapper.readTree(Files.readAllBytes(workspacePath)))
          .isEqualTo(expectedWorkspace(font));
      workspace = reload(store);
      mvc = http(workspace);
      assertThat(workspace.snapshot().preferences()).containsEntry("fontFamily", font);
    }
  }

  private ObjectNode expectedWorkspace(String font) {
    var expected = original.deepCopy();
    ((ObjectNode) expected.path("preferences")).put("fontFamily", font);
    return expected;
  }

  private JsonNode patchFont(String font) throws Exception {
    var response =
        mvc.perform(
                patch("/api/preferences")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(mapper.writeValueAsBytes(Map.of("fontFamily", font))))
            .andReturn()
            .getResponse();
    assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(200);
    return mapper.readTree(response.getContentAsByteArray());
  }

  private WorkspaceService reload(AtomicJsonStore json) {
    return new WorkspaceService(new WorkspaceRepository(json, properties), commands);
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
