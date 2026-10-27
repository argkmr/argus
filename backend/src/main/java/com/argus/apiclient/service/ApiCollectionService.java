package com.argus.apiclient.service;

import com.argus.apiclient.repository.ApiCollectionRepository;
import com.argus.common.error.NotFoundException;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import java.net.URI;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;

@Service
public class ApiCollectionService {
  private final ApiCollectionRepository storage;
  private final WorkspaceService workspace;

  public ApiCollectionService(ApiCollectionRepository storage, WorkspaceService workspace) {
    this.storage = storage;
    this.workspace = workspace;
  }

  public Repository repository(String id) {
    return "standalone-api-client".equals(id)
        ? new Repository(id, "API Client", "", "")
        : workspace.requireRepository(id);
  }

  public List<Repository> repositories() {
    var repositories = new ArrayList<>(workspace.snapshot().repositories());
    repositories.add(0, repository("standalone-api-client"));
    return repositories;
  }

  public Map<String, Object> configuration(Repository repository, String id) {
    if (id.isBlank()) return null;
    var configuration =
        workspace.snapshot().runConfigurations().stream()
            .filter(item -> id.equals(item.get("id")))
            .findFirst()
            .orElseThrow(() -> new NotFoundException("Selected service was not found"));
    if (!repository.id().equals(configuration.get("repositoryId")))
      throw new IllegalArgumentException(
          "API collection service must belong to the same repository");
    return configuration;
  }

  public Path directory(Repository repository) {
    Path directory = storage.directory(repository);
    storage.safePath(directory);
    return directory;
  }

  public synchronized Map<String, Object> purgeRepository(Repository repository) {
    return Map.of("apiCollectionDirectoryDeleted", storage.purgeRepository(repository));
  }

  public synchronized List<Map<String, Object>> requests(Repository repository) {
    var result = new ArrayList<Map<String, Object>>();
    for (Path path : storage.files(repository)) {
      var stored = storage.read(path);
      if (stored == null) continue;
      var ids = rows(stored.get("collections")).stream().map(item -> text(item.get("id"))).toList();
      for (var row : rows(stored.get("requests"))) {
        if (!ids.contains(text(row.get("collectionId")))) continue;
        var request = normalize(row, repository, object(stored.get("service")));
        request.put("updatedAt", row.getOrDefault("updatedAt", request.get("updatedAt")));
        request.put("curl", row.getOrDefault("curl", request.get("curl")));
        request.put("collectionFile", path.toString());
        request.put("curlFile", curlFile(path, request).toString());
        result.add(request);
      }
    }
    result.sort(
        Comparator.comparing((Map<String, Object> item) -> text(item.get("updatedAt"))).reversed());
    return result;
  }

  public synchronized List<Map<String, Object>> collections(Repository repository) {
    var result = new ArrayList<Map<String, Object>>();
    for (Path path : storage.files(repository)) {
      var stored = storage.read(path);
      if (stored == null) continue;
      for (var row : rows(stored.get("collections"))) {
        var value = new LinkedHashMap<>(row);
        value.put("repositoryId", repository.id());
        value.put("runConfigurationId", object(stored.get("service")).get("id"));
        value.put("collectionFile", path.toString());
        value.putIfAbsent("description", "");
        value.putIfAbsent("variables", Map.of());
        value.putIfAbsent("createdAt", stored.get("updatedAt"));
        value.putIfAbsent("updatedAt", stored.get("updatedAt"));
        result.add(value);
      }
    }
    result.sort(Comparator.comparing(item -> text(item.get("name"))));
    return result;
  }

