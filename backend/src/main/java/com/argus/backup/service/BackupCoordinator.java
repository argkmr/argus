package com.argus.backup.service;

import com.argus.background.service.BackgroundJobService;
import com.argus.background.service.BackgroundOperationService;
import com.argus.common.security.KeychainSecretStore;
import com.argus.platform.RestoreMaintenanceService;
import com.argus.workspace.service.WorkspaceService;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * One-use, destination-bound human confirmations; no endpoint accepts an arbitrary archive path.
 */
@Service
public class BackupCoordinator implements AutoCloseable, com.argus.platform.NativeBackgroundOwner {
  private final BackupService backup;
  private final WorkspaceService workspace;
  private final KeychainSecretStore secrets;
  private final GoogleDriveDetector drive;
  private final BackgroundJobService jobs;
  private final BackgroundOperationService operations;
  private final RestoreMaintenanceService maintenance;
  private final Clock clock;
  private final BackupOwnerAccess owner;
  private final Map<String, Confirmation> confirmations = new LinkedHashMap<>();
  private final ExecutorService executor =
      Executors.newSingleThreadExecutor(
          task -> {
            var thread = new Thread(task, "argus-native-backup");
            thread.setDaemon(true);
            return thread;
          });
  private volatile boolean closing;
  private volatile BackgroundOperationService.Operation activeControl;
  private boolean offboarding;
  private boolean restoring;

  @Autowired
  public BackupCoordinator(
      BackupService backup,
      WorkspaceService workspace,
      KeychainSecretStore secrets,
      GoogleDriveDetector drive,
      BackgroundJobService jobs,
      BackgroundOperationService operations,
      RestoreMaintenanceService maintenance,
      BackupOwnerAccess owner) {
    this(
        backup, workspace, secrets, drive, jobs, operations, maintenance, Clock.systemUTC(), owner);
  }

  BackupCoordinator(
      BackupService backup,
      WorkspaceService workspace,
      KeychainSecretStore secrets,
      GoogleDriveDetector drive,
      BackgroundJobService jobs,
      BackgroundOperationService operations,
      RestoreMaintenanceService maintenance,
      Clock clock,
      BackupOwnerAccess owner) {
    this.backup = backup;
    this.workspace = workspace;
    this.secrets = secrets;
    this.drive = drive;
    this.jobs = jobs;
    this.operations = operations;
    this.maintenance = maintenance;
    this.clock = clock;
    this.owner = owner;
  }

  public Map<String, Object> access() {
    return Map.of("allowed", owner.allowed());
  }

  public boolean available() {
    return owner.allowed();
  }

  public Map<String, Object> configuration() {
    if (!owner.allowed()) return Map.of();
    var result = object(workspace.snapshot().preferences().get("backup"));
    if (!text(result.get("driveDirectory")).isBlank()) result.put("driveAutoDetected", false);
    else {
      var detected = drive.detect();
      result.put("driveDirectory", detected.get("path"));
      result.put("driveAutoDetected", detected.get("detected"));
      result.put("driveAccount", detected.get("account"));
      result.put("driveDetectionAmbiguous", detected.get("ambiguous"));
    }
    return result;
  }

  public Map<String, Object> visibleConfiguration() {
    if (!owner.allowed()) return Map.of();
    var result = configuration();
    String remote = text(result.get("repositoryUrl")).trim();
    boolean confirmed = !remote.isBlank() && backup.verifyPushAccess(remote);
    // An unavailable network must not erase the configured destination from the editor.
    result.put("repositoryUrl", remote);
    result.put("gitAccessConfirmed", confirmed);
    result.put("backupMode", remote.isBlank() ? "not-configured" : "git-and-drive");
    return result;
  }

