package com.argus.onboarding.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.background.service.BackgroundJobService;
import com.argus.backup.service.BackupCoordinator;
import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.json.JsonMapper;

class RepositoryOffboardingServiceTest {
  @TempDir Path root;

  @Test
  void disconnectsWithoutDeletingDataOrInvalidatingAnyBackup() throws Exception {
    var f = fixture();
    var released = new AtomicBoolean();
    when(f.backup.beginOffboarding()).thenReturn(() -> released.set(true));
    when(f.disconnect.disconnectRepository(any()))
        .thenReturn(Map.of("repositoryId", "repo", "dataPreserved", true));
    String id =
        (String)
            f.service
                .start(Map.of("confirmation", "OFFBOARD", "repositoryIds", List.of("repo", "repo")))
                .get("id");
    f.service.quiesce();
    var job = f.jobs.get(id);
    assertEquals("completed", job.get("status"));
    assertEquals(1, ((List<?>) job.get("items")).size());
    assertEquals(1, ((Number) job.get("completed")).intValue());
    assertTrue(job.get("message").toString().contains("All data and chats were retained"));
    assertTrue(released.get());
    verify(f.backup).beginOffboarding();
    verifyNoMoreInteractions(f.backup);
    verify(f.disconnect).disconnectRepository(any());
    verify(f.workspace, never()).remove(anyString());
    verify(f.workspace, never()).detachRepositoryGroups(any());
    verify(f.onboarding).allowPaths(List.of(root.toString()));
  }

  @Test
  void requiresConfirmationAndAllTargetsBeforeReservingOrDisconnecting() {
    var f = fixture();
    assertThrows(
        IllegalArgumentException.class,
        () -> f.service.start(Map.of("repositoryIds", List.of("repo"))));
    assertThrows(
        IllegalArgumentException.class, () -> f.service.start(Map.of("confirmation", "offboard")));
    verifyNoInteractions(f.backup, f.disconnect);
    f.service.quiesce();
  }

  @Test
  void failedDrainDoesNotRemoveRepositoryOrTouchBackup() throws Exception {
    var f = fixture();
    when(f.backup.beginOffboarding()).thenReturn(() -> {});
    when(f.disconnect.disconnectRepository(any()))
        .thenThrow(new IllegalStateException("Worker did not drain"));
    String id =
        (String)
            f.service
                .start(Map.of("confirmation", "offboard", "repositoryIds", List.of("repo")))
                .get("id");
    f.service.quiesce();
    assertEquals("completed-with-errors", f.jobs.get(id).get("status"));
    assertTrue(f.jobs.get(id).get("message").toString().contains("All data was retained"));
    verify(f.workspace, never()).remove(anyString());
    verify(f.backup, never()).refreshAfterOffboarding(any());
    verify(f.onboarding).allowPaths(List.of());
  }

  private Fixture fixture() {
    var workspace = mock(WorkspaceService.class);
    var disconnect = mock(RepositoryDisconnectService.class);
    var backup = mock(BackupCoordinator.class);
    var onboarding = mock(RepositoryOnboardingService.class);
    var jobs =
        new BackgroundJobService(
            new AtomicJsonStore(JsonMapper.builder().build()),
            new ArgusProperties(root, root, "test", "test"));
    when(workspace.requireRepository("repo"))
        .thenReturn(new Repository("repo", "Repository", root.toString(), "test"));
    return new Fixture(
        workspace,
        disconnect,
        backup,
        jobs,
        onboarding,
        new RepositoryOffboardingService(workspace, disconnect, backup, jobs, onboarding));
  }

  record Fixture(
      WorkspaceService workspace,
      RepositoryDisconnectService disconnect,
      BackupCoordinator backup,
      BackgroundJobService jobs,
      RepositoryOnboardingService onboarding,
      RepositoryOffboardingService service) {}
}
