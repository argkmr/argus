package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.common.error.ConflictException;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Service;

/** Explicit repository-header port edits. Does not start, restart or create a service. */
@Service
public class RuntimePortService {
  private final WorkspaceService workspace;
  private final RuntimeConfigurationService runtime;
  private final ApplicationConfigService application;
  private final LocalEnvironmentService local;
  private final ProcessManager processes;
  private final PortInventoryService inventory;

  public RuntimePortService(
      WorkspaceService workspace,
      RuntimeConfigurationService runtime,
      ApplicationConfigService application,
      LocalEnvironmentService local,
      ProcessManager processes,
      PortInventoryService inventory) {
    this.workspace = workspace;
    this.runtime = runtime;
    this.application = application;
    this.local = local;
    this.processes = processes;
    this.inventory = inventory;
  }

  public Map<String, Object> repositoryPorts(String repositoryId) {
    var repository = workspace.requireRepository(repositoryId);
    var result =
        object(
            "repositoryId",
            repositoryId,
            "applicationPort",
            null,
            "managementPort",
            null,
            "configFile",
            "",
            "editable",
            false,
            "running",
            false,
            "reason",
            "Configure in Services to edit.");
    try {
      var detected = runtime.resolve(repository, null);
      result.put("applicationPort", RuntimeDetector.validPort(detected.get("port")));
      result.put("managementPort", RuntimeDetector.validPort(detected.get("managementPort")));
      result.put("configFile", text(detected, "configFile"));
      result.put("portSource", "Detected configuration; not a verified listener");
    } catch (RuntimeException ignored) {
      result.put(
          "reason",
          "No unambiguous application port detected. Configure this repository in Services.");
    }
    return result;
  }

  private record State(
      Repository repository,
      Map<String, Object> saved,
      Map<String, Object> resolved,
      ApplicationConfigService.PortDocument document,
      LocalEnvironmentService.PortSnapshot environment,
      Map<String, String> runtimeEnvironment,
      Map<String, Object> metadata) {}

  public Map<String, Object> inspect(String id) {
    return state(id).metadata();
  }