  public synchronized Map<String, Object> create(
      Repository repository, Map<String, Object> configuration, Map<String, Object> input) {
    String name = text(input.get("name")).trim();
    if (name.isEmpty()) throw new IllegalArgumentException("Collection name is required");
    var path = storage.collectionFile(repository, configuration);
    var stored = storage.read(path);
    if (stored == null) stored = document(repository, configuration);
    var collections = rows(stored.get("collections"));
    var existing =
        collections.stream()
            .filter(item -> text(item.get("name")).equalsIgnoreCase(name))
            .findFirst()
            .orElse(null);
    String now = Instant.now().toString();
    if (existing == null) {
      existing = new LinkedHashMap<>();
      existing.put("id", UUID.randomUUID().toString());
      existing.put("name", name);
      existing.put("createdAt", now);
      existing.put("description", "");
      existing.put("variables", Map.of());
      existing.put("postman", null);
      collections.add(existing);
    }
    for (String key : List.of("description", "variables", "postman"))
      if (input.containsKey(key)) existing.put(key, input.get(key));
    existing.put("updatedAt", now);
    stored.put("collections", collections);
    stored.put("updatedAt", now);
    storage.write(path, stored);
    var result = new LinkedHashMap<>(existing);
    result.put("repositoryId", repository.id());
    result.put("runConfigurationId", configuration == null ? null : configuration.get("id"));
    result.put("collectionFile", path.toString());
    return result;
  }

  public synchronized Map<String, Object> save(
      Repository repository, Map<String, Object> configuration, Map<String, Object> input) {
    var request = normalize(input, repository, configuration);
    String id = text(request.get("id"));
    if (!id.matches("[A-Za-z0-9_-]{1,128}"))
      throw new IllegalArgumentException("Invalid API request identifier");
    Path path = storage.collectionFile(repository, configuration);
    var stored = storage.read(path);
    if (stored == null)
      throw new IllegalArgumentException("Choose a collection before saving this request");
    if (rows(stored.get("collections")).stream()
        .noneMatch(item -> text(item.get("id")).equals(text(request.get("collectionId")))))
      throw new IllegalArgumentException("Selected API collection was not found for this service");
    var previous =
        requests(repository).stream()
            .filter(item -> id.equals(item.get("id")))
            .findFirst()
            .orElse(null);
    if (previous != null && !path.toString().equals(previous.get("collectionFile")))
      removeRequest(repository, id);
    var requests = rows(stored.get("requests"));
    requests.removeIf(item -> id.equals(item.get("id")));
    requests.add(request);
    stored.put("requests", requests);
    stored.put("updatedAt", Instant.now().toString());
    storage.write(path, stored);
    Path curl = curlFile(path, request);
    storage.writeCurl(curl, text(request.get("curl")));
    if (previous != null && !curl.toString().equals(previous.get("curlFile")))
      storage.delete(Path.of(text(previous.get("curlFile"))));
    request.put("collectionFile", path.toString());
    request.put("curlFile", curl.toString());
    return request;
  }

  public synchronized void removeRequest(Repository repository, String id) {
    var request =
        requests(repository).stream()
            .filter(item -> id.equals(item.get("id")))
            .findFirst()
            .orElseThrow(() -> new NotFoundException("API request not found"));
    Path file = Path.of(text(request.get("collectionFile")));
    var stored = storage.read(file);
    stored.put(
        "requests",
        rows(stored.get("requests")).stream().filter(item -> !id.equals(item.get("id"))).toList());
    stored.put("updatedAt", Instant.now().toString());
    storage.write(file, stored);
    storage.delete(Path.of(text(request.get("curlFile"))));
  }

  public synchronized Map<String, Object> removeCollection(Repository repository, String id) {
    String name =
        collections(repository).stream()
            .filter(item -> id.equals(item.get("id")))
            .findFirst()
            .map(item -> text(item.get("name")))
            .orElseThrow(() -> new NotFoundException("API collection not found"));
    return removePath(repository, name);
  }

