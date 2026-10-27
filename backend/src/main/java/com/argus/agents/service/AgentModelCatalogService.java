package com.argus.agents.service;

import com.argus.agents.domain.CliProviderAdapter;
import com.argus.agents.dto.AgentModel;
import com.argus.agents.dto.AgentProvider;
import com.argus.agents.repository.CliProviderAdapterRepository;
import com.argus.common.error.NotFoundException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
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

/** Reads model metadata only; catalogue discovery never invokes a model completion. */
@Service
public class AgentModelCatalogService {
  private final CliProviderAdapterRepository adapters;
  private final ObjectMapper json;
  private final Map<String, String> environment;
  private final java.util.function.LongSupplier clock;
  private final Map<String, CachedCatalog> catalogs = new ConcurrentHashMap<>();
  private final Map<String, java.util.concurrent.locks.ReentrantLock> locks =
      new ConcurrentHashMap<>();

  @Autowired
  public AgentModelCatalogService(CliProviderAdapterRepository adapters, ObjectMapper json) {
    this(adapters, json, System.getenv());
  }

  AgentModelCatalogService(
      CliProviderAdapterRepository adapters, ObjectMapper json, Map<String, String> environment) {
    this(adapters, json, environment, System::nanoTime);
  }

  AgentModelCatalogService(
      CliProviderAdapterRepository adapters,
      ObjectMapper json,
      Map<String, String> environment,
      java.util.function.LongSupplier clock) {
    this.adapters = adapters;
    this.json = json;
    this.environment = Map.copyOf(environment);
    this.clock = clock;
  }

  public AgentProvider enrich(AgentProvider provider, boolean refresh) {
    Catalog catalog = load(provider, refresh);
    List<AgentModel> models = catalog.models();
    AgentModel preferredModel =
        models.stream()
            .filter(AgentModel::isDefault)
            .findFirst()
            .orElseGet(() -> models.isEmpty() ? null : models.get(0));
    String defaultModel = preferredModel == null ? "" : preferredModel.id();
    return new AgentProvider(
        provider.id(),
        provider.name(),
        provider.installed(),
        provider.version(),
        provider.executablePath(),
        provider.authenticated(),
        provider.authMethod(),
        provider.availability(),
        provider.canRun(),
        provider.accountIdentityAvailable(),
        provider.usageInformationAvailable(),
        provider.type(),
        models.stream().map(AgentModel::id).toList(),
        defaultModel,
        provider.local(),
        provider.toolCapable(),
        models.stream().anyMatch(model -> !model.supportedReasoningEfforts().isEmpty()),
        provider.supportsFastMode(),
        provider.contextCapabilities(),
        models,
        catalog.source());
  }

  private Catalog load(AgentProvider provider, boolean refresh) {
    try {
      JsonNode payload = json.valueToTree(discover(provider.id(), refresh));
      if (!payload.path("models").isArray()) return fallback(provider);
      List<AgentModel> models = new ArrayList<>();
      LinkedHashSet<String> modelIds = new LinkedHashSet<>();
      for (JsonNode value : payload.path("models")) {
        String id = value.path("id").asText("").trim();
        if (id.isBlank() || !modelIds.add(id)) continue;
        List<AgentModel.ReasoningEffort> efforts = new ArrayList<>();
        LinkedHashSet<String> effortIds = new LinkedHashSet<>();
        if (value.path("supportedReasoningEfforts").isArray()) {
          for (JsonNode effort : value.path("supportedReasoningEfforts")) {
            String effortId = effort.path("effort").asText("").trim();
            if (!effortId.isBlank() && effortIds.add(effortId)) {
              efforts.add(
                  new AgentModel.ReasoningEffort(effortId, effort.path("description").asText("")));
            }
          }
        }
        String defaultEffort = value.path("defaultReasoningEffort").asText("");
        if (!effortIds.contains(defaultEffort)) defaultEffort = "";
        models.add(
            new AgentModel(
                id,
                value.path("displayName").asText(id),
                value.path("description").asText(""),
                List.copyOf(efforts),
                defaultEffort,
                value.path("isDefault").asBoolean(false),
                value.path("supportsFastMode").isBoolean()
                    ? value.path("supportsFastMode").asBoolean()
                    : null,
                value.path("resolvedModel").asText("")));
      }
      return new Catalog(List.copyOf(models), payload.path("source").asText("unavailable"));
    } catch (java.util.concurrent.CancellationException error) {
      throw error;
    } catch (Exception error) {
      CliMetadataSession.checkCancellation();
      return fallback(provider);
    }
  }

