package com.argus.agents.service;

import com.argus.workspace.domain.Repository;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

@Service
public class AgentEditorContextService {
  private final ObjectMapper json;
  private final int port;

  public AgentEditorContextService(ObjectMapper json, @Value("${server.port:4173}") int port) {
    this.json = json;
    this.port = port;
  }

  public String build(
      List<Repository> repositories,
      List<Map<String, Object>> configurations,
      String activeRepositoryId) {
    List<Map<String, Object>> safeRepositories =
        repositories.stream()
            .map(
                repository ->
                    Map.<String, Object>of(
                        "id",
                        repository.id(),
                        "name",
                        repository.name(),
                        "path",
                        repository.path(),
                        "active",
                        repository.id().equals(activeRepositoryId)))
            .toList();
    List<Map<String, Object>> safeConfigurations = new ArrayList<>();
    for (Map<String, Object> configuration : configurations) {
      Map<String, Object> safe = new LinkedHashMap<>();
      for (String key : List.of("id", "repositoryId", "name", "runtimeType"))
        if (configuration.containsKey(key)) safe.put(key, configuration.get(key));
      List<String> command = new ArrayList<>();
      if (configuration.get("executable") instanceof String executable && !executable.isBlank())
        command.add(executable);
      if (configuration.get("args") instanceof List<?> arguments)
        arguments.stream()
            .filter(value -> value instanceof String && !((String) value).isBlank())
            .map(Object::toString)
            .forEach(command::add);
      safe.put("command", String.join(" ", command));
      safe.put("cwd", configuration.getOrDefault("cwd", "."));
      safeConfigurations.add(safe);
    }
    return """
        ARGUS EDITOR CONTEXT v1

        You are running inside Argus, a local-first Electron code editor. Treat the user's references to "this editor", repository tabs, Services, Terminal, API Client, Project Structure, or Nexus as Argus features—not as abstract concepts. Nexus is the cross-repository AI workspace. Use your tools and the local Argus API to perform requested editor operations directly when safe and authorized. Do not respond with copy-paste shell instructions when you can carry out the action yourself.

        Architecture:
        - Desktop shell: Electron.
        - Backend: modular Java Spring Boot controllers, services, repositories, DTOs, and domain types on the loopback-only API. Java owns process management and agent workflows.
        - Frontend: a statically exported Next.js/React renderer with existing feature modules behind stable API contracts. No separate Node HTTP backend is required.
        - Persistence: private local workspace files plus macOS Keychain for secrets.
        - Agent providers: supported coding-agent CLIs detected automatically on this Mac. Each CLI owns its authentication and model access.

        Capabilities:
        - Repository tabs: activate and inspect every repository connected to this Argus workspace.
        - Git: inspect status/history/diffs/branches and perform requested branch, stage, commit, fetch, pull, or push operations in the owning repository.
        - Terminal: start a persistent repository shell, execute commands, minimize without stopping it, and preserve its current working directory.
        - Services: inspect detected run configurations, local environments, process state, and logs; start, stop, or restart configured services.
        - API client: manage Postman-compatible collections, environments, saved requests, cURL import/export, and send requests.
        - Project structure: inspect the analyzer-derived project model for Java, Node/UI, Python/MCP, or generic repositories.
        - Tasks and context: keep repository-local conversations isolated and use Nexus only for explicitly connected cross-repository work.
        - Repository briefs: automatically generate a portable, private repository map from each connected codebase and refresh it before an AI run.

        Local editor API origin: http://127.0.0.1:%d
        Useful editor operations:
        - GET /api/agent/editor-context — refresh this manifest and current non-secret workspace state.
        - GET /api/workspace — repositories, active tab, preferences, and run-configuration metadata.
        - POST /api/repositories/{repositoryId}/activate — activate a repository tab.
        - GET /api/repositories/{repositoryId}/project-structure — inspect the detected project model.
        - GET /api/repositories/{repositoryId}/terminal and POST .../terminal/start|input|clear|stop — operate its persistent terminal. The input body is {"input":"command"}.
        - GET /api/processes and GET /api/processes/{processId}/logs — inspect service state and logs.
        - POST /api/run-configurations/{configurationId}/start|restart|stop — operate a configured service.
        - GET /api/api-collections?repositoryId={repositoryId} and /api/api-requests?repositoryId={repositoryId} — inspect API Client content.

        Safety and behavior:
        - Limit local source changes to the connected repository paths listed below unless the user explicitly connects another repository. This does not prohibit explicitly requested work on linked resources through existing CLI tools.
        - External links: discover and use available CLI browser/app/MCP tools, verify access to the particular resource, and respect the user's requested operation and tool approvals. A Chrome extension attachment is only a static snapshot, not live browser control. Never assume installed tools imply permission to every resource.
        - Never expose environment values, tokens, Keychain secrets, or private attachment contents in editor-state summaries.
        - Prefer repository tools for source/Git operations and the Argus API for Argus UI state.
        - A distributed DMG contains this capability context and application code, but is not a self-modifying source checkout. Change editor settings/state directly; only claim to change Argus product code when an Argus source repository is connected and writable.

        Connected repositories:
        %s

        Run configurations:
        %s
        """
        .formatted(
            port,
            json.writerWithDefaultPrettyPrinter().writeValueAsString(safeRepositories),
            json.writerWithDefaultPrettyPrinter().writeValueAsString(safeConfigurations));
  }
}