  public synchronized Map<String, Object> removePath(Repository repository, String name) {
    if (name == null || name.isBlank())
      throw new IllegalArgumentException("API collection path is required");
    var matching =
        collections(repository).stream()
            .filter(
                item ->
                    name.equals(item.get("name"))
                        || text(item.get("name")).startsWith(name + " / "))
            .toList();
    if (matching.isEmpty()) throw new NotFoundException("API collection not found");
    var ids = matching.stream().map(item -> text(item.get("id"))).toList();
    int deleted = 0;
    for (Path file :
        matching.stream()
            .map(item -> Path.of(text(item.get("collectionFile"))))
            .distinct()
            .toList()) {
      var stored = storage.read(file);
      var removed =
          rows(stored.get("requests")).stream()
              .filter(item -> ids.contains(text(item.get("collectionId"))))
              .toList();
      deleted += removed.size();
      for (var request : removed) storage.delete(curlFile(file, request));
      var remaining =
          rows(stored.get("requests")).stream()
              .filter(item -> !ids.contains(text(item.get("collectionId"))))
              .toList();
      var collections =
          rows(stored.get("collections")).stream()
              .filter(item -> !ids.contains(text(item.get("id"))))
              .toList();
      if (remaining.isEmpty() && collections.isEmpty()) {
        storage.delete(file);
        try {
          storage.delete(file.getParent());
        } catch (IllegalStateException ignored) {
        }
      } else {
        stored.put("requests", remaining);
        stored.put("collections", collections);
        stored.put("updatedAt", Instant.now().toString());
        storage.write(file, stored);
      }
    }
    return Map.of(
        "ok",
        true,
        "name",
        name,
        "deletedCollectionCount",
        matching.size(),
        "deletedRequestCount",
        deleted);
  }

  public synchronized List<Map<String, Object>> importDocument(
      Repository repository, Object parsed, String fallbackName, String targetConfigurationId) {
    Map<String, Object> target =
        configuration(repository, targetConfigurationId == null ? "" : targetConfigurationId);
    var definitions = new ArrayList<Map<String, Object>>();
    var entries = new ArrayList<Map<String, Object>>();
    var document = object(parsed);
    var info = object(document.get("info"));
    String schema = text(info.get("schema"));
    if (!info.isEmpty()
        && document.get("item") instanceof List<?>
        && (schema.contains("postman.com/json/collection")
            || schema.contains("getpostman.com/json/collection"))) {
      String root = text(info.getOrDefault("name", fallbackName));
      var variables = postmanVariables(document.get("variable"));
      var definition = new LinkedHashMap<String, Object>();
      definition.put("collectionName", root);
      definition.put("description", description(info.get("description")));
      definition.put("variables", variables);
      var metadata = new LinkedHashMap<String, Object>();
      metadata.put("info", info);
      metadata.put("auth", document.get("auth"));
      metadata.put("event", document.getOrDefault("event", List.of()));
      definition.put("postman", metadata);
      definitions.add(definition);
      flattenPostman(rows(document.get("item")), root, variables, definitions, entries);
    } else if ("argus-api-collection".equals(document.get("format"))
        && document.get("services") instanceof List<?>) {
      for (var service : rows(document.get("services")))
        importArgusGroup(service, definitions, entries);
    } else if ("argus-api-collection".equals(document.get("format"))
        && "standalone".equals(document.get("scope"))) {
      importArgusGroup(document, definitions, entries);
    } else if ("argus-api-collection".equals(document.get("format"))
        && document.get("requests") instanceof List<?>) {
      var service = object(document.get("service"));
      var names = new LinkedHashMap<String, Object>();
      for (var collection : rows(document.get("collections"))) {
        names.put(text(collection.get("id")), collection.get("name"));
        var definition = new LinkedHashMap<>(collection);
        definition.put("collectionName", collection.get("name"));
        definition.put("serviceId", service.get("id"));
        definition.put("serviceName", service.get("name"));
        definitions.add(definition);
      }
      for (var request : rows(document.get("requests"))) {
        var entry = new LinkedHashMap<String, Object>();
        entry.put("request", request);
        entry.put("serviceId", service.get("id"));
        entry.put("serviceName", service.get("name"));
        entry.put("collectionName", names.get(text(request.get("collectionId"))));
        entries.add(entry);
      }
    } else if (parsed instanceof List<?>) {
      for (var request : rows(parsed)) entries.add(new LinkedHashMap<>(Map.of("request", request)));
    } else entries.add(new LinkedHashMap<>(Map.of("request", document)));
    for (var entry : entries)
      if (text(entry.get("collectionName")).isBlank()) {
        entry.put("collectionName", fallbackName);
        definitions.add(new LinkedHashMap<>(Map.of("collectionName", fallbackName)));
      }
    Map<String, Map<String, Object>> imported = new LinkedHashMap<>();
    for (var definition : definitions) {
      var service = importConfiguration(repository, target, definition);
      String name = text(definition.get("collectionName"));
      String key = (service == null ? "repository" : text(service.get("id"))) + ":" + name;
      if (!imported.containsKey(key)) {
        var input = new LinkedHashMap<>(definition);
        input.put("name", name);
        imported.put(key, create(repository, service, input));
      }
    }
    var result = new ArrayList<Map<String, Object>>();
    for (var entry : entries) {
      var request = object(entry.get("request"));
      var service = importConfiguration(repository, target, entry);
      String name = text(entry.get("collectionName"));
      String key = (service == null ? "repository" : text(service.get("id"))) + ":" + name;
      if (!imported.containsKey(key))
        imported.put(
            key,
            create(
                repository,
                service,
                Map.of("name", name, "variables", object(request.get("variables")))));
      request.remove("id");
      request.put("collectionId", imported.get(key).get("id"));
      request.put("createdBy", "import");
      result.add(save(repository, service, request));
    }
    return result;
  }