  public Map<String, Object> discover(String providerId, boolean refresh) {
    CliMetadataSession.checkCancellation();
    CliProviderAdapter adapter =
        adapters.list().stream()
            .filter(value -> value.id().equals(providerId))
            .findFirst()
            .orElseThrow(() -> new NotFoundException("CLI provider not found"));
    String key =
        adapter.id()
            + ":"
            + adapter.executable()
            + ":"
            + environment.getOrDefault("CODEX_HOME", "");
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
      CachedCatalog previous = catalogs.get(key);
      if (!refresh
          && previous != null
          && clock.getAsLong() - previous.at() < Duration.ofSeconds(60).toNanos())
        return copy(previous.value());
      Map<String, Object> value;
      try {
        if ("codex".equals(adapter.id()))
          value = result(codexModels(adapter.executable()), "codex-app-server");
        else if ("claude".equals(adapter.id()))
          value = result(claudeModels(adapter.executable()), "claude-initialize");
        else
          value =
              result(
                  (adapter.models() == null ? List.<String>of() : adapter.models())
                      .stream()
                          .filter(id -> id != null && !id.isBlank())
                          .distinct()
                          .map(
                              id -> {
                                Map<String, Object> model = new LinkedHashMap<>();
                                model.put("id", id);
                                model.put("displayName", id);
                                model.put("description", "");
                                model.put("supportedReasoningEfforts", List.of());
                                model.put("defaultReasoningEffort", "auto");
                                model.put("isDefault", id.equals(adapter.defaultModel()));
                                return model;
                              })
                          .toList(),
                  "cli-adapter");
      } catch (java.util.concurrent.CancellationException error) {
        throw error;
      } catch (Exception error) {
        CliMetadataSession.checkCancellation();
        // Retain the last successful CLI response before falling back to its on-disk
        // cache. A transient failure must not erase newer, already discovered models.
        // An authoritative empty response still replaces the cache above.
        if (previous != null
            && previous.value().get("models") instanceof List<?> models
            && !models.isEmpty())
          value = Map.of("models", models, "source", adapter.id() + "-cache");
        else if ("codex".equals(adapter.id())) value = codexCache();
        else value = result(List.of(), "unavailable");
      }
      CliMetadataSession.checkCancellation();
      catalogs.put(key, new CachedCatalog(clock.getAsLong(), value));
      return copy(value);
    } finally {
      lock.unlock();
    }
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> copy(Map<String, Object> value) {
    return json.convertValue(value, Map.class);
  }

  private List<Map<String, Object>> codexModels(String executable) throws java.io.IOException {
    try (CliMetadataSession session =
        new CliMetadataSession(
            executable, List.of("app-server"), null, environment, json, Duration.ofSeconds(8))) {
      session.initializeCodex("argus_model_catalog");
      List<JsonNode> items = new ArrayList<>();
      LinkedHashSet<String> cursors = new LinkedHashSet<>();
      String cursor = "";
      for (int page = 0; page < 20; page++) {
        Map<String, Object> params =
            new LinkedHashMap<>(Map.of("limit", 100, "includeHidden", false));
        if (!cursor.isEmpty()) params.put("cursor", cursor);
        JsonNode response = session.codex("model/list", params);
        if (!response.path("data").isArray())
          throw new IllegalStateException("Invalid model catalogue");
        response.path("data").forEach(items::add);
        cursor = response.path("nextCursor").asText("");
        if (cursor.length() > 256)
          throw new IllegalStateException("Invalid model catalogue cursor");
        if (cursor.isBlank()) return normalizeCodex(items, false);
        if (!cursors.add(cursor)) break;
      }
      throw new IllegalStateException("Model catalogue pagination did not complete");
    }
  }

