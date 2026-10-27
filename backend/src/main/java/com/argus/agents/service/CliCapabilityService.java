package com.argus.agents.service;

import com.argus.agents.domain.CliProviderAdapter;
import com.argus.agents.repository.CliProviderAdapterRepository;
import com.argus.common.error.NotFoundException;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Discovers actual CLI-managed integrations, without executing tools or disclosing configuration.
 */
@Service
public class CliCapabilityService {
  private static final String ACCESS_LIMITATION =
      "Integration availability does not verify permission to a particular link. The CLI must use its tools and report any access or approval requirement.";
  private final CliProviderAdapterRepository adapters;
  private final ObjectMapper json;
  private final Map<String, String> environment;
  private final Map<String, Cached> cache = new ConcurrentHashMap<>();
  private final Map<String, java.util.concurrent.locks.ReentrantLock> locks =
      new ConcurrentHashMap<>();

  @Autowired
  public CliCapabilityService(CliProviderAdapterRepository adapters, ObjectMapper json) {
    this(adapters, json, System.getenv());
  }

  CliCapabilityService(
      CliProviderAdapterRepository adapters, ObjectMapper json, Map<String, String> environment) {
    this.adapters = adapters;
    this.json = json;
    this.environment = Map.copyOf(environment);
  }

  public Map<String, Object> discover(String providerId, Path workingDirectory, boolean refresh) {
    CliMetadataSession.checkCancellation();
    CliProviderAdapter adapter =
        adapters.list().stream()
            .filter(item -> item.id().equals(providerId))
            .findFirst()
            .orElseThrow(() -> new NotFoundException("CLI provider not found"));
    Path cwd =
        (workingDirectory == null ? Path.of(System.getProperty("user.home")) : workingDirectory)
            .toAbsolutePath()
            .normalize();
    // Environment is immutable for this service instance. The key never exports environment values.
    String key = adapter.id() + ":" + adapter.executable() + ":" + cwd;
    var lock =
        locks.computeIfAbsent(key, ignored -> new java.util.concurrent.locks.ReentrantLock());
    try {
      lock.lockInterruptibly();
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new java.util.concurrent.CancellationException("CLI metadata discovery interrupted");
    }
    try {
      CliMetadataSession.checkCancellation();
      Cached previous = cache.get(key);
      if (!refresh
          && previous != null
          && System.nanoTime() - previous.at < Duration.ofSeconds(60).toNanos())
        return copy(previous.value);
      Map<String, Object> value;
      try {
        value =
            "codex".equals(adapter.id())
                ? codex(adapter.executable(), cwd)
                : "claude".equals(adapter.id())
                    ? claude(adapter.executable(), cwd)
                    : unavailable(adapter.id());
      } catch (java.util.concurrent.CancellationException error) {
        throw error;
      } catch (Exception ignored) {
        CliMetadataSession.checkCancellation();
        value = unavailable(adapter.id());
      }
      CliMetadataSession.checkCancellation();
      cache.put(key, new Cached(System.nanoTime(), value));
      return copy(value);
    } finally {
      lock.unlock();
    }
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> copy(Map<String, Object> value) {
    return json.convertValue(value, Map.class);
  }

  private Map<String, Object> codex(String executable, Path cwd) throws java.io.IOException {
    try (CliMetadataSession session =
        new CliMetadataSession(
            executable, List.of("app-server"), cwd, environment, json, Duration.ofSeconds(12))) {
      session.initializeCodex("argus_integration_capabilities");
      List<JsonNode> servers = new ArrayList<>();
      List<JsonNode> apps = new ArrayList<>();
      List<String> limitations = new ArrayList<>();
      boolean mcpChecked = false;
      boolean appsChecked = false;
      try {
        String cursor = "";
        Set<String> cursors = new LinkedHashSet<>();
        for (int page = 0; page < 10; page++) {
          Map<String, Object> params =
              new LinkedHashMap<>(Map.of("detail", "toolsAndAuthOnly", "limit", 100));
          if (!cursor.isBlank()) params.put("cursor", cursor);
          JsonNode response = session.codex("mcpServerStatus/list", params);
          if (!response.path("data").isArray()) throw new IllegalStateException("Invalid metadata");
          response.path("data").forEach(servers::add);
          cursor = response.path("nextCursor").asText("");
          if (cursor.length() > 256) throw new IllegalStateException("Invalid metadata cursor");
          if (cursor.isBlank()) {
            mcpChecked = true;
            break;
          }
          if (!cursors.add(cursor)) break;
        }
        if (!mcpChecked) limitations.add("The CLI tool inventory was incomplete.");
      } catch (java.util.concurrent.CancellationException error) {
        throw error;
      } catch (RuntimeException ignored) {
        CliMetadataSession.checkCancellation();
        limitations.add(
            "The CLI could not verify its MCP tool inventory. Recheck the CLI's MCP connections.");
      }
      try {
        JsonNode response = session.codex("app/installed", Map.of("forceRefresh", true));
        if (!response.path("apps").isArray()) throw new IllegalStateException("Invalid metadata");
        response.path("apps").forEach(apps::add);
        appsChecked = true;
      } catch (java.util.concurrent.CancellationException error) {
        throw error;
      } catch (RuntimeException ignored) {
        CliMetadataSession.checkCancellation();
        limitations.add(
            "The CLI could not verify its installed connector runtime. Recheck the CLI's app connections.");
      }
      if (!mcpChecked && !appsChecked) return unavailable("codex");
      return normalizeCodex(servers, apps, mcpChecked, appsChecked, limitations);
    }
  }

  private Map<String, Object> claude(String executable, Path cwd) throws java.io.IOException {
    try (CliMetadataSession session =
        new CliMetadataSession(
            executable,
            List.of(
                "--print",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--no-session-persistence",
                "--permission-mode",
                "plan",
                "--settings",
                "{\"disableAllHooks\":true}"),
            cwd,
            environment,
            json,
            Duration.ofSeconds(12))) {
      session.claude("initialize");
      JsonNode response = session.claude("mcp_status").path("mcpServers");
      if (!response.isArray()) throw new IllegalStateException("Invalid integration metadata");
      List<JsonNode> servers = new ArrayList<>();
      response.forEach(servers::add);
      return normalizeClaude(servers);
    }
  }

  static Map<String, Object> normalizeCodex(
      List<JsonNode> servers,
      List<JsonNode> apps,
      boolean mcpChecked,
      boolean appsChecked,
      List<String> limitations) {
    List<Map<String, Object>> integrations = new ArrayList<>();
    for (JsonNode server : servers) {
      String name = identifier(server.path("name").asText(""));
      if (name.isBlank()) continue;
      List<Map<String, Object>> tools = toolMetadata(server.path("tools"));
      String authentication = server.path("authStatus").asText("unknown");
      if (!Set.of("unknown", "unsupported", "notLoggedIn", "bearerToken", "oAuth")
          .contains(authentication)) authentication = "unknown";
      integrations.add(
          Map.of(
              "id",
              "mcp:" + name,
              "name",
              name,
              "kind",
              "mcp",
              "authentication",
              authentication,
              "status",
              "notLoggedIn".equals(authentication)
                  ? "needs-auth"
                  : tools.isEmpty() ? "unknown" : "available",
              "tools",
              tools));
    }
    for (JsonNode app : apps) {
      String id = identifier(app.path("id").asText(""));
      if (id.isBlank()) continue;
      String name = identifier(app.path("runtimeName").asText(""));
      integrations.add(
          Map.of(
              "id",
              "app:" + id,
              "name",
              name.isBlank() ? id : name,
              "kind",
              "app",
              "authentication",
              "cli-managed",
              "status",
              app.path("enabled").isBoolean() && !app.path("enabled").asBoolean()
                  ? "disabled"
                  : app.path("enabled").asBoolean(false) && app.path("callable").asBoolean(false)
                      ? "available"
                      : "unavailable",
              "tools",
              List.of()));
    }
    return response(
        "codex",
        "codex-app-server",
        mcpChecked && appsChecked ? "checked" : "partial",
        integrations,
        limitations);
  }

  static Map<String, Object> normalizeClaude(List<JsonNode> servers) {
    List<Map<String, Object>> integrations = new ArrayList<>();
    for (JsonNode server : servers) {
      String name = identifier(server.path("name").asText(""));
      if (name.isBlank()) continue;
      List<Map<String, Object>> tools = toolMetadata(server.path("tools"));
      String status =
          switch (server.path("status").asText("")) {
            case "connected" -> tools.isEmpty() ? "unknown" : "available";
            case "needs-auth" -> "needs-auth";
            case "disabled" -> "disabled";
            case "failed" -> "unavailable";
            default -> "unknown";
          };
      integrations.add(
          Map.of(
              "id",
              "mcp:" + name,
              "name",
              name,
              "kind",
              "mcp",
              "authentication",
              "cli-managed",
              "status",
              status,
              "tools",
              tools));
    }
    return response(
        "claude",
        "claude-control",
        "checked",
        integrations,
        List.of(
            "This check covers configured MCP integrations, not built-in web tools. Project hooks are disabled for this metadata check."));
  }

  private static Map<String, Object> response(
      String provider,
      String source,
      String status,
      List<Map<String, Object>> integrations,
      List<String> limitations) {
    List<String> warnings = new ArrayList<>(limitations);
    warnings.add(ACCESS_LIMITATION);
    return Map.of(
        "provider",
        provider,
        "source",
        source,
        "status",
        status,
        "checkedAt",
        Instant.now().toString(),
        "integrations",
        List.copyOf(integrations),
        "limitations",
        List.copyOf(warnings));
  }

  private static Map<String, Object> unavailable(String provider) {
    Map<String, Object> response = new LinkedHashMap<>();
    response.put("provider", identifier(provider).isBlank() ? "unknown" : provider);
    response.put("source", "unavailable");
    response.put("status", "unavailable");
    response.put("checkedAt", null);
    response.put("integrations", List.of());
    response.put(
        "limitations",
        List.of(
            "The CLI integration check is unavailable. Check the CLI's connection settings and try again.",
            ACCESS_LIMITATION));
    return java.util.Collections.unmodifiableMap(response);
  }

  private static String identifier(String value) {
    return value.matches("[\\w .:@+\\-]{1,180}") ? value : "";
  }

  private static List<Map<String, Object>> toolMetadata(JsonNode items) {
    Map<String, Map<String, Object>> tools = new LinkedHashMap<>();
    Map<String, JsonNode> entries = new LinkedHashMap<>();
    if (items.isArray()) items.forEach(item -> entries.put(item.path("name").asText(""), item));
    else if (items.isObject())
      items.properties().forEach(entry -> entries.put(entry.getKey(), entry.getValue()));
    entries.forEach(
        (key, item) -> {
          String name = identifier(key);
          if (name.isBlank()
              && key.length() <= 180
              && key.matches("[\\w.@+\\-]+(?:/[\\w.@+\\-]+)+")
              && !List.of(key.split("/")).contains("..")) name = key;
          if (name.isBlank()) return;
          JsonNode readOnly = item.path("annotations").path("readOnlyHint");
          Map<String, Object> metadata = new LinkedHashMap<>();
          metadata.put("name", name);
          metadata.put("readOnly", readOnly.isBoolean() ? readOnly.asBoolean() : null);
          tools.put(name, metadata);
        });
    return tools.values().stream()
        .sorted(Comparator.comparing(item -> (String) item.get("name")))
        .toList();
  }

  private record Cached(long at, Map<String, Object> value) {}
}