  private Map<String, Object> importConfiguration(
      Repository repository, Map<String, Object> target, Map<String, Object> entry) {
    if (target != null) return target;
    String id = text(entry.get("serviceId"));
    if (id.isEmpty()) return null;
    return workspace.snapshot().runConfigurations().stream()
        .filter(
            item ->
                repository.id().equals(item.get("repositoryId"))
                    && (id.equals(item.get("id"))
                        || text(entry.get("serviceName")).equals(item.get("name"))))
        .findFirst()
        .orElse(null);
  }

  private static void importArgusGroup(
      Map<String, Object> service,
      List<Map<String, Object>> definitions,
      List<Map<String, Object>> entries) {
    for (var request : rows(service.get("requests"))) {
      var entry = new LinkedHashMap<String, Object>();
      entry.put("request", request);
      entry.put("serviceId", service.get("id"));
      entry.put("serviceName", service.get("name"));
      entries.add(entry);
    }
    for (var collection : rows(service.get("collections"))) {
      var definition = new LinkedHashMap<>(collection);
      definition.put("collectionName", collection.get("name"));
      definition.put("serviceId", service.get("id"));
      definition.put("serviceName", service.get("name"));
      definitions.add(definition);
      for (var request : rows(collection.get("requests"))) {
        var entry = new LinkedHashMap<>(definition);
        entry.put("request", request);
        entries.add(entry);
      }
    }
  }

