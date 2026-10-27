package com.argus.apiclient.repository;

import com.argus.apiclient.domain.ApiEnvironment;
import com.argus.apiclient.domain.ApiEnvironmentDocument;
import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import org.springframework.stereotype.Repository;

@Repository
public class ApiEnvironmentRepository {
  private final AtomicJsonStore json;
  private final Path path;
  private final ApiEnvironmentDocument document;

  @org.springframework.beans.factory.annotation.Autowired
  public ApiEnvironmentRepository(
      AtomicJsonStore json, ArgusProperties properties, ApiCollectionRepository collections) {
    this(
        json,
        properties.dataDirectory().resolve("environments.json"),
        collections.root().resolve("environments.json"));
  }

  public ApiEnvironmentRepository(AtomicJsonStore json, ArgusProperties properties) {
    this(json, properties.dataDirectory().resolve("environments.json"), null);
  }

  ApiEnvironmentRepository(AtomicJsonStore json, Path primary, Path legacy) {
    this.json = json;
    this.path = primary;
    Path source = Files.exists(primary, java.nio.file.LinkOption.NOFOLLOW_LINKS) ? primary : legacy;
    if (source != null && Files.exists(source, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
      if (Files.isSymbolicLink(source) || Files.isSymbolicLink(source.getParent()))
        throw new IllegalArgumentException("API environments must not use symbolic links");
      this.document = json.read(source, ApiEnvironmentDocument.class);
      if (!"argus-api-environments".equals(document.format)
          || document.version != 1
          || document.environments == null)
        throw new IllegalArgumentException("Unsupported Argus API environment file");
    } else this.document = new ApiEnvironmentDocument();
  }

  public synchronized List<ApiEnvironment> list() {
    return List.copyOf(document.environments);
  }

  public synchronized void save(ApiEnvironment environment) {
    int found = -1;
    for (int i = 0; i < document.environments.size(); i++)
      if (document.environments.get(i).id().equals(environment.id())) {
        found = i;
        break;
      }
    if (found >= 0) document.environments.set(found, environment);
    else document.environments.add(environment);
    persist();
  }

  public synchronized void delete(String id) {
    document.environments.removeIf(item -> item.id().equals(id));
    persist();
  }

  private void persist() {
    document.updatedAt = Instant.now().toString();
    json.write(path, document);
  }
}
