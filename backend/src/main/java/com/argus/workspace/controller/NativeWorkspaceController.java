package com.argus.workspace.controller;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.background.service.BackgroundJobService;
import com.argus.backup.service.BackupOwnerAccess;
import com.argus.common.process.CommandRunner;
import com.argus.onboarding.service.RepositoryDiscoveryService;
import com.argus.workspace.service.WorkspaceService;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/** Disabled during migration: enable only after native end-to-end parity gates pass. */
@RestController
@RequestMapping("/api")
public class NativeWorkspaceController {
  private final WorkspaceService workspace;
  private final RepositoryDiscoveryService discovery;
  private final CommandRunner commands;
  private final BackgroundJobService background;
  private final BackupOwnerAccess owner;
  private com.argus.onboarding.service.RepositoryDisconnectService disconnects;

  @org.springframework.beans.factory.annotation.Autowired
  public void setDisconnectService(
      com.argus.onboarding.service.RepositoryDisconnectService disconnects) {
    this.disconnects = disconnects;
  }

  public NativeWorkspaceController(
      WorkspaceService workspace,
      RepositoryDiscoveryService discovery,
      CommandRunner commands,
      BackgroundJobService background,
      BackupOwnerAccess owner) {
    this.workspace = workspace;
    this.discovery = discovery;
    this.commands = commands;
    this.background = background;
    this.owner = owner;
  }

  @PostMapping("/repositories")
  @ResponseStatus(HttpStatus.CREATED)
  public Object register(@RequestBody Map<String, Object> input) {
    if (background.list().stream()
        .anyMatch(
            job ->
                "repository-offboarding".equals(job.get("type"))
                    && BackgroundJobService.active(job)))
      throw new ResponseStatusException(
          HttpStatus.CONFLICT, "Wait for repository disconnection to finish before reconnecting");
    var repository = workspace.addRepository(text(input, "path"));
    if (disconnects != null) disconnects.reconnectRepository(repository.id());
    return repository;
  }

  @PostMapping("/repositories/{id}/activate")
  public Map<String, Object> activate(@PathVariable String id) {
    workspace.activate(id);
    return Map.of("ok", true);
  }

  @PatchMapping("/preferences")
  public Map<String, Object> preferences(@RequestBody Map<String, Object> input) {
    if (input.containsKey("backup")) owner.requireAllowed();
    return owner.visiblePreferences(workspace.preferences(input));
  }

  @PostMapping("/repository-onboarding/discover")
  public Map<String, Object> discover(@RequestBody Map<String, Object> input) {
    List<String> paths =
        (input.get("paths") instanceof List<?>
                ? strings(input.get("paths"))
                : List.of(text(input, "path")))
            .stream().map(String::trim).filter(value -> !value.isEmpty()).toList();
    if (paths.isEmpty()) throw new IllegalArgumentException("Choose at least one folder");
    var repositories = discovery.discover(paths);
    if (repositories.isEmpty())
      throw new ResponseStatusException(
          HttpStatus.NOT_FOUND,
          "No Git repository was found. Argus can onboard only a folder containing a .git repository.");
    return object("repositories", repositories.stream().map(this::onboardingOptions).toList());
  }

  private Map<String, Object> onboardingOptions(String path) {
    var repository = discovery.inspect(path);
    workspace.snapshot().repositories().stream()
        .filter(existing -> existing.path().equals(repository.get("path")))
        .findFirst()
        .ifPresent(
            existing -> {
              repository.put("connected", true);
              repository.put("repositoryId", existing.id());
              repository.put("savedProductionBranch", existing.productionBranch());
              if (strings(repository.get("branches")).contains(existing.productionBranch()))
                repository.put("productionBranch", existing.productionBranch());
            });
    repository.put(
        "onboarding",
        background.list().stream()
            .filter(
                job ->
                    "repository-onboarding".equals(job.get("type"))
                        && BackgroundJobService.active(job))
            .anyMatch(
                job ->
                    list(job.get("items")).stream()
                        .anyMatch(item -> text(map(item), "path").equals(repository.get("path")))));
    return repository;
  }

  @GetMapping("/repository-onboarding/prerequisites")
  public Map<String, Object> prerequisites() {
    return discovery.prerequisites();
  }

  @PostMapping("/repository-onboarding/clone")
  @ResponseStatus(HttpStatus.CREATED)
  public Map<String, Object> cloneRepository(@RequestBody Map<String, Object> input) {
    var result =
        discovery.cloneWithDetails(text(input, "remoteUrl"), text(input, "destinationPath"));
    return object(
        "repository",
        onboardingOptions(result.path()),
        "transport",
        result.transport(),
        "fallbackUsed",
        result.fallbackUsed());
  }

  @PostMapping("/system/select-folder")
  public Map<String, Object> selectFolder(
      @RequestBody(required = false) Map<String, Object> input) {
    if (!System.getProperty("os.name").toLowerCase().contains("mac"))
      throw new IllegalArgumentException("Folder selection is available in the macOS desktop app");
    boolean clone = input != null && "clone-destination".equals(input.get("purpose"));
    String script =
        clone
            ? "POSIX path of (choose folder with prompt \"Choose where to clone the repository\")"
            : "set selectedFolders to choose folder with prompt \"Choose repositories or their parent folder\" with multiple selections allowed\nset resultPaths to {}\nrepeat with selectedFolder in selectedFolders\nset end of resultPaths to POSIX path of selectedFolder\nend repeat\nset AppleScript's text item delimiters to linefeed\nreturn resultPaths as text";
    try {
      String output =
          commands.run("osascript", List.of("-e", script), null, Duration.ofMinutes(5)).stdout();
      var paths =
          output
              .lines()
              .map(String::trim)
              .map(value -> value.replaceFirst("/$", ""))
              .filter(value -> !value.isEmpty())
              .toList();
      return object(
          "path", paths.isEmpty() ? "" : paths.get(0), "paths", paths, "cancelled", false);
    } catch (RuntimeException error) {
      if (String.valueOf(error.getMessage()).contains("-128")
          || String.valueOf(error.getMessage()).toLowerCase().contains("cancel"))
        return object("cancelled", true);
      throw error;
    }
  }
}