  private static void flattenPostman(
      List<Map<String, Object>> items,
      String path,
      Map<String, Object> variables,
      List<Map<String, Object>> definitions,
      List<Map<String, Object>> entries) {
    if (path.length() > 8192 || path.split(" / ", -1).length > 128)
      throw new IllegalArgumentException("Postman folder nesting is too deep");
    for (var item : items) {
      if (item.get("item") instanceof List<?>) {
        String next = path + " / " + text(item.getOrDefault("name", "Folder"));
        definitions.add(
            new LinkedHashMap<>(
                Map.of(
                    "collectionName",
                    next,
                    "description",
                    description(item.get("description")),
                    "variables",
                    variables)));
        flattenPostman(rows(item.get("item")), next, variables, definitions, entries);
      } else if (item.get("request") instanceof Map<?, ?>) {
        var source = object(item.get("request"));
        var urlObject = object(source.get("url"));
        String url = source.get("url") instanceof String value ? value : text(urlObject.get("raw"));
        var request = new LinkedHashMap<String, Object>();
        request.put(
            "name",
            item.getOrDefault("name", text(source.getOrDefault("method", "GET")) + " request"));
        request.put("method", source.getOrDefault("method", "GET"));
        request.put("url", url);
        request.put(
            "queryParams",
            urlObject.get("query") instanceof List<?>
                ? ApiRequestParameters.normalize(urlObject.get("query"))
                : ApiRequestParameters.query(url));
        var paths = ApiRequestParameters.normalize(urlObject.get("variable"));
        request.put("pathVariables", paths.isEmpty() ? ApiRequestParameters.path(url) : paths);
        var headers = new LinkedHashMap<String, Object>();
        for (var header : rows(source.get("header")))
          if (!Boolean.TRUE.equals(header.get("disabled")) && !text(header.get("key")).isEmpty())
            headers.put(text(header.get("key")), text(header.get("value")));
        request.put("headers", headers);
        request.put("body", postmanBody(object(source.get("body"))));
        request.put("variables", variables);
        request.put("description", description(source.get("description")));
        var metadata = new LinkedHashMap<String, Object>();
        for (String key : List.of("url", "header", "auth", "body", "protocolProfileBehavior"))
          metadata.put(key, source.get(key));
        metadata.put("event", item.getOrDefault("event", List.of()));
        metadata.put("response", item.getOrDefault("response", List.of()));
        request.put("postman", metadata);
        entries.add(new LinkedHashMap<>(Map.of("request", request, "collectionName", path)));
      }
    }
  }

  private static String postmanBody(Map<String, Object> body) {
    String mode = text(body.get("mode"));
    if (mode.equals("raw")) return text(body.get("raw"));
    if (mode.equals("urlencoded"))
      return rows(body.get("urlencoded")).stream()
          .filter(
              item ->
                  !Boolean.TRUE.equals(item.get("disabled")) && !text(item.get("key")).isEmpty())
          .map(
              item ->
                  java.net.URLEncoder.encode(
                          text(item.get("key")), java.nio.charset.StandardCharsets.UTF_8)
                      + "="
                      + java.net.URLEncoder.encode(
                          text(item.get("value")), java.nio.charset.StandardCharsets.UTF_8))
          .collect(java.util.stream.Collectors.joining("&"));
    if (mode.equals("formdata")) {
      var values = new LinkedHashMap<String, Object>();
      for (var item : rows(body.get("formdata")))
        if (!Boolean.TRUE.equals(item.get("disabled"))
            && !"file".equals(item.get("type"))
            && !text(item.get("key")).isEmpty())
          values.put(text(item.get("key")), text(item.get("value")));
      return new tools.jackson.databind.ObjectMapper()
          .writerWithDefaultPrettyPrinter()
          .writeValueAsString(values);
    }
    return "";
  }

  private static Map<String, Object> postmanVariables(Object rows) {
    var values = new LinkedHashMap<String, Object>();
    for (var item : rows(rows))
      if (!text(item.get("key")).isEmpty() && !Boolean.TRUE.equals(item.get("disabled")))
        values.put(text(item.get("key")), text(item.get("value")));
    return values;
  }

  private static String description(Object value) {
    return value instanceof Map<?, ?> object ? text(object.get("content")) : text(value);
  }

