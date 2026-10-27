package com.argus.workspace.repository;

import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.workspace.domain.Workspace;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import org.springframework.stereotype.Repository;

@Repository
public class WorkspaceRepository {
  private final AtomicJsonStore json;
  private final Path path;
  private Workspace workspace;
  private FileTime loadedAt;

  public WorkspaceRepository(AtomicJsonStore json, ArgusProperties properties) {
    this.json = json;
    this.path = properties.dataDirectory().resolve("workspace.json");
    this.workspace = Files.exists(path) ? json.read(path, Workspace.class) : new Workspace();
    normalize();
    // Node initializes the shared workspace. A Java read/startup must not race
    // that writer by persisting an empty aggregate over newly connected repos.
    if (Files.exists(path)) rememberTimestamp();
  }

  public synchronized Workspace get() {
    reloadIfChanged();
    return workspace;
  }

  public synchronized void save() {
    json.write(path, workspace);
    rememberTimestamp();
  }

  private void reloadIfChanged() {
    if (!Files.exists(path)) return;
    try {
      FileTime current = Files.getLastModifiedTime(path);
      if (loadedAt == null || !current.equals(loadedAt)) {
        workspace = json.read(path, Workspace.class);
        normalize();
        loadedAt = current;
      }
    } catch (java.io.IOException error) {
      throw new IllegalStateException("Could not refresh " + path, error);
    }
  }

  private void rememberTimestamp() {
    try {
      loadedAt = Files.getLastModifiedTime(path);
    } catch (java.io.IOException error) {
      throw new IllegalStateException("Could not inspect " + path, error);
    }
  }

  private void normalize() {
    if (workspace.preferences == null) workspace.preferences = new java.util.LinkedHashMap<>();
    workspace.preferences.putIfAbsent("gitView", "changes");
    if (workspace.repositories == null) workspace.repositories = new java.util.ArrayList<>();
    if (workspace.disconnectedRepositories == null)
      workspace.disconnectedRepositories = new java.util.ArrayList<>();
    if (workspace.runConfigurations == null)
      workspace.runConfigurations = new java.util.ArrayList<>();
    if (workspace.apiRequests == null) workspace.apiRequests = new java.util.ArrayList<>();
    if (workspace.javaProjectSettings == null)
      workspace.javaProjectSettings = new java.util.LinkedHashMap<>();
  }
}