  private State state(String id) {
    var saved = copyMap(workspace.runConfiguration(id));
    var repository = workspace.requireRepository(text(saved, "repositoryId"));
    var active = processes.getByConfiguration(id);
    boolean running = active != null && !text(active, "id").isBlank();
    var result =
        object(
            "configurationId",
            id,
            "repositoryId",
            repository.id(),
            "applicationPort",
            RuntimeDetector.validPort(saved.get("port")),
            "managementPort",
            RuntimeDetector.validPort(saved.get("managementPort")),
            "configFile",
            text(saved, "configFile"),
            "contentHash",
            "",
            "editable",
            false,
            "running",
            running,
            "restartRequired",
            false,
            "portSource",
            "Saved configuration; not a verified listener");
    Map<String, Object> resolved = saved;
    ApplicationConfigService.PortDocument document = null;
    LocalEnvironmentService.PortSnapshot environment = null;
    Map<String, String> runtimeEnvironment = Map.of();
    try {
      resolved = runtime.resolve(repository, saved);
      String file = text(resolved, "configFile");
      result.put("configFile", file);
      result.put("applicationPort", RuntimeDetector.validPort(resolved.get("port")));
      result.put("managementPort", RuntimeDetector.validPort(resolved.get("managementPort")));
      if (file.isBlank()) {
        var launch = LaunchPortCommand.inspect(Path.of(repository.path()), saved, 3000);
        environment = local.portSnapshot(id);
        result.put("editMode", "launch");
        result.put("contentHash", launchHash(saved, environment, launch));
        result.put("editable", true);
        result.put("affectedFiles", List.of());
        result.put("portSource", "Argus launch configuration; not a verified listener");
        result.put(
            "editNotice",
            "Updates this Services launch command and its local PORT value. Repository files stay unchanged. Restart a running service to apply.");
        return new State(repository, saved, resolved, null, environment, Map.of(), result);
      }
      if (!file.isBlank())
        document = application.inspectPorts(Path.of(repository.path()), file, true);
      else
        throw new IllegalArgumentException(
            "This runtime has no application.yml. Edit its launch command or environment in Services.");
      result.put("contentHash", document.hash());
      environment = local.portSnapshot(id);
      runtimeEnvironment = new LinkedHashMap<>();
      for (var entry : map(saved.get("env")).entrySet())
        runtimeEnvironment.put(entry.getKey(), text(entry.getValue()));
      runtimeEnvironment.putAll(environment.values());
      boolean localOverride = document.configurationOverrides();
      result.put("environmentOverrideRequired", localOverride);
      if (localOverride) {
        result.put("savedApplicationPort", RuntimeDetector.validPort(saved.get("port")));
        result.put("environmentFile", ".argus-data/environments/" + id + ".env");
        result.put(
            "editNotice",
            "Updates this YAML and Argus's local SERVER_PORT override; profiles and imports stay unchanged. Restart a running service to apply the change.");
      }
      result.put(
          "applicationPort",
          localOverride
              ? RuntimeDetector.validPort(runtimeEnvironment.get("SERVER_PORT"))
              : effectivePort(document, "server.port", runtimeEnvironment, 8080));
      result.put(
          "managementPort",
          localOverride
              ? RuntimeDetector.validPort(runtimeEnvironment.get("MANAGEMENT_SERVER_PORT"))
              : effectivePort(document, "management.server.port", runtimeEnvironment, null));
      result.put(
          "portSource",
          localOverride
              ? runtimeEnvironment.containsKey("SERVER_PORT")
                  ? "Argus local port override; not a verified listener"
                  : "Profiles or imports may override the base YAML; effective port not verified"
              : "Application configuration and local environment; not a verified listener");
      validateSources(repository, saved, resolved, document, environment, runtimeEnvironment);
      result.put("editable", true);
    } catch (RuntimeException error) {
      // Environment/secret parsing errors can contain values; expose only our own safe reasons.
      result.put(
          "reason",
          error instanceof PortSourceException
                  || error instanceof IllegalArgumentException
                      && (document == null || error.getMessage().startsWith("This runtime"))
              ? error.getMessage()
              : "Port sources could not be safely verified. Review this configuration in Services.");
    }
    return new State(
        repository, saved, resolved, document, environment, runtimeEnvironment, result);
  }

  private static class PortSourceException extends IllegalArgumentException {
    PortSourceException(String message) {
      super(message);
    }
  }

  private static String launchHash(
      Map<String, Object> saved,
      LocalEnvironmentService.PortSnapshot environment,
      LaunchPortCommand launch) {
    return ApplicationConfigService.contentHash(
        saved.toString() + "\n" + environment.source() + "\n" + launch.fingerprint());
  }

