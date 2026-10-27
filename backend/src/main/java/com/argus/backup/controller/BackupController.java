package com.argus.backup.controller;

import com.argus.backup.service.BackupCoordinator;
import com.argus.backup.service.DataStorageService;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@RestController
public class BackupController {
  private final BackupCoordinator backup;
  private final DataStorageService storage;

  public BackupController(BackupCoordinator backup, DataStorageService storage) {
    this.backup = backup;
    this.storage = storage;
  }

  @GetMapping("/api/backup/status")
  public Map<String, Object> status() {
    return backup.status();
  }

  @PostMapping("/api/backup/settings")
  public Map<String, Object> settings(@RequestBody Map<String, Object> input) {
    return backup.settings(input);
  }

  @PostMapping("/api/backup/confirmation")
  @ResponseStatus(HttpStatus.CREATED)
  public Map<String, Object> confirmation(@RequestBody Map<String, Object> input) {
    return backup.confirmation(input);
  }

  @PostMapping("/api/backup/sync")
  @ResponseStatus(HttpStatus.ACCEPTED)
  public Map<String, Object> sync(@RequestBody Map<String, Object> input) {
    return backup.sync(input);
  }

  @PostMapping("/api/backup/restore")
  public Map<String, Object> restore(@RequestBody Map<String, Object> input) {
    return backup.restore(input);
  }

  @GetMapping("/api/data-storage")
  public Map<String, Object> inventory() {
    return storage.inventory(backup.visibleConfiguration());
  }

  @PostMapping("/api/data-storage/open")
  public Map<String, Object> open(@RequestBody Map<String, Object> input) {
    return storage.open(String.valueOf(input.getOrDefault("target", "")), backup.configuration());
  }
}
