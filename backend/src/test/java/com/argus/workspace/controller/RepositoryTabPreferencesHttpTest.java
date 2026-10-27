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
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

class RepositoryTabPreferencesHttpTest {
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
  private JsonNode original;

  @BeforeEach
  void setup() {
    properties = new ArgusProperties(directory, directory, "test", "");
    workspacePath = directory.resolve("workspace.json");
    store = spy(new AtomicJsonStore(mapper));
    var state = new Workspace();
    state.repositories.addAll(
        List.of(
            new Repository("a", "API", "/fixture/api", "first", "main"),
            new Repository("b", "Backend", "/fixture/backend", "second", "release"),
            new Repository("c", "Client", "/fixture/client", "third", "develop")));
    state.activeRepositoryId = "b";
    state.preferences.put("theme", "dark");
    state.preferences.put("repositoryDrafts", Map.of("a", "Keep my draft"));
    state.runConfigurations.add(Map.of("id", "run-a", "repositoryId", "a"));
    state.preserveAdditionalProperty("futureField", Map.of("keep", true));
    original = mapper.valueToTree(state);
    store.write(workspacePath, state);
    clearInvocations(store);
    workspace = new WorkspaceService(new WorkspaceRepository(store, properties), commands);
    var owner = mock(BackupOwnerAccess.class);
    when(owner.visiblePreferences(anyMap())).thenAnswer(invocation -> invocation.getArgument(0));
    mvc =
        MockMvcBuilders.standaloneSetup(
                new NativeWorkspaceController(workspace, discovery, commands, background, owner),
                new WorkspaceController(workspace, owner))
            .setControllerAdvice(new ApiExceptionHandler())
            .build();
  }

  @AfterEach
  void layoutUpdatesNeverStartCommandsDiscoveryOrBackgroundWork() {
    verifyNoInteractions(commands, discovery, background);
  }

  @Test
  void onePatchPersistsGroupsAndRailOrderTogetherAndSurvivesRepositoryReload() throws Exception {
    assertThat(workspace.snapshot().preferences())
        .doesNotContainKeys("repositoryTabGroups", "repositoryTabOrder");
    var input = groupedLayout();
    var response = patchPreferences(input);
    assertLayout(response, input);
    verify(store, times(1)).write(eq(workspacePath), any());

    var persisted = mapper.readTree(Files.readAllBytes(workspacePath));
    assertLayout(persisted.path("preferences"), input);
    var restarted = reload();
    assertLayout(mapper.valueToTree(restarted.snapshot().preferences()), input);
    assertThat(restarted.snapshot().repositories())
        .extracting(Repository::id)
        .containsExactly("a", "b", "c");
    assertThat(restarted.snapshot().activeRepositoryId()).isEqualTo("b");
    for (String field :
        List.of("repositories", "activeRepositoryId", "runConfigurations", "futureField")) {
      assertThat(persisted.get(field)).as(field).isEqualTo(original.get(field));
    }
    assertThat(restarted.snapshot().preferences())
        .containsEntry("theme", "dark")
        .containsEntry("repositoryDrafts", Map.of("a", "Keep my draft"));
    var read = mvc.perform(get("/api/workspace")).andReturn().getResponse();
    assertThat(read.getStatus()).isEqualTo(200);
    assertLayout(mapper.readTree(read.getContentAsByteArray()).path("preferences"), input);
  }

  @Test
  void laterGroupMembershipAndPositionReplaceBothSavedArraysInOneWrite() throws Exception {
    patchPreferences(groupedLayout());
    clearInvocations(store);
    var moved =
        Map.<String, Object>of(
            "repositoryTabGroups",
            List.of(
                Map.of(
                    "id",
                    "services",
                    "name",
                    "Services",
                    "color",
                    "cyan",
                    "collapsed",
                    false,
                    "repositoryIds",
                    List.of("b", "c"))),
            "repositoryTabOrder",
            List.of(
                Map.of("type", "group", "id", "services"),
                Map.of("type", "repository", "id", "a")));
    assertLayout(patchPreferences(moved), moved);
    verify(store, times(1)).write(eq(workspacePath), any());
    assertLayout(mapper.valueToTree(reload().snapshot().preferences()), moved);
    assertThat(reload().snapshot().repositories())
        .extracting(Repository::id)
        .containsExactly("a", "b", "c");
  }

  @Test
  void unrelatedPreferencesPreserveLayoutAndDeletingGroupsPersistsAnEmptyArray() throws Exception {
    var input = groupedLayout();
    patchPreferences(input);
    patchPreferences(Map.of("theme", "light"));
    assertLayout(mapper.valueToTree(reload().snapshot().preferences()), input);
    clearInvocations(store);
    var ungrouped =
        Map.<String, Object>of(
            "repositoryTabGroups", List.of(),
            "repositoryTabOrder",
                List.of(
                    Map.of("type", "repository", "id", "c"),
                    Map.of("type", "repository", "id", "b"),
                    Map.of("type", "repository", "id", "a")));
    assertLayout(patchPreferences(ungrouped), ungrouped);
    verify(store, times(1)).write(eq(workspacePath), any());
    var restarted = reload();
    assertLayout(mapper.valueToTree(restarted.snapshot().preferences()), ungrouped);
    assertThat(restarted.snapshot().preferences()).containsEntry("theme", "light");
    assertThat(restarted.snapshot().activeRepositoryId()).isEqualTo("b");
    assertThat(restarted.snapshot().repositories())
        .extracting(Repository::id)
        .containsExactly("a", "b", "c");
  }

  private Map<String, Object> groupedLayout() {
    return Map.of(
        "repositoryTabGroups",
        List.of(
            Map.of(
                "id",
                "services",
                "name",
                "Services",
                "color",
                "violet",
                "collapsed",
                true,
                "repositoryIds",
                List.of("b", "a"))),
        "repositoryTabOrder",
        List.of(
            Map.of("type", "repository", "id", "c"), Map.of("type", "group", "id", "services")));
  }

  private JsonNode patchPreferences(Map<String, Object> input) throws Exception {
    var response =
        mvc.perform(
                patch("/api/preferences")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(mapper.writeValueAsBytes(input)))
            .andReturn()
            .getResponse();
    assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(200);
    return mapper.readTree(response.getContentAsByteArray());
  }

  private void assertLayout(JsonNode preferences, Map<String, Object> expected) {
    for (String field : List.of("repositoryTabGroups", "repositoryTabOrder")) {
      assertThat(preferences.get(field))
          .as(field)
          .isEqualTo(mapper.valueToTree(expected.get(field)));
    }
  }

  private WorkspaceService reload() {
    return new WorkspaceService(
        new WorkspaceRepository(new AtomicJsonStore(mapper), properties), commands);
  }
}