  public synchronized Map<String, Object> exportDocument(Repository repository) {
    var requests = requests(repository);
    var collections = collections(repository);
    var items = new ArrayList<Map<String, Object>>();
    var roots =
        collections.stream()
            .map(item -> text(item.get("name")).split(" / ")[0])
            .distinct()
            .toList();
    String importedRoot =
        "standalone-api-client".equals(repository.id())
                && roots.size() == 1
                && collections.stream()
                    .anyMatch(item -> text(item.get("name")).equals(roots.get(0)))
            ? roots.get(0)
            : "";
    var rootCollection =
        collections.stream()
            .filter(item -> text(item.get("name")).equals(importedRoot))
            .findFirst()
            .orElse(Map.of());
    if ("standalone-api-client".equals(repository.id())) {
      for (var collection : collections) {
        String name = text(collection.get("name"));
        if (!importedRoot.isEmpty())
          name = name.equals(importedRoot) ? "" : name.substring(importedRoot.length() + 3);
        var folder = folder(items, name);
        requests.stream()
            .filter(request -> text(collection.get("id")).equals(text(request.get("collectionId"))))
            .map(ApiCollectionService::postmanItem)
            .forEach(folder::add);
      }
    } else {
      var serviceIds = new java.util.LinkedHashSet<String>();
      requests.forEach(item -> serviceIds.add(text(item.get("runConfigurationId"))));
      collections.forEach(item -> serviceIds.add(text(item.get("runConfigurationId"))));
      for (String serviceId : serviceIds) {
        var children = new ArrayList<Map<String, Object>>();
        for (var collection : collections)
          if (serviceId.equals(text(collection.get("runConfigurationId")))) {
            var folder = folder(children, text(collection.get("name")));
            requests.stream()
                .filter(
                    request -> text(collection.get("id")).equals(text(request.get("collectionId"))))
                .map(ApiCollectionService::postmanItem)
                .forEach(folder::add);
          }
        String name =
            workspace.snapshot().runConfigurations().stream()
                .filter(item -> serviceId.equals(item.get("id")))
                .findFirst()
                .map(item -> text(item.get("name")))
                .orElse("Repository only");
        items.add(new LinkedHashMap<>(Map.of("name", name, "item", children)));
      }
    }
    var document = new LinkedHashMap<String, Object>();
    document.put(
        "info",
        Map.of(
            "_postman_id",
            UUID.randomUUID().toString(),
            "name",
            importedRoot.isEmpty() ? repository.name() : importedRoot,
            "description",
            text(rootCollection.getOrDefault("description", "Exported from Argus")),
            "schema",
            "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"));
    document.put("item", items);
    var variables = new LinkedHashMap<String, Object>();
    for (var collection : collections)
      object(collection.get("variables")).forEach(variables::putIfAbsent);
    for (var request : requests) object(request.get("variables")).forEach(variables::putIfAbsent);
    if (!variables.isEmpty())
      document.put(
          "variable",
          variables.entrySet().stream()
              .map(
                  entry ->
                      Map.of(
                          "key", entry.getKey(), "value", text(entry.getValue()), "type", "string"))
              .toList());
    var metadata = object(rootCollection.get("postman"));
    if (metadata.get("auth") != null) document.put("auth", metadata.get("auth"));
    if (metadata.get("event") instanceof List<?> events && !events.isEmpty())
      document.put("event", events);
    return document;
  }

  @SuppressWarnings("unchecked")
  private static List<Map<String, Object>> folder(List<Map<String, Object>> items, String path) {
    var level = items;
    for (String segment : path.split(" / "))
      if (!segment.isEmpty()) {
        var folder =
            level.stream()
                .filter(
                    item -> segment.equals(item.get("name")) && item.get("item") instanceof List<?>)
                .findFirst()
                .orElse(null);
        if (folder == null) {
          folder =
              new LinkedHashMap<>(
                  Map.of("name", segment, "item", new ArrayList<Map<String, Object>>()));
          level.add(folder);
        }
        level = (List<Map<String, Object>>) folder.get("item");
      }
    return level;
  }