  public Map<String, Object> status() {
    owner.requireAllowed();
    var visible = visibleConfiguration();
    var result = new LinkedHashMap<>(backup.status(visible));
    for (String key :
        List.of(
            "gitAccessConfirmed",
            "backupMode",
            "driveAutoDetected",
            "driveAccount",
            "driveDetectionAmbiguous"))
      result.put(key, visible.getOrDefault(key, key.equals("driveAccount") ? "" : false));
    result.put("hasRecoveryPassphrase", !passphrase().isBlank());
    return result;
  }

  public synchronized Map<String, Object> settings(Map<String, Object> input) {
    owner.requireAllowed();
    if (closing
        || offboarding
        || restoring
        || backup.active()
        || jobs.list().stream()
            .anyMatch(
                job -> "backup-sync".equals(job.get("type")) && BackgroundJobService.active(job)))
      throw conflict(
          "Wait for the current backup or offboarding operation before changing backup settings");
    String remote = BackupRepositoryUrl.normalize(text(input.get("repositoryUrl"))),
        location = text(input.get("driveDirectory")).trim(),
        entered = text(input.get("passphrase"));
    requireDestinations(remote, location);
    backup.plan(remote, location); // Validate both roots and source before credentials or Git work.
    if (entered.isBlank() && passphrase().isBlank())
      throw new IllegalArgumentException("Recovery passphrase is required before saving a backup");
    if (!entered.isBlank() && entered.length() < 12)
      throw new IllegalArgumentException("Use a recovery passphrase with at least 12 characters");
    if (!backup.verifyPushAccess(remote))
      throw new IllegalArgumentException(
          "Git remote push access is not available on this Mac. Connect to the required network or fix Git access, then try again.");
    if (!entered.isBlank()) secrets.setLocal("argus-backup", "recovery-passphrase", entered);
    workspace.preferences(
        Map.of(
            "backup",
            Map.of(
                "repositoryUrl",
                remote,
                "driveDirectory",
                location,
                "inaccessibleRepositoryUrl",
                "")));
    return status();
  }

  public synchronized Map<String, Object> confirmation(Map<String, Object> input) {
    owner.requireAllowed();
    String remote = BackupRepositoryUrl.normalize(text(input.get("repositoryUrl"))),
        location = text(input.get("driveDirectory")).trim();
    requireDestinations(remote, location);
    confirmations.entrySet().removeIf(entry -> entry.getValue().expires <= clock.millis());
    if (confirmations.size() >= 128)
      throw conflict("Too many pending backup confirmations; try again after they expire");
    String id = UUID.randomUUID().toString();
    long expires = clock.millis() + Duration.ofMinutes(15).toMillis();
    var plan = backup.plan(remote, location);
    confirmations.put(id, new Confirmation(remote, location, expires));
    return Map.of(
        "confirmationId", id, "expiresAt", Instant.ofEpochMilli(expires).toString(), "plan", plan);
  }

  public synchronized Map<String, Object> sync(Map<String, Object> input) {
    owner.requireAllowed();
    if (closing || offboarding || restoring)
      throw conflict("Argus is shutting down, restoring, or repository offboarding is in progress");
    var active =
        jobs.list().stream()
            .filter(
                job -> "backup-sync".equals(job.get("type")) && BackgroundJobService.active(job))
            .findFirst();
    if (active.isPresent()) return active.get();
    var selected = configuration();
    var confirmed = confirmations.remove(text(input.get("confirmationId")));
    if (confirmed == null || confirmed.expires <= clock.millis())
      throw conflict("Review and confirm the backup destinations before saving");
    if (!confirmed.remote.equals(text(selected.get("repositoryUrl")))
        || !confirmed.drive.equals(text(selected.get("driveDirectory"))))
      throw conflict("Backup destinations changed after confirmation; review them again");
    String passphrase = passphrase();
    if (passphrase.isBlank())
      throw new IllegalArgumentException(
          "Configure a recovery passphrase before saving Argus changes");
    var phases =
        List.of(
            "Prepare backup working copy",
            "Encrypt private Argus data",
            "Prepare readable Argus source",
            "Update Git remote main",
            "Mirror to Google Drive");
    var job =
        jobs.create(
            Map.of(
                "type",
                "backup-sync",
                "title",
                "Saving Argus changes",
                "message",
                "Backup is running in the background. You can keep using Argus.",
                "total",
                phases.size(),
                "items",
                phases.stream().map(name -> Map.of("name", name)).toList()));
    String id = text(job.get("id"));
    var configurations = workspace.snapshot().runConfigurations();
    executor.execute(() -> run(id, confirmed, passphrase, configurations));
    return job;
  }

