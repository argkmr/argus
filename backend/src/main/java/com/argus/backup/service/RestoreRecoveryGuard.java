package com.argus.backup.service;

import java.nio.file.*;
import java.util.Map;
import java.util.Set;
import tools.jackson.databind.ObjectMapper;

/**
 * Startup-only check, before cached stores: interrupted restore is never replayed automatically.
 */
public final class RestoreRecoveryGuard {
  private RestoreRecoveryGuard() {}

  public static Map<String, Object> assertSafe(Path maintenanceRoot, ObjectMapper json) {
    Path root = maintenanceRoot.toAbsolutePath().normalize().resolve(".restore-recovery");
    if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS))
      return Map.of("safe", true, "recoveriesChecked", 0);
    try {
      BackupFiles.safeAncestors(root);
      if (!Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS))
        throw blocked(root, "unsafe recovery directory");
      try (var entries = Files.list(root)) {
        var paths = entries.limit(501).toList();
        if (paths.size() > 500) throw blocked(root, "too many recovery records");
        for (Path directory : paths) {
          if (!directory
                  .getFileName()
                  .toString()
                  .matches("[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
              || !Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS))
            throw blocked(directory, "unknown recovery entry");
          Path status = directory.resolve("status.json");
          if (!Files.isRegularFile(status, LinkOption.NOFOLLOW_LINKS) || Files.size(status) > 64000)
            throw blocked(directory, "missing or damaged recovery journal");
          Map<?, ?> journal;
          try (var input = Files.newInputStream(status, LinkOption.NOFOLLOW_LINKS)) {
            journal = json.readValue(input.readNBytes(64001), Map.class);
          }
          if (!Integer.valueOf(1).equals(journal.get("version"))
              || !Set.of("prepared", "completed", "rolled-back").contains(journal.get("status")))
            throw blocked(directory, "unverified recovery state: " + journal.get("status"));
        }
        return Map.of("safe", true, "recoveriesChecked", paths.size());
      }
    } catch (RecoveryRequired error) {
      throw error;
    } catch (Exception error) {
      throw blocked(root, "missing, damaged, or unsafe recovery journal");
    }
  }

  private static RecoveryRequired blocked(Path location, String reason) {
    return new RecoveryRequired(
        location,
        "Argus cannot start because a previous restore needs verification ("
            + reason
            + "). Recovery data is retained at "
            + location
            + ". Verify or recover the pre-restore data before restarting; no recovery files were deleted or replayed.");
  }

  public static final class RecoveryRequired extends IllegalStateException {
    private final Path recoveryPath;

    RecoveryRequired(Path recoveryPath, String message) {
      super(message);
      this.recoveryPath = recoveryPath;
    }

    public String code() {
      return "ARGUS_RESTORE_RECOVERY_REQUIRED";
    }

    public Path recoveryPath() {
      return recoveryPath;
    }

    public boolean restartRequired() {
      return true;
    }
  }
}
