package com.argus.apiclient.repository;

import static org.assertj.core.api.Assertions.*;

import com.argus.apiclient.domain.ApiEnvironment;
import com.argus.common.storage.AtomicJsonStore;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class ApiEnvironmentRepositoryTest {
  @TempDir Path temporary;

  @Test
  void readsLegacyCollectionEnvironmentsThenPersistsWithoutDestroyingTheirOriginal()
      throws Exception {
    Path primary = temporary.resolve("data/environments.json"),
        legacy = temporary.resolve("collections/environments.json");
    Files.createDirectories(legacy.getParent());
    String original =
        "{\"format\":\"argus-api-environments\",\"version\":1,\"environments\":[{\"id\":\"qa\",\"name\":\"QA\",\"values\":{\"URL\":\"https://qa.example.test\"},\"createdAt\":\"before\",\"updatedAt\":\"before\"}]}";
    Files.writeString(legacy, original);
    var json = new AtomicJsonStore(new ObjectMapper());
    var repository = new ApiEnvironmentRepository(json, primary, legacy);
    assertThat(repository.list()).extracting(ApiEnvironment::id).containsExactly("qa");
    assertThat(primary).doesNotExist();
    repository.save(
        new ApiEnvironment("local", "Local", Map.of("URL", "http://localhost"), "now", "now"));
    assertThat(legacy).hasContent(original);
    assertThat(primary).exists();
    Files.writeString(legacy, "invalid legacy metadata must not override the migrated primary");
    assertThat(new ApiEnvironmentRepository(json, primary, legacy).list())
        .extracting(ApiEnvironment::id)
        .containsExactly("qa", "local");
  }

  @Test
  void rejectsSymlinkOrUnsupportedLegacyEnvironmentMetadata() throws Exception {
    var json = new AtomicJsonStore(new ObjectMapper());
    Path outside = temporary.resolve("outside.json"), legacy = temporary.resolve("legacy.json");
    Files.writeString(outside, "{\"format\":\"wrong\",\"version\":1,\"environments\":[]}");
    assertThatThrownBy(
            () -> new ApiEnvironmentRepository(json, temporary.resolve("primary.json"), outside))
        .hasMessageContaining("Unsupported");
    Files.createSymbolicLink(legacy, outside);
    assertThatThrownBy(
            () -> new ApiEnvironmentRepository(json, temporary.resolve("primary.json"), legacy))
        .hasMessageContaining("symbolic links");
    assertThat(outside).hasContent("{\"format\":\"wrong\",\"version\":1,\"environments\":[]}");
  }
}
