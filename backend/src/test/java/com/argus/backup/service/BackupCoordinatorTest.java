package com.argus.backup.service;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.background.service.*;
import com.argus.common.config.ArgusProperties;
import com.argus.common.security.KeychainSecretStore;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.platform.RestoreMaintenanceService;
import com.argus.workspace.dto.WorkspaceResponse;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Path;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class BackupCoordinatorTest {
  @TempDir Path temporary;

  @Test
  void unverifiedConfiguredRemoteRemainsEditableAndActiveBackupBlocksSettingsChanges() {
    Fixture f = fixture("https://bitbucket.org/example/backup", "/example/Drive");
    when(f.backup.verifyPushAccess(anyString())).thenReturn(false);
    try (var coordinator = f.coordinator) {
      assertThat(coordinator.visibleConfiguration())
          .containsEntry("repositoryUrl", "https://bitbucket.org/example/backup")
          .containsEntry("backupMode", "git-and-drive")
          .containsEntry("gitAccessConfirmed", false);
      when(f.backup.active()).thenReturn(true);
      assertThatThrownBy(
              () ->
                  coordinator.settings(
                      Map.of(
                          "repositoryUrl",
                          "https://bitbucket.org/example/new",
                          "driveDirectory",
                          "/another/Drive",
                          "passphrase",
                          "replacement recovery passphrase")))
          .hasMessageContaining("before changing backup settings");
      verify(f.secrets, never()).setLocal(anyString(), anyString(), anyString());
      verify(f.backup, never()).plan(anyString(), anyString());
    }
  }

  @Test
  void confirmationsAreExpiringSingleUseAndBoundToExactDestinations() {
    Fixture f = fixture("https://bitbucket.org/example/backup", "/example/Drive");
    try (var coordinator = f.coordinator) {
      var input =
          Map.<String, Object>of(
              "repositoryUrl",
              "https://bitbucket.org/example/backup",
              "driveDirectory",
              "/example/Drive");
      String token = coordinator.confirmation(input).get("confirmationId").toString();
      when(f.clock.millis()).thenReturn(901001L);
      assertThatThrownBy(() -> coordinator.sync(Map.of("confirmationId", token)))
          .hasMessageContaining("Review and confirm");
      when(f.clock.millis()).thenReturn(1000L);
      String second = coordinator.confirmation(input).get("confirmationId").toString();
      f.configuration.put("driveDirectory", "/another/Drive");
      assertThatThrownBy(() -> coordinator.sync(Map.of("confirmationId", second)))
          .hasMessageContaining("destinations changed");
      f.configuration.put("driveDirectory", "/example/Drive");
      assertThatThrownBy(() -> coordinator.sync(Map.of("confirmationId", second)))
          .hasMessageContaining("Review and confirm");
      verify(f.backup, never()).sync(anyString(), anyString(), anyString(), anyList(), any());
    }
  }

  @Test
  void browserDestinationIsNormalizedForConfirmationAndStoredOnlyInUserPreferences() {
    Fixture f = fixture("", "/example/Drive");
    String browser = "https://bitbucket.org/personal/private-backup/src/main/";
    String clone = "https://bitbucket.org/personal/private-backup.git";
    when(f.backup.verifyPushAccess(clone)).thenReturn(true);
    when(f.backup.status(anyMap())).thenAnswer(call -> call.getArgument(0));
    when(f.workspace.preferences(anyMap()))
        .thenAnswer(
            call -> {
              Map<String, Object> updates = call.getArgument(0);
              f.configuration.clear();
              f.configuration.putAll((Map<String, Object>) updates.get("backup"));
              return updates;
            });
    try (var coordinator = f.coordinator) {
      var input =
          Map.<String, Object>of(
              "repositoryUrl",
              browser,
              "driveDirectory",
              "/example/Drive",
              "passphrase",
              "synthetic recovery passphrase");
      coordinator.confirmation(input);
      verify(f.backup).plan(clone, "/example/Drive");
      verify(f.secrets, never()).setLocal(anyString(), anyString(), anyString());
      coordinator.settings(input);
      assertThat(f.configuration.get("repositoryUrl")).isEqualTo(clone);
      verify(f.workspace)
          .preferences(
              argThat(
                  updates ->
                      ((Map<?, ?>) updates.get("backup")).get("repositoryUrl").equals(clone)));
      verify(f.backup, never()).verifyPushAccess(browser);
      verify(f.backup, never()).sync(anyString(), anyString(), anyString(), anyList(), any());
    }
  }

  @Test
  void offboardingReservationExcludesNewBackupsAndInvalidatesUnconfiguredSnapshots()
      throws Exception {
    Fixture f = fixture("", "/example/Drive");
    try (var coordinator = f.coordinator;
        var reservation = coordinator.beginOffboarding()) {
      assertThatThrownBy(() -> coordinator.sync(Map.of())).hasMessageContaining("offboarding");
      assertThat(coordinator.refreshAfterOffboarding(ignored -> {}))
          .containsEntry("invalidated", true);
      verify(f.backup).invalidateLocalSnapshot();
      verify(f.backup).removeDriveSnapshot("/example/Drive");
      verify(f.backup, never()).sync(anyString(), anyString(), anyString(), anyList(), any());
    }
  }

  @Test
  void restoreRequiresDrainBeforeApplyingAnyDataAndRequiresRestartAfterward() {
    Fixture f = fixture("", "/example/Drive");
    when(f.secrets.getLocal("argus-backup", "recovery-passphrase"))
        .thenReturn("correct horse battery staple");
    when(f.maintenance.enter()).thenReturn(new RestoreMaintenanceService.Result(true, true, ""));
    when(f.backup.restore(anyString(), anyString(), anyString()))
        .thenReturn(Map.of("ok", true, "restartRequired", true));
    try (var coordinator = f.coordinator) {
      assertThat(coordinator.restore(Map.of())).containsEntry("restartRequired", true);
      var order = inOrder(f.maintenance, f.backup);
      order.verify(f.maintenance).enter();
      order.verify(f.backup).restore("correct horse battery staple", "/example/Drive", "");
      assertThatThrownBy(() -> coordinator.restore(Map.of())).hasMessageContaining("Stop active");
    }
  }

  @Test
  void quiesceInterruptsAndJoinsPausedBackupCheckpoint() throws Exception {
    Fixture f = fixture("https://bitbucket.org/example/backup", "/example/Drive");
    when(f.secrets.getLocal("argus-backup", "recovery-passphrase"))
        .thenReturn("correct horse battery staple");
    CountDownLatch started = new CountDownLatch(1),
        proceed = new CountDownLatch(1),
        finished = new CountDownLatch(1);
    var worker = new java.util.concurrent.atomic.AtomicReference<Thread>();
    var uncaught = new ConcurrentLinkedQueue<Throwable>();
    when(f.backup.sync(anyString(), anyString(), anyString(), anyList(), any()))
        .thenAnswer(
            call -> {
              worker.set(Thread.currentThread());
              Thread.currentThread()
                  .setUncaughtExceptionHandler((thread, error) -> uncaught.add(error));
              started.countDown();
              try {
                proceed.await();
                Consumer<Map<String, Object>> progress = call.getArgument(4);
                progress.accept(Map.of("completed", 1, "phase", "Encrypt", "message", "Encrypt"));
                return Map.of("ok", true);
              } finally {
                finished.countDown();
              }
            });
    try (var coordinator = f.coordinator) {
      String token =
          coordinator
              .confirmation(
                  Map.of(
                      "repositoryUrl",
                      "https://bitbucket.org/example/backup",
                      "driveDirectory",
                      "/example/Drive"))
              .get("confirmationId")
              .toString();
      String id = coordinator.sync(Map.of("confirmationId", token)).get("id").toString();
      assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
      f.operations.pause(id);
      proceed.countDown();
      for (int attempt = 0;
          attempt < 100 && worker.get().getState() != Thread.State.TIMED_WAITING;
          attempt++) Thread.sleep(10);
      assertThat(worker.get().getState()).isEqualTo(Thread.State.TIMED_WAITING);
      coordinator.quiesce();
      assertThat(finished.await(1, TimeUnit.SECONDS)).isTrue();
      worker.get().join(1000);
      assertThat(worker.get().isAlive()).isFalse();
      assertThat(uncaught).isEmpty();
      assertThat(f.jobs.get(id).get("status")).isEqualTo("cancelled");
      List<?> persisted =
          new ObjectMapper()
              .readValue(
                  java.nio.file.Files.readAllBytes(temporary.resolve("data/background-jobs.json")),
                  List.class);
      assertThat(persisted).hasSize(1);
      var saved = (Map<?, ?>) persisted.get(0);
      assertThat(saved.get("status")).isEqualTo("cancelled");
      assertThat(saved.get("completedAt")).isNotNull();
    }
  }

  private Fixture fixture(String remote, String directory) {
    var configuration =
        new LinkedHashMap<String, Object>(
            Map.of("repositoryUrl", remote, "driveDirectory", directory));
    var workspace = mock(WorkspaceService.class);
    when(workspace.snapshot())
        .thenAnswer(
            ignored ->
                new WorkspaceResponse(
                    1,
                    "",
                    Map.of("backup", configuration),
                    List.of(),
                    List.of(),
                    List.of(),
                    Map.of()));
    var backup = mock(BackupService.class);
    when(backup.plan(anyString(), anyString()))
        .thenReturn(Map.of("retention", "latest snapshot only"));
    var secrets = mock(KeychainSecretStore.class);
    when(secrets.getLocal(anyString(), anyString())).thenReturn("");
    var clock = mock(Clock.class);
    when(clock.millis()).thenReturn(1000L);
    var maintenance = mock(RestoreMaintenanceService.class);
    var properties =
        new ArgusProperties(
            temporary.resolve("data"), temporary.resolve("source"), "test", "token");
    var jobs = new BackgroundJobService(new AtomicJsonStore(new ObjectMapper()), properties);
    var operations = new BackgroundOperationService(jobs);
    var coordinator =
        new BackupCoordinator(
            backup,
            workspace,
            secrets,
            mock(GoogleDriveDetector.class),
            jobs,
            operations,
            maintenance,
            clock,
            BackupOwnerFixtures.allowed());
    return new Fixture(
        coordinator,
        backup,
        secrets,
        clock,
        maintenance,
        configuration,
        jobs,
        operations,
        workspace);
  }

  record Fixture(
      BackupCoordinator coordinator,
      BackupService backup,
      KeychainSecretStore secrets,
      Clock clock,
      RestoreMaintenanceService maintenance,
      Map<String, Object> configuration,
      BackgroundJobService jobs,
      BackgroundOperationService operations,
      WorkspaceService workspace) {}
}