  private Map<String, Object> updateLaunch(
      String id, State state, Map<String, Object> input, int port) {
    if (input.containsKey("managementPort"))
      throw new IllegalArgumentException(
          "This launch does not expose an editable management port.");
    if (!text(input, "configFile").isBlank()
        || !text(state.metadata(), "contentHash").equals(text(input, "expectedContentHash")))
      throw new ConflictException("Service configuration changed. Refresh before saving the port.");
    if (port == number(state.metadata().get("managementPort")))
      throw new IllegalArgumentException("Application and management ports must be different.");
    for (var other : workspace.snapshot().runConfigurations()) {
      if (id.equals(text(other, "id"))) continue;
      var effective = RuntimeDetector.applyEnvironmentPorts(other, map(other.get("env")));
      effective =
          RuntimeDetector.applyEnvironmentPorts(effective, local.resolve(text(other, "id")));
      if (number(effective.get("port")) == port || number(effective.get("managementPort")) == port)
        throw new ConflictException("The requested port is already assigned to another service.");
    }
    var launch = LaunchPortCommand.inspect(Path.of(state.repository().path()), state.saved(), port);
    var environment = new LinkedHashMap<>(state.environment().values());
    environment.put("PORT", Integer.toString(port));
    var inline = new LinkedHashMap<>(map(state.saved().get("env")));
    if (inline.containsKey("PORT")) inline.put("PORT", Integer.toString(port));
    var keys = new LinkedHashSet<>(strings(state.saved().get("environmentKeys")));
    keys.addAll(environment.keySet());
    var changes =
        object(
            "port",
            port,
            "args",
            launch.arguments(),
            "env",
            inline,
            "environmentKeys",
            keys.stream().sorted().toList(),
            "environmentFile",
            ".argus-data/environments/" + id + ".env",
            "environmentUpdatedAt",
            java.time.Instant.now().toString());
    String written = null;
    boolean workspaceAttempted = false;
    try {
      written = local.replacePortValues(id, state.environment(), environment);
      workspaceAttempted = true;
      workspace.updateRunConfiguration(id, changes);
    } catch (RuntimeException failure) {
      try {
        if (workspaceAttempted) {
          var current = workspace.runConfiguration(id);
          current.clear();
          current.putAll(copyMap(state.saved()));
          workspace.updateRunConfiguration(id, state.saved());
        }
        if (written != null) local.restorePortValues(id, written, state.environment());
      } catch (RuntimeException rollback) {
        throw new IllegalStateException(
            "Port update failed and could not be fully restored. Review this service configuration before running.",
            failure);
      }
      throw failure;
    }
    var updated = state(id).metadata();
    updated.put("changed", true);
    updated.put("restartRequired", Boolean.TRUE.equals(state.metadata().get("running")));
    updated.put("environmentUpdated", true);
    return updated;
  }

  private static Set<String> environmentKeys(
      ApplicationConfigService.PortDocument document, String property) {
    var keys = new LinkedHashSet<String>();
    keys.add(property.equals("server.port") ? "SERVER_PORT" : "MANAGEMENT_SERVER_PORT");
    String placeholder = document.placeholder(property);
    if (!placeholder.isEmpty()) keys.add(placeholder);
    return keys;
  }

  private static Integer effectivePort(
      ApplicationConfigService.PortDocument document,
      String property,
      Map<String, String> environment,
      Integer fallback) {
    String standard = property.equals("server.port") ? "SERVER_PORT" : "MANAGEMENT_SERVER_PORT";
    if (environment.containsKey(standard))
      return RuntimeDetector.validPort(environment.get(standard));
    String placeholder = document.placeholder(property);
    if (!placeholder.isEmpty() && environment.containsKey(placeholder))
      return RuntimeDetector.validPort(environment.get(placeholder));
    Integer configured = RuntimeDetector.validPort(document.value(property));
    return configured == null && document.value(property).isBlank() ? fallback : configured;
  }