  private void run(
      String id,
      Confirmation configuration,
      String passphrase,
      List<Map<String, Object>> configurations) {
    Thread thread = Thread.currentThread();
    try (var control = operations.register(id, () -> {}, () -> {}, thread::interrupt)) {
      owner.requireAllowed();
      activeControl = control;
      if (closing) control.shutdown();
      control.checkpoint();
      jobs.update(id, Map.of("status", "running", "startedAt", Instant.now().toString()));
      var result =
          backup.sync(
              configuration.remote,
              configuration.drive,
              passphrase,
              configurations,
              progress -> {
                control.checkpoint();
                if (closing || thread.isInterrupted())
                  throw new CancellationException("Backup stopped");
                int count = ((Number) progress.get("completed")).intValue();
                jobs.update(
                    id,
                    Map.of(
                        "completed",
                        count,
                        "currentItem",
                        progress.get("phase"),
                        "message",
                        progress.get("message")));
                if (count > 0) jobs.updateItem(id, count - 1, Map.of("status", "completed"));
                if (count < 5) jobs.updateItem(id, count, Map.of("status", "running"));
                jobs.appendLog(
                    id, Map.of("stage", progress.get("phase"), "message", progress.get("message")));
              });
      control.checkpoint();
      jobs.update(
          id,
          Map.of(
              "status",
              "completed",
              "completed",
              5,
              "currentItem",
              "",
              "message",
              "Git remote and Google Drive are up to date.",
              "completedAt",
              Instant.now().toString(),
              "result",
              result));
    } catch (Exception error) {
      // FileChannel.force aborts on an interrupted thread. Persist terminal state first,
      // then restore cancellation so shutdown semantics are not lost.
      boolean interrupted = Thread.interrupted();
      try {
        if (closing
            || "cancelled".equals(jobs.get(id).get("status"))
            || error instanceof CancellationException
            || error instanceof InterruptedException
            || interrupted)
          jobs.update(
              id,
              Map.of(
                  "status",
                  "cancelled",
                  "message",
                  "Stopped by user.",
                  "completedAt",
                  Instant.now().toString()));
        else {
          String message = Objects.toString(error.getMessage(), "Backup could not complete");
          Object completed = jobs.get(id).get("completed");
          int failedIndex = completed instanceof Number number ? number.intValue() : 0;
          if (failedIndex >= 0 && failedIndex < 5)
            jobs.updateItem(id, failedIndex, Map.of("status", "failed", "error", message));
          jobs.update(
              id,
              Map.of(
                  "status",
                  "failed",
                  "failed",
                  1,
                  "error",
                  message,
                  "message",
                  message,
                  "completedAt",
                  Instant.now().toString()));
          jobs.appendLog(id, Map.of("level", "error", "stage", "Backup", "message", message));
        }
      } finally {
        if (interrupted) Thread.currentThread().interrupt();
      }
    } finally {
      activeControl = null;
    }
  }

