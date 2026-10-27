package com.argus.onboarding.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.background.service.BackgroundJobService;
import com.argus.background.service.BackgroundOperationService;
import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.repositorycontext.service.RepositoryContextService;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.dto.WorkspaceResponse;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.ObjectProvider;
import tools.jackson.databind.ObjectMapper;

class RepositoryReconnectRetentionTest {
  @TempDir Path root;

  @Test
  void bothRegistrationRoutesRejectReconnectUntilTheDisconnectDrainCompletes() {
    var workspace = mock(WorkspaceService.class);
    var discovery = mock(RepositoryDiscoveryService.class);
    var jobs =
        new BackgroundJobService(
            new AtomicJsonStore(new ObjectMapper()),
            new ArgusProperties(root, root, "test", "test"));
    jobs.create(Map.of("type", "repository-offboarding"));
    var service =
        new RepositoryOnboardingService(
            workspace,
            discovery,
            jobs,
            new BackgroundOperationService(jobs),
            mock(RepositoryContextService.class),
            mock(AiKitGenerationService.class));
    var controller =
        new com.argus.workspace.controller.NativeWorkspaceController(
            workspace,
            discovery,
            mock(com.argus.common.process.CommandRunner.class),
            jobs,
            mock(com.argus.backup.service.BackupOwnerAccess.class));
    try {
      assertThrows(
          org.springframework.web.server.ResponseStatusException.class,
          () -> service.start(Map.of()));
      assertThrows(
          org.springframework.web.server.ResponseStatusException.class,
          () -> controller.register(Map.of("path", root.toString())));
      verifyNoInteractions(workspace, discovery);
    } finally {
      service.close();
    }
  }

  @Test
  void failedExplicitReconnectDisconnectsRetainedIdentityWithoutPurgingItsOldData()
      throws Exception {
    var workspace = mock(WorkspaceService.class);
    var discovery = mock(RepositoryDiscoveryService.class);
    var contexts = mock(RepositoryContextService.class);
    var kits = mock(AiKitGenerationService.class);
    var disconnect = mock(RepositoryDisconnectService.class);
    var purge = mock(RepositoryPurgeService.class);
    var jobs =
        new BackgroundJobService(
            new AtomicJsonStore(new ObjectMapper()),
            new ArgusProperties(root, root, "test", "test"));
    var service =
        new RepositoryOnboardingService(
            workspace, discovery, jobs, new BackgroundOperationService(jobs), contexts, kits);
    @SuppressWarnings("unchecked")
    ObjectProvider<RepositoryPurgeService> purges = mock(ObjectProvider.class);
    @SuppressWarnings("unchecked")
    ObjectProvider<RepositoryDisconnectService> disconnects = mock(ObjectProvider.class);
    when(purges.getObject()).thenReturn(purge);
    when(disconnects.getObject()).thenReturn(disconnect);
    service.setPurgeService(purges);
    service.setDisconnectService(disconnects);
    var retained = new Repository("retained", "Saved", root.toString(), "old", "main");
    when(workspace.snapshot())
        .thenReturn(
            new WorkspaceResponse(1, null, Map.of(), List.of(), List.of(), List.of(), Map.of()));
    when(workspace.hasDisconnectedPath(root.toString())).thenReturn(true);
    when(workspace.onboardRepository(root.toString(), "main")).thenReturn(retained);
    when(discovery.branchOptions(root.toString()))
        .thenReturn(Map.of("path", root.toString(), "name", "Saved", "branches", List.of("main")));
    doThrow(new IllegalStateException("Fixture reconnect interruption"))
        .when(disconnect)
        .reconnectRepository("retained");
    try {
      var job =
          service.start(
              Map.of(
                  "repositories",
                  List.of(Map.of("path", root.toString(), "productionBranch", "main"))));
      String id = String.valueOf(job.get("id"));
      long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
      while (BackgroundJobService.active(jobs.get(id)) && System.nanoTime() < deadline)
        Thread.sleep(10);
      assertFalse(BackgroundJobService.active(jobs.get(id)));
      assertEquals(1, ((Number) jobs.get(id).get("failed")).intValue());
      verify(disconnect).disconnectRepository(retained, true);
      verifyNoInteractions(purge, contexts);
    } finally {
      service.close();
    }
  }
}