  private void validateSources(
      Repository repository,
      Map<String, Object> saved,
      Map<String, Object> resolved,
      ApplicationConfigService.PortDocument document,
      LocalEnvironmentService.PortSnapshot environment,
      Map<String, String> mergedEnvironment) {
    if (!RuntimeConfigurationService.conventional(resolved))
      throw new PortSourceException(
          "Custom command arguments may override the port. Edit the port in Services for this launch configuration.");
    // A command running elsewhere can load an external application.yml relative to its cwd.
    if (!List.of("", ".", "./").contains(text(resolved, "cwd")))
      throw new PortSourceException(
          "Custom working directories can load another application configuration. Edit this port in Services.");
    if (resolved.containsKey("detectionWarning"))
      throw new PortSourceException(
          "The saved launch differs from the detected application. Resolve it in Services before editing the port here.");
    String normalizedFile = Path.of(text(resolved, "configFile")).normalize().toString();
    String module = "";
    if (text(resolved, "executable").matches("(?:\\./)?gradlew")) {
      String task = strings(resolved.get("args")).get(0);
      int separator = task.lastIndexOf(':');
      if (separator >= 0)
        module = task.substring(0, separator).replaceFirst("^:", "").replace(':', '/');
    }
    String resources = (module.isEmpty() ? "" : module + "/") + "src/main/resources/";
    if (!List.of(
            resources + "application.yml",
            resources + "application.yaml",
            resources + "config/application.yml",
            resources + "config/application.yaml")
        .contains(normalizedFile))
      throw new PortSourceException(
          "The saved YAML is outside the launched module's standard Spring configuration locations. Review this configuration in Services.");
    // Spring also searches these working-directory locations before packaged resources.
    for (String folder : List.of("", "config/", resources, resources + "config/"))
      for (String filename :
          List.of("application.yml", "application.yaml", "application.properties")) {
        Path candidate = Path.of(repository.path()).resolve(folder + filename).normalize();
        if (!candidate.equals(document.file()) && java.nio.file.Files.exists(candidate))
          throw new PortSourceException(
              "An external application configuration may override this YAML. Edit the effective port in Services.");
      }
    for (var other : workspace.snapshot().runConfigurations()) {
      if (text(saved, "id").equals(text(other, "id"))
          || !repository.id().equals(text(other, "repositoryId"))) continue;
      if (text(other, "configFile").isBlank()
          || Path.of(text(other, "configFile")).normalize().toString().equals(normalizedFile))
        throw new PortSourceException(
            "Another Services configuration may share this application.yml. Edit the shared configuration in Services.");
    }
    var protectedKeys = runtime.protectedEnvironmentKeys(saved);
    // These sources can replace the whole Spring property set or activate another profile.
    for (String key :
        List.of(
            "SPRING_APPLICATION_JSON",
            "SPRING_CONFIG_LOCATION",
            "SPRING_CONFIG_ADDITIONAL_LOCATION",
            "SPRING_CONFIG_IMPORT",
            "SPRING_CONFIG_NAME",
            "SPRING_PROFILES_ACTIVE",
            "SPRING_PROFILES_INCLUDE",
            "JAVA_TOOL_OPTIONS",
            "JDK_JAVA_OPTIONS",
            "_JAVA_OPTIONS",
            "JAVA_OPTS",
            "GRADLE_OPTS",
            "MAVEN_OPTS")) {
      if (!mergedEnvironment.getOrDefault(key, "").isBlank()
          || !System.getenv().getOrDefault(key, "").isBlank()
          || protectedKeys.contains(key))
        throw new PortSourceException(
            "Spring profile, configuration or JVM environment overrides are present. Edit this port in Services.");
    }
    var supported = new LinkedHashSet<String>(environmentKeys(document, "server.port"));
    supported.addAll(environmentKeys(document, "management.server.port"));
    for (String key : supported) {
      boolean localValue = environment.values().containsKey(key);
      boolean inlineValue = map(saved.get("env")).containsKey(key);
      if (mergedEnvironment.containsKey(key) && !localValue && !inlineValue)
        throw new PortSourceException(
            "A protected environment value controls the port. Update it in Services before editing here.");
      if (protectedKeys.contains(key) && !localValue)
        throw new PortSourceException(
            "A protected environment value controls the port. Update it in Services before editing here.");
      if (mergedEnvironment.containsKey(key)
          && RuntimeDetector.validPort(mergedEnvironment.get(key)) == null)
        throw new PortSourceException(
            "A port environment override is not a valid numeric port. Correct it in Services.");
      if (!mergedEnvironment.containsKey(key) && System.getenv().containsKey(key))
        throw new PortSourceException(
            "The inherited application environment controls this port. Edit the launch environment in Services.");
    }
    var applicationKeys = environmentKeys(document, "server.port");
    if (environmentKeys(document, "management.server.port").stream()
        .anyMatch(applicationKeys::contains))
      throw new PortSourceException(
          "Application and management ports share one environment variable. Separate them before editing here.");
  }