  private static Map<String, Object> postmanItem(Map<String, Object> request) {
    var metadata = object(request.get("postman"));
    var headers = new ArrayList<Map<String, Object>>();
    object(request.get("headers"))
        .forEach(
            (key, value) ->
                headers.add(
                    new LinkedHashMap<>(Map.of("key", key, "value", text(value), "type", "text"))));
    for (var header : rows(metadata.get("header")))
      if (Boolean.TRUE.equals(header.get("disabled"))
          && headers.stream()
              .noneMatch(item -> text(item.get("key")).equalsIgnoreCase(text(header.get("key")))))
        headers.add(header);
    var url = object(metadata.get("url"));
    url.put("raw", request.get("url"));
    for (String type : List.of("query", "variable")) {
      var parameters =
          ApiRequestParameters.normalize(
              request.get(type.equals("query") ? "queryParams" : "pathVariables"));
      if (!parameters.isEmpty())
        url.put(
            type,
            parameters.stream()
                .map(
                    item -> {
                      var field = new LinkedHashMap<String, Object>();
                      field.put("key", item.get("key"));
                      field.put("value", item.get("value"));
                      field.put("type", "text");
                      if (!text(item.get("description")).isEmpty())
                        field.put("description", item.get("description"));
                      if (!Boolean.TRUE.equals(item.get("enabled"))) field.put("disabled", true);
                      return field;
                    })
                .toList());
    }
    var source = new LinkedHashMap<String, Object>();
    source.put("method", request.get("method"));
    source.put("header", headers);
    source.put("url", url);
    if (metadata.get("body") != null) source.put("body", metadata.get("body"));
    else if (!text(request.get("body")).isEmpty())
      source.put(
          "body",
          Map.of(
              "mode",
              "raw",
              "raw",
              request.get("body"),
              "options",
              Map.of("raw", Map.of("language", "json"))));
    if (!text(request.get("description")).isEmpty())
      source.put("description", request.get("description"));
    for (String key : List.of("auth", "protocolProfileBehavior"))
      if (metadata.get(key) != null) source.put(key, metadata.get(key));
    var item = new LinkedHashMap<String, Object>();
    item.put("name", request.get("name"));
    item.put("request", source);
    item.put("response", metadata.getOrDefault("response", List.of()));
    if (metadata.get("event") instanceof List<?> events && !events.isEmpty())
      item.put("event", events);
    return item;
  }

  private static Map<String, Object> normalize(
      Map<String, Object> input, Repository repository, Map<String, Object> configuration) {
    input = new LinkedHashMap<>(input);
    if (text(input.get("id")).isBlank()) input.put("id", UUID.randomUUID().toString());
    if (text(input.get("method")).isBlank()) input.put("method", "GET");
    if (text(input.get("name")).isBlank()) input.remove("name");
    String method = text(input.getOrDefault("method", "GET")).toUpperCase(java.util.Locale.ROOT);
    if (!method.matches("[A-Z]+")) throw new IllegalArgumentException("Invalid HTTP method");
    var query =
        input.get("queryParams") instanceof List<?>
            ? ApiRequestParameters.normalize(input.get("queryParams"))
            : ApiRequestParameters.query(text(input.get("url")));
    var path =
        input.get("pathVariables") instanceof List<?>
            ? ApiRequestParameters.normalize(input.get("pathVariables"))
            : ApiRequestParameters.path(text(input.get("url")));
    String url = ApiRequestParameters.compose(text(input.get("url")).trim(), query);
    String pathname = "/";
    if (!url.isEmpty()) {
      String parseable =
          url.replaceAll("\\{\\{[^{}]+}}", "argus-variable")
              .replaceAll("(?<!\\{)\\{([A-Za-z_][\\w.-]*)}(?!})", "argus-path");
      if (parseable.matches("(?i)^[a-z][a-z0-9+.-]*://.*")
          && !parseable.matches("(?i)^https?://.*"))
        throw new IllegalArgumentException("Only HTTP and HTTPS requests are supported");
      URI parsed =
          URI.create(
              parseable.matches("(?i)^https?://.*")
                  ? parseable
                  : "https://" + parseable.replaceFirst("^/+", ""));
      if (!Set.of("http", "https").contains(parsed.getScheme()) || parsed.getHost() == null)
        throw new IllegalArgumentException("Only HTTP and HTTPS requests are supported");
      if (!text(parsed.getPath()).isEmpty()) pathname = parsed.getPath();
    } else if (input.get("postman") == null && !"import".equals(input.get("createdBy")))
      throw new IllegalArgumentException("Request URL is required");
    var result = new LinkedHashMap<String, Object>();
    result.put("id", input.getOrDefault("id", UUID.randomUUID().toString()));
    result.put("repositoryId", repository.id());
    result.put("runConfigurationId", configuration == null ? null : configuration.get("id"));
    result.put("collectionId", input.get("collectionId"));
    result.put("name", text(input.getOrDefault("name", method + " " + pathname)).trim());
    result.put("method", method);
    result.put("url", url);
    result.put("queryParams", query);
    result.put("pathVariables", path);
    result.put("headers", object(input.get("headers")));
    result.put("body", text(input.get("body")));
    result.put("description", text(input.get("description")));
    result.put("variables", object(input.get("variables")));
    result.put("postman", input.get("postman"));
    result.put(
        "createdBy",
        Set.of("ai", "curl", "import").contains(text(input.get("createdBy")))
            ? input.get("createdBy")
            : "manual");
    result.put("updatedAt", Instant.now().toString());
    result.put("curl", curl(result));
    return result;
  }