  private Map<String, Object> codexCache() {
    try {
      Path directory =
          Path.of(
              environment.getOrDefault(
                  "CODEX_HOME", Path.of(System.getProperty("user.home"), ".codex").toString()));
      Path file = directory.resolve("models_cache.json");
      if (Files.size(file) > 8 * 1024 * 1024) return result(List.of(), "unavailable");
      JsonNode models = json.readTree(Files.readString(file)).path("models");
      List<JsonNode> items = new ArrayList<>();
      if (models.isArray()) models.forEach(items::add);
      List<Map<String, Object>> normalized = normalizeCodex(items, true);
      return result(normalized, normalized.isEmpty() ? "unavailable" : "codex-cache");
    } catch (Exception ignored) {
      return result(List.of(), "unavailable");
    }
  }

  static List<Map<String, Object>> normalizeCodex(List<JsonNode> items, boolean cache) {
    LinkedHashSet<String> seen = new LinkedHashSet<>();
    return items.stream()
        .filter(
            item ->
                item.isObject()
                    && !item.path("hidden").asBoolean(false)
                    && (!cache || "list".equals(item.path("visibility").asText())))
        .sorted(
            cache ? Comparator.comparingInt(item -> item.path("priority").asInt(999)) : (a, b) -> 0)
        .filter(
            item -> {
              String id = first(item, "model", "slug", "id");
              return !id.isBlank() && seen.add(id);
            })
        .map(
            item -> {
              String id = first(item, "model", "slug", "id");
              Map<String, Map<String, String>> efforts = new LinkedHashMap<>();
              JsonNode levels =
                  item.has("supportedReasoningEfforts")
                      ? item.path("supportedReasoningEfforts")
                      : item.path("supported_reasoning_levels");
              if (levels.isArray())
                for (JsonNode level : levels) {
                  String effort = first(level, "reasoningEffort", "effort");
                  if (!effort.isBlank())
                    efforts.put(
                        effort,
                        Map.of(
                            "effort", effort, "description", level.path("description").asText("")));
                }
              String preferred = first(item, "defaultReasoningEffort", "default_reasoning_level");
              Map<String, Object> model = new LinkedHashMap<>();
              model.put("id", id);
              String display = first(item, "displayName", "display_name");
              model.put("displayName", display.isBlank() ? id : display);
              model.put("description", item.path("description").asText(""));
              model.put("supportedReasoningEfforts", List.copyOf(efforts.values()));
              model.put(
                  "defaultReasoningEffort",
                  efforts.containsKey(preferred)
                      ? preferred
                      : efforts.keySet().stream().findFirst().orElse("auto"));
              model.put("isDefault", item.path("isDefault").asBoolean(false));
              model.put("supportsFastMode", codexFastMode(item));
              return model;
            })
        .toList();
  }

  private static boolean codexFastMode(JsonNode item) {
    if (item.path("supportsFastMode").isBoolean()) return item.path("supportsFastMode").asBoolean();
    // Metadata differs between app-server and the native cache. Do not infer a tier from
    // the model name or its default: only explicitly advertised Fast/priority is selectable.
    for (String field : List.of("additionalSpeedTiers", "additional_speed_tiers"))
      if (item.path(field).isArray())
        for (JsonNode tier : item.path(field))
          if (Set.of("fast", "priority").contains(tier.asText(""))) return true;
    for (String field : List.of("serviceTiers", "service_tiers"))
      if (item.path(field).isArray())
        for (JsonNode tier : item.path(field))
          if (Set.of("fast", "priority").contains(tier.path("id").asText(""))) return true;
    return false;
  }