  private void ensureAvailable(String id, int port, Integer managementPort) {
    var snapshot = inventory.snapshot(true);
    if (!Boolean.TRUE.equals(snapshot.get("available")))
      throw new ConflictException(
          "Local listening ports could not be checked. Refresh the port details and try again.");
    for (Object item : list(snapshot.get("configurations"))) {
      var config = map(item);
      if (id.equals(text(config, "id"))) continue;
      for (String key : List.of("port", "managementPort")) {
        long other = number(config.get(key));
        if (other == port || managementPort != null && other == managementPort)
          throw new ConflictException("Port " + other + " is already assigned to another service.");
      }
    }
    for (Object item : list(snapshot.get("listeners"))) {
      var listener = map(item);
      long occupied = number(listener.get("port"));
      if ((occupied == port || managementPort != null && occupied == managementPort)
          && !id.equals(text(listener, "configurationId")))
        throw new ConflictException(
            "Port " + occupied + " is already used by another local process.");
    }
  }

  public synchronized Map<String, Object> update(String id, Map<String, Object> input) {
    Integer port = RuntimeDetector.validPort(input.get("applicationPort"));
    Integer management =
        input.containsKey("managementPort")
            ? RuntimeDetector.validPort(input.get("managementPort"))
            : null;
    if (port == null
        || !text(input, "applicationPort").matches("\\d{1,5}")
        || input.containsKey("managementPort")
            && (management == null || !text(input, "managementPort").matches("\\d{1,5}")))
      throw new IllegalArgumentException("Ports must be whole numbers between 1 and 65535.");
    // Never perform a listener scan while holding workspace or environment storage locks.
    ensureAvailable(id, port, management);
    synchronized (workspace) {
      synchronized (local) {
        State state = state(id);
        if (!Boolean.TRUE.equals(state.metadata().get("editable")))
          throw new IllegalArgumentException(text(state.metadata(), "reason"));
        if ("launch".equals(state.metadata().get("editMode")))
          return updateLaunch(id, state, input, port);
        if (!text(input, "configFile").equals(text(state.resolved(), "configFile")))
          throw new ConflictException(
              "The application configuration file changed. Refresh before saving.");
        if (!state.document().hash().equals(text(input, "expectedContentHash")))
          throw new ConflictException(
              "Application configuration changed. Refresh before saving the port.");
        Integer remainingManagement =
            management == null
                ? RuntimeDetector.validPort(state.metadata().get("managementPort"))
                : management;
        if (port.equals(remainingManagement))
          throw new IllegalArgumentException("Application and management ports must be different.");
        // Recheck saved assignments after taking the transaction lock; listener snapshots
        // inherently remain observations, not a reservation of an operating-system port.
        for (var other : workspace.snapshot().runConfigurations()) {
          if (id.equals(text(other, "id"))) continue;
          var effective = RuntimeDetector.applyEnvironmentPorts(other, map(other.get("env")));
          effective =
              RuntimeDetector.applyEnvironmentPorts(effective, local.resolve(text(other, "id")));
          for (String key : List.of("port", "managementPort"))
            if (number(other.get(key)) == port
                || management != null && number(other.get(key)) == management
                || number(effective.get(key)) == port
                || management != null && number(effective.get(key)) == management)
              throw new ConflictException(
                  "The requested port is already assigned to another service.");
        }
        String updated = application.updatedPorts(state.document(), port, management);
        var environment = new LinkedHashMap<>(state.environment().values());
        var inlineEnvironment = new LinkedHashMap<>(map(state.saved().get("env")));
        updateEnvironment(environment, inlineEnvironment, state.document(), "server.port", port);
        if (management != null)
          updateEnvironment(
              environment,
              inlineEnvironment,
              state.document(),
              "management.server.port",
              management);
        if (state.document().configurationOverrides()) {
          // Spring config data (including profiles and imports) has lower precedence than OS
          // environment values. Always own the standard key rather than guessing which file wins.
          environment.put("SERVER_PORT", Integer.toString(port));
          if (management != null)
            environment.put("MANAGEMENT_SERVER_PORT", Integer.toString(management));
        }
        boolean environmentChanged = !environment.equals(state.environment().values());
        boolean changed =
            !updated.equals(state.document().source())
                || environmentChanged
                || !inlineEnvironment.equals(map(state.saved().get("env")))
                || number(state.saved().get("port")) != port
                || management != null && number(state.saved().get("managementPort")) != management;
        String environmentWritten = null;
        boolean fileWritten = false, workspaceAttempted = false;
        try {
          if (!updated.equals(state.document().source())) {
            application.writePorts(state.document(), text(input, "expectedContentHash"), updated);
            fileWritten = true;
          }
          if (environmentChanged)
            environmentWritten = local.replacePortValues(id, state.environment(), environment);
          var changes =
              object(
                  "port",
                  port,
                  "configFile",
                  text(state.resolved(), "configFile"),
                  "env",
                  inlineEnvironment);
          if (environmentChanged) {
            var keys = new LinkedHashSet<>(strings(state.saved().get("environmentKeys")));
            keys.addAll(environment.keySet());
            changes.put("environmentKeys", keys.stream().sorted().toList());
            changes.put("environmentFile", ".argus-data/environments/" + id + ".env");
            changes.put(
                "environmentFormat", state.saved().getOrDefault("environmentFormat", "dotenv"));
            changes.put("environmentUpdatedAt", java.time.Instant.now().toString());
          }
          if (management != null) changes.put("managementPort", management);
          if (!ApplicationConfigService.contentHash(RuntimeData.read(state.document().file()))
              .equals(ApplicationConfigService.contentHash(updated)))
            throw new ConflictException(
                "Application YAML changed while saving the port. Refresh before retrying.");
          if (changed) {
            workspaceAttempted = true;
            workspace.updateRunConfiguration(id, changes);
          }
        } catch (RuntimeException failure) {
          var rollbackErrors = new ArrayList<RuntimeException>();
          if (workspaceAttempted)
            try {
              // updateRunConfiguration merges fields before persisting. Restore the exact
              // map first, including absence of optional keys in legacy configurations.
              var current = workspace.runConfiguration(id);
              current.clear();
              current.putAll(copyMap(state.saved()));
              workspace.updateRunConfiguration(id, state.saved());
            } catch (RuntimeException error) {
              rollbackErrors.add(error);
            }
          if (environmentWritten != null)
            try {
              local.restorePortValues(id, environmentWritten, state.environment());
            } catch (RuntimeException error) {
              rollbackErrors.add(error);
            }
          if (fileWritten)
            try {
              application.restorePorts(state.document(), updated);
            } catch (RuntimeException error) {
              rollbackErrors.add(error);
            }
          if (!rollbackErrors.isEmpty())
            throw new IllegalStateException(
                "The port update failed and rollback could not safely complete. Check application.yml and the Services configuration before running.");
          throw failure;
        }
        return object(
            "configurationId",
            id,
            "repositoryId",
            state.repository().id(),
            "applicationPort",
            port,
            "managementPort",
            remainingManagement,
            "configFile",
            text(state.resolved(), "configFile"),
            "contentHash",
            ApplicationConfigService.contentHash(updated),
            "changed",
            changed,
            "restartRequired",
            changed && Boolean.TRUE.equals(state.metadata().get("running")),
            "running",
            state.metadata().get("running"),
            "environmentUpdated",
            environmentChanged);
      }
    }
  }

  private static void updateEnvironment(
      Map<String, String> environment,
      Map<String, Object> inline,
      ApplicationConfigService.PortDocument document,
      String property,
      int port) {
    for (String key : environmentKeys(document, property)) {
      if (environment.containsKey(key)) environment.put(key, Integer.toString(port));
      if (inline.containsKey(key)) inline.put(key, Integer.toString(port));
    }
  }
}