  public static String curl(Map<String, Object> request) {
    String method = text(request.getOrDefault("method", "GET")).toUpperCase();
    var result =
        new StringBuilder("curl --request ")
            .append(method)
            .append(" ")
            .append(quote(text(request.get("url"))));
    object(request.get("headers"))
        .forEach(
            (key, value) -> result.append(" \\\n    --header ").append(quote(key + ": " + value)));
    if (!text(request.get("body")).isEmpty() && !Set.of("GET", "HEAD").contains(method))
      result.append(" \\\n    --data-raw ").append(quote(text(request.get("body"))));
    return result.toString();
  }

  private static String quote(String value) {
    return "'" + value.replace("'", "'\"'\"'") + "'";
  }

  private static Map<String, Object> document(
      Repository repository, Map<String, Object> configuration) {
    var result = new LinkedHashMap<String, Object>();
    result.put("format", "argus-api-collection");
    result.put("version", 1);
    result.put("repository", Map.of("id", repository.id(), "name", repository.name()));
    var service = new LinkedHashMap<String, Object>();
    service.put("id", configuration == null ? null : configuration.get("id"));
    service.put("name", configuration == null ? "Repository only" : configuration.get("name"));
    result.put("service", service);
    result.put("collections", new ArrayList<>());
    result.put("requests", new ArrayList<>());
    result.put("updatedAt", Instant.now().toString());
    return result;
  }

  private static Path curlFile(Path collection, Map<String, Object> request) {
    String id = text(request.get("id"));
    if (!id.matches("[A-Za-z0-9_-]{1,128}"))
      throw new IllegalArgumentException("Invalid saved API request identifier");
    return collection
        .getParent()
        .resolve(
            ApiCollectionRepository.safe(text(request.get("name")), "unnamed")
                + "--"
                + id.substring(0, Math.min(8, id.length()))
                + ".curl");
  }

  public static String text(Object value) {
    return value == null ? "" : String.valueOf(value);
  }

  @SuppressWarnings("unchecked")
  public static Map<String, Object> object(Object value) {
    return value instanceof Map<?, ?>
        ? new LinkedHashMap<>((Map<String, Object>) value)
        : new LinkedHashMap<>();
  }

  public static List<Map<String, Object>> rows(Object value) {
    var result = new ArrayList<Map<String, Object>>();
    if (value instanceof List<?> list)
      for (Object item : list) if (item instanceof Map<?, ?>) result.add(object(item));
    return result;
  }
}