  private List<Map<String, Object>> claudeModels(String executable) throws java.io.IOException {
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
                "--safe-mode",
                "--strict-mcp-config",
                "--tools",
                ""),
            Path.of(System.getProperty("java.io.tmpdir")),
            environment,
            json,
            Duration.ofSeconds(8))) {
      JsonNode models = session.claude("initialize").path("models");
      if (!models.isArray()) throw new IllegalStateException("Invalid model catalogue");
      return normalizeClaude(models);
    }
  }

  static List<Map<String, Object>> normalizeClaude(JsonNode items) {
    List<Map<String, Object>> models = new ArrayList<>();
    LinkedHashSet<String> seen = new LinkedHashSet<>();
    String configured = "";
    for (JsonNode item : items)
      if (!item.path("hidden").asBoolean(false) && "default".equals(item.path("value").asText()))
        configured = item.path("resolvedModel").asText("");
    boolean assignedDefault = false;
    for (JsonNode item : items) {
      String id = item.path("value").asText("").trim();
      if (id.isBlank()
          || "default".equals(id)
          || item.path("hidden").asBoolean(false)
          || !seen.add(id)) continue;
      LinkedHashSet<String> levels = new LinkedHashSet<>();
      if (item.path("supportedEffortLevels").isArray())
        for (JsonNode level : item.path("supportedEffortLevels"))
          if (level.isString()
              && !level.asText().isBlank()
              && !"auto".equals(level.asText().trim())) levels.add(level.asText().trim());
      List<Map<String, String>> efforts = new ArrayList<>();
      if (!levels.isEmpty())
        efforts.add(Map.of("effort", "auto", "description", "Use CLI configured reasoning"));
      levels.forEach(effort -> efforts.add(Map.of("effort", effort, "description", "")));
      String resolved = item.path("resolvedModel").asText("");
      boolean preferred = !assignedDefault && !configured.isBlank() && configured.equals(resolved);
      assignedDefault |= preferred;
      Map<String, Object> model = new LinkedHashMap<>();
      model.put("id", id);
      model.put("displayName", item.path("displayName").asText(id));
      model.put("description", item.path("description").asText(""));
      model.put("supportedReasoningEfforts", List.copyOf(efforts));
      String effort = item.path("defaultReasoningEffort").asText("");
      model.put("defaultReasoningEffort", levels.contains(effort) ? effort : "auto");
      model.put("isDefault", preferred);
      model.put("supportsFastMode", item.path("supportsFastMode").asBoolean(false));
      model.put("resolvedModel", resolved.isBlank() ? id : resolved);
      models.add(model);
    }
    return List.copyOf(models);
  }

  private static String first(JsonNode item, String... keys) {
    for (String key : keys) {
      String value = item.path(key).asText("").trim();
      if (!value.isBlank()) return value;
    }
    return "";
  }

  private static Map<String, Object> result(List<Map<String, Object>> models, String source) {
    return Map.of("models", List.copyOf(models), "source", source);
  }

  private record CachedCatalog(long at, Map<String, Object> value) {}

  private Catalog fallback(AgentProvider provider) {
    // Bundled lists cannot describe a built-in CLI's signed-in account catalogue.
    if ("codex".equals(provider.id()) || "claude".equals(provider.id()))
      return new Catalog(List.of(), "unavailable");
    List<AgentModel> models =
        provider.models().stream()
            .filter(id -> id != null && !id.isBlank())
            .distinct()
            .map(
                id ->
                    new AgentModel(
                        id, id, "", List.of(), "", id.equals(provider.defaultModel()), null))
            .toList();
    return new Catalog(models, models.isEmpty() ? "unavailable" : "adapter");
  }

  private record Catalog(List<AgentModel> models, String source) {}
}
