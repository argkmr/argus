package com.argus.backup.service;

import com.argus.common.process.CommandRunner;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class DataStorageService {
  private final BackupPaths paths;
  private final WorkspaceService workspace;
  private final CommandRunner commands;
  private final BackupOwnerAccess owner;

  public DataStorageService(
      BackupPaths paths,
      WorkspaceService workspace,
      CommandRunner commands,
      BackupOwnerAccess owner) {
    this.paths = paths;
    this.workspace = workspace;
    this.commands = commands;
    this.owner = owner;
  }

  public Map<String, Object> inventory(Map<String, Object> configuration) {
    boolean backupAvailable = owner.allowed();
    var locations = new LinkedHashMap<String, String>();
    for (var entry :
        Map.of(
                "workspace",
                "workspace.json",
                "environments",
                "environments",
                "aiTasks",
                "ai-tasks",
                "attachments",
                "context-attachments",
                "repositoryContexts",
                "repository-contexts",
                "repositoryArtifacts",
                "repository-artifacts",
                "providerHealth",
                "provider-health.json",
                "cancellationAudit",
                "cancellations.json",
                "uiPreferences",
                "Local Storage")
            .entrySet())
      locations.put(entry.getKey(), paths.data.resolve(entry.getValue()).toString());
    locations.put("apiCollections", paths.collections.toString());
    locations.put("apiEnvironments", paths.data.resolve("environments.json").toString());
    if (backupAvailable) {
      locations.put("backupRepository", paths.project.toString());
      locations.put("encryptedBackup", paths.encrypted.toString());
      locations.put("backupManifest", paths.manifest.toString());
      locations.put(
          "googleDrive", String.valueOf(configuration.getOrDefault("driveDirectory", "")));
    }
    var managed =
        Set.of(
            "workspace",
            "environments",
            "aiTasks",
            "attachments",
            "repositoryContexts",
            "repositoryArtifacts",
            "providerHealth",
            "cancellationAudit",
            "uiPreferences",
            "apiCollections",
            "apiEnvironments");
    var availability = new LinkedHashMap<String, Boolean>();
    var sizes = new LinkedHashMap<String, Long>();
    locations.forEach(
        (key, path) -> {
          availability.put(
              key, !path.isEmpty() && Files.exists(Path.of(path), LinkOption.NOFOLLOW_LINKS));
          long bytes =
              managed.contains(key) || key.equals("backupRepository") ? bytes(Path.of(path)) : 0;
          sizes.put(key, bytes);
        });
    var result = new LinkedHashMap<String, Object>();
    result.put("backupAvailable", backupAvailable);
    result.put("storageModel", "local-application-files");
    result.put("analytics", false);
    result.put("dataDirectory", paths.data.toString());
    result.put("locations", locations);
    result.put("availability", availability);
    result.put(
        "diskUsage",
        Map.of(
            "totalBytes",
            managed.stream().mapToLong(key -> sizes.getOrDefault(key, 0L)).sum(),
            "sizes",
            sizes,
            "backupBytes",
            sizes.getOrDefault("backupRepository", 0L),
            "measuredAt",
            Instant.now().toString(),
            "excludesConnectedSourceRepositories",
            true));
    result.put(
        "repositories",
        workspace.snapshot().repositories().stream()
            .map(repo -> Map.of("id", repo.id(), "name", repo.name(), "path", repo.path()))
            .toList());
    if (backupAvailable)
      result.put(
          "backup",
          Map.of(
              "repositoryUrl",
              configuration.getOrDefault("repositoryUrl", ""),
              "googleDriveDirectory",
              configuration.getOrDefault("driveDirectory", ""),
              "encryptedBeforeUpload",
              true,
              "algorithm",
              "AES-256-GCM with a scrypt-derived key"));
    return result;
  }

  public Map<String, Object> open(String target, Map<String, Object> configuration) {
    if (Set.of("backupRepository", "googleDrive").contains(target)) owner.requireAllowed();
    if (!System.getProperty("os.name", "").toLowerCase().contains("mac"))
      throw new IllegalArgumentException(
          "Opening storage folders is currently available on macOS only");
    String location =
        switch (target) {
          case "data" -> paths.data.toString();
          case "apiCollections" -> paths.collections.toString();
          case "backupRepository" -> paths.project.toString();
          case "googleDrive" -> String.valueOf(configuration.getOrDefault("driveDirectory", ""));
          default -> "";
        };
    if (location.isEmpty())
      throw new ResponseStatusException(
          HttpStatus.NOT_FOUND, "This storage location is not configured");
    Path path = Path.of(location);
    if (!Files.exists(path))
      throw new ResponseStatusException(
          HttpStatus.NOT_FOUND, "This location will be created when the feature is first used");
    commands.run("/usr/bin/open", List.of(location), null, Duration.ofSeconds(10));
    return Map.of("ok", true, "path", location);
  }

  private static long bytes(Path path) {
    if (Files.isSymbolicLink(path)) return 0;
    try {
      if (Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) return Files.size(path);
      long total = 0;
      for (Path file : BackupFiles.files(path)) total += Files.size(file);
      return total;
    } catch (Exception ignored) {
      return 0;
    }
  }
}
