package com.argus.apiclient.service;

import com.argus.apiclient.domain.ApiEnvironment;
import com.argus.apiclient.dto.EditableApiEnvironment;
import com.argus.apiclient.dto.SaveApiEnvironmentRequest;
import com.argus.apiclient.repository.ApiEnvironmentRepository;
import com.argus.common.error.NotFoundException;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;

@Service
public class ApiEnvironmentService {
  private final ApiEnvironmentRepository environments;

  public ApiEnvironmentService(ApiEnvironmentRepository environments) {
    this.environments = environments;
  }

  public List<ApiEnvironment> list() {
    return environments.list();
  }

  public ApiEnvironment require(String id) {
    return environments.list().stream()
        .filter(item -> item.id().equals(id))
        .findFirst()
        .orElseThrow(() -> new NotFoundException("API environment not found"));
  }

  public synchronized ApiEnvironment save(SaveApiEnvironmentRequest request) {
    String name = request.name() == null ? "" : request.name().trim();
    if (name.isBlank()) throw new IllegalArgumentException("Environment name is required");
    ApiEnvironment existing =
        request.id() == null
            ? null
            : environments.list().stream()
                .filter(item -> item.id().equals(request.id()))
                .findFirst()
                .orElse(null);
    String id = existing == null ? UUID.randomUUID().toString() : existing.id();
    if (environments.list().stream()
        .anyMatch(item -> !item.id().equals(id) && item.name().equalsIgnoreCase(name)))
      throw new IllegalArgumentException("An environment named “" + name + "” already exists");
    Map<String, String> values =
        request.valuesText() != null ? parse(request.valuesText()) : normalize(request.values());
    String now = Instant.now().toString();
    ApiEnvironment environment =
        new ApiEnvironment(id, name, values, existing == null ? now : existing.createdAt(), now);
    environments.save(environment);
    return environment;
  }

  public EditableApiEnvironment editable(String id) {
    ApiEnvironment item = require(id);
    return new EditableApiEnvironment(
        item.id(),
        item.name(),
        item.values(),
        item.createdAt(),
        item.updatedAt(),
        serialize(item.values()));
  }

  public Map<String, Object> delete(String id) {
    ApiEnvironment item = require(id);
    environments.delete(id);
    return Map.of("ok", true, "name", item.name());
  }

  public ApiEnvironment importDocument(Object parsed) {
    var document = ApiCollectionService.object(parsed);
    String name;
    Map<String, Object> values;
    if ("environment".equals(document.get("_postman_variable_scope"))
        && document.get("values") instanceof List<?>) {
      name = ApiCollectionService.text(document.get("name"));
      values = new LinkedHashMap<>();
      for (var entry : ApiCollectionService.rows(document.get("values")))
        if (!ApiCollectionService.text(entry.get("key")).isEmpty()
            && !Boolean.FALSE.equals(entry.get("enabled")))
          values.put(
              ApiCollectionService.text(entry.get("key")),
              ApiCollectionService.text(entry.get("value")));
    } else if ("argus-api-environments".equals(document.get("format"))
        && ApiCollectionService.rows(document.get("environments")).size() == 1) {
      var entry = ApiCollectionService.rows(document.get("environments")).get(0);
      name = ApiCollectionService.text(entry.get("name"));
      values = ApiCollectionService.object(entry.get("values"));
    } else if (!ApiCollectionService.text(document.get("name")).isEmpty()
        && document.get("values") instanceof Map<?, ?>) {
      name = ApiCollectionService.text(document.get("name"));
      values = ApiCollectionService.object(document.get("values"));
    } else throw new IllegalArgumentException("Choose a Postman or Argus environment JSON file");
    return save(new SaveApiEnvironmentRequest(null, name, values, null));
  }

  public Map<String, Object> exportDocument(String id) {
    var environment = require(id);
    return Map.of(
        "id",
        environment.id(),
        "name",
        environment.name(),
        "values",
        environment.values().entrySet().stream()
            .map(
                entry ->
                    Map.of(
                        "key",
                        entry.getKey(),
                        "value",
                        entry.getValue(),
                        "enabled",
                        true,
                        "type",
                        "default"))
            .toList(),
        "_postman_variable_scope",
        "environment",
        "_postman_exported_at",
        Instant.now().toString(),
        "_postman_exported_using",
        "Argus");
  }

  private Map<String, String> normalize(Map<String, Object> source) {
    Map<String, String> result = new LinkedHashMap<>();
    if (source == null) return result;
    source.forEach(
        (key, value) -> {
          if (key != null && !key.trim().isBlank())
            result.put(key.trim(), value == null ? "" : String.valueOf(value));
        });
    return result;
  }

  public static Map<String, String> parse(String text) {
    return EnvironmentFormat.parse(text);
  }

  private String serialize(Map<String, String> values) {
    return EnvironmentFormat.serialize(values);
  }
}
