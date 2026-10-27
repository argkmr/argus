package com.argus.backup.controller;

import com.argus.backup.service.BackupOwnerAccess;
import com.argus.common.process.CommandFailedException;
import com.argus.common.process.CommandRunner;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class BackupOwnerController {
  private final BackupOwnerAccess owner;
  private final CommandRunner commands;

  public BackupOwnerController(BackupOwnerAccess owner, CommandRunner commands) {
    this.owner = owner;
    this.commands = commands;
  }

  @GetMapping("/api/backup/access")
  public Map<String, Object> access() {
    return Map.of("allowed", owner.allowed());
  }

  @PostMapping("/api/system/select-backup-folder")
  public Map<String, Object> selectFolder() {
    owner.requireAllowed();
    try {
      String folder =
          commands
              .run(
                  "/usr/bin/osascript",
                  List.of(
                      "-e",
                      "POSIX path of (choose folder with prompt \"Choose the Google Drive folder for Argus backups\")"),
                  null,
                  Duration.ofMinutes(5))
              .stdout()
              .trim();
      if (folder.isBlank()) return Map.of("cancelled", true);
      return Map.of("cancelled", false, "path", folder.replaceFirst("/$", ""));
    } catch (CommandFailedException error) {
      if (error.result().stderr().contains("(-128)")) return Map.of("cancelled", true);
      throw error;
    }
  }
}
