package com.argus.apiclient.controller;

import com.argus.apiclient.service.ApiCollectionService;
import com.argus.apiclient.service.ApiFileService;
import com.argus.apiclient.service.CurlParser;
import com.argus.common.error.NotFoundException;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class ApiCollectionController {
  private final ApiCollectionService collections;
  private final ApiFileService files;

  public ApiCollectionController(ApiCollectionService collections, ApiFileService files) {
    this.collections = collections;
    this.files = files;
  }

  @GetMapping("/repositories/{id}/api-requests")
  public List<Map<String, Object>> requests(@PathVariable String id) {
    return collections.requests(collections.repository(id));
  }

  @GetMapping("/repositories/{id}/api-collections")
  public List<Map<String, Object>> collections(@PathVariable String id) {
    return collections.collections(collections.repository(id));
  }

  @DeleteMapping("/repositories/{id}/api-collections")
  public Map<String, Object> deletePath(@PathVariable String id, @RequestParam String path) {
    return collections.removePath(collections.repository(id), path);
  }

  @GetMapping("/repositories/{id}/api-requests/location")
  public Map<String, Object> location(@PathVariable String id) {
    return Map.of("path", collections.directory(collections.repository(id)).toString());
  }

  @PostMapping("/repositories/{id}/api-requests/open-folder")
  public Map<String, Object> open(@PathVariable String id) {
    return files.openCollections(id);
  }

  @PostMapping("/repositories/{id}/api-requests/export")
  public Map<String, Object> export(@PathVariable String id) {
    return files.exportCollection(id);
  }

  @PostMapping("/api-collections")
  @ResponseStatus(HttpStatus.CREATED)
  public Map<String, Object> create(@RequestBody Map<String, Object> input) {
    var repository = collections.repository(ApiCollectionService.text(input.get("repositoryId")));
    return collections.create(
        repository,
        collections.configuration(
            repository, ApiCollectionService.text(input.get("runConfigurationId"))),
        input);
  }

  @PostMapping("/api-requests")
  @ResponseStatus(HttpStatus.CREATED)
  public Map<String, Object> save(@RequestBody Map<String, Object> input) {
    var repository = collections.repository(ApiCollectionService.text(input.get("repositoryId")));
    return collections.save(
        repository,
        collections.configuration(
            repository, ApiCollectionService.text(input.get("runConfigurationId"))),
        input);
  }

  @DeleteMapping("/api-collections/{id}")
  public Map<String, Object> deleteCollection(@PathVariable String id) {
    for (var repository : collections.repositories())
      if (collections.collections(repository).stream().anyMatch(item -> id.equals(item.get("id"))))
        return collections.removeCollection(repository, id);
    throw new NotFoundException("API collection not found");
  }

  @DeleteMapping("/api-requests/{id}")
  public Map<String, Object> deleteRequest(@PathVariable String id) {
    for (var repository : collections.repositories())
      if (collections.requests(repository).stream().anyMatch(item -> id.equals(item.get("id")))) {
        collections.removeRequest(repository, id);
        return Map.of("ok", true);
      }
    throw new NotFoundException("API request not found");
  }

  @PostMapping("/api-requests/import-curl")
  public Map<String, Object> curl(@RequestBody Map<String, Object> input) {
    var repository = collections.repository(ApiCollectionService.text(input.get("repositoryId")));
    var parsed = CurlParser.parse(ApiCollectionService.text(input.get("curl")));
    if (Boolean.FALSE.equals(input.get("save"))) return parsed;
    parsed.put("collectionId", input.get("collectionId"));
    parsed.put("createdBy", input.getOrDefault("createdBy", "curl"));
    return collections.save(
        repository,
        collections.configuration(
            repository, ApiCollectionService.text(input.get("runConfigurationId"))),
        parsed);
  }

  @PostMapping("/api-requests/import-file")
  public Map<String, Object> importFile(@RequestBody Map<String, Object> input) {
    return files.importCollection(
        ApiCollectionService.text(input.get("repositoryId")),
        ApiCollectionService.text(input.get("runConfigurationId")));
  }

  @PostMapping("/api-environments/import-file")
  public Map<String, Object> importEnvironment() {
    return files.importEnvironment();
  }

  @PostMapping("/api-environments/{id}/export")
  public Map<String, Object> exportEnvironment(@PathVariable String id) {
    return files.exportEnvironment(id);
  }
}