  public Map<String, Object> restore(Map<String, Object> input) {
    owner.requireAllowed();
    synchronized (this) {
      if (closing
          || offboarding
          || restoring
          || backup.active()
          || jobs.list().stream().anyMatch(BackgroundJobService::active))
        throw conflict(
            "Stop active responses, services and background activities before restoring a backup");
      restoring = true;
    }
    boolean entered = false;
    try {
      String passphrase = text(input.get("passphrase"));
      if (passphrase.isBlank()) passphrase = passphrase();
      if (passphrase.isBlank())
        throw new IllegalArgumentException(
            "Enter the recovery passphrase used to create the backup");
      var configuration = visibleConfiguration();
      entered = true;
      var gated = maintenance.enter();
      if (!gated.ok()) throw conflict(gated.error() + ". Restart Argus before continuing.");
      try {
        return backup.restore(
            passphrase,
            text(configuration.get("driveDirectory")),
            text(configuration.get("repositoryUrl")));
      } catch (BackupService.RestoreFailure error) {
        throw error;
      } catch (RuntimeException error) {
        throw conflict(
            Objects.toString(error.getMessage(), "Restore failed")
                + ". Restart Argus before continuing.");
      }
    } finally {
      if (!entered)
        synchronized (this) {
          restoring = false;
        }
    }
  }

  private String passphrase() {
    return secrets.getLocal("argus-backup", "recovery-passphrase");
  }

  public synchronized AutoCloseable beginOffboarding() {
    if (offboarding
        || restoring
        || closing
        || backup.active()
        || jobs.list().stream()
            .anyMatch(
                job -> "backup-sync".equals(job.get("type")) && BackgroundJobService.active(job)))
      throw conflict("Wait for the current backup or offboarding operation to finish");
    offboarding = true;
    return () -> {
      synchronized (BackupCoordinator.this) {
        offboarding = false;
      }
    };
  }

  public Map<String, Object> refreshAfterOffboarding(
      java.util.function.Consumer<Map<String, Object>> progress) {
    synchronized (this) {
      if (!offboarding)
        throw new IllegalStateException(
            "Offboarding must reserve the backup coordinator before removing local data");
    }
    if (!owner.allowed()) return Map.of("refreshed", false, "skipped", true);
    var configuration = configuration();
    String remote = text(configuration.get("repositoryUrl")),
        drive = text(configuration.get("driveDirectory")),
        password = passphrase();
    try {
      if (!remote.isBlank() && !drive.isBlank() && !password.isBlank())
        return backup.sync(
            remote, drive, password, workspace.snapshot().runConfigurations(), progress);
      backup.invalidateLocalSnapshot();
      backup.removeDriveSnapshot(drive);
      if (!remote.isBlank())
        throw new IllegalStateException(
            "Repositories were removed locally, but the optional remote backup could not be refreshed because its configuration is incomplete");
      return Map.of("refreshed", false, "invalidated", true);
    } catch (RuntimeException error) {
      try {
        backup.invalidateLocalSnapshot();
      } catch (RuntimeException cleanup) {
        error.addSuppressed(cleanup);
      }
      try {
        backup.removeDriveSnapshot(drive);
      } catch (RuntimeException cleanup) {
        error.addSuppressed(cleanup);
      }
      throw error;
    }
  }

  @Override
  public void close() {
    closing = true;
    var control = activeControl;
    if (control != null) control.shutdown();
    executor.shutdownNow();
    try {
      if (!executor.awaitTermination(10, TimeUnit.SECONDS))
        throw new IllegalStateException("Backup operation has not drained");
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("Backup drain interrupted", error);
    }
  }

  @Override
  public int shutdownOrder() {
    return 15;
  }

  @Override
  public String ownerName() {
    return "Native backups";
  }

  @Override
  public void quiesce() {
    close();
  }

  private static void requireDestinations(String remote, String drive) {
    if (remote.isBlank() || drive.isBlank())
      throw new IllegalArgumentException(
          "A verified Git remote repository and Google Drive folder are both required");
  }

  private static ResponseStatusException conflict(String message) {
    return new ResponseStatusException(HttpStatus.CONFLICT, message);
  }

  private static String text(Object value) {
    return value == null ? "" : String.valueOf(value);
  }

  @SuppressWarnings("unchecked")
  private static LinkedHashMap<String, Object> object(Object value) {
    return value instanceof Map<?, ?>
        ? new LinkedHashMap<>((Map<String, Object>) value)
        : new LinkedHashMap<>();
  }

  private record Confirmation(String remote, String drive, long expires) {}
}
