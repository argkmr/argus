package com.argus.repositorycontext.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.workspace.domain.Repository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class RepositoryBriefServiceTest {
  @TempDir Path directory;

  @Test
  void reportsExistingMarkdownOnlyProfilesWithoutRewritingThem() throws Exception {
    Path data = directory.resolve("data"),
        profiles = Files.createDirectories(data.resolve("repository-contexts"));
    String content =
        "# Argus repository brief: orders\n\n- Indexed files: 24\n- Indexed source paths: 12\n- Source navigation sections: 2\n- Route and code-signal sections: 3\n- Context fingerprint: abc123\n";
    Files.writeString(profiles.resolve("old-repo.md"), content);
    var mapper = new ObjectMapper();
    var service =
        new RepositoryBriefService(
            new ArgusProperties(data, directory, "test", "token"),
            mapper,
            new AtomicJsonStore(mapper));
    var status = service.status();
    assertThat(status)
        .containsEntry("cachedRepositories", 1)
        .containsEntry("indexedFiles", 24L)
        .containsEntry("indexedSourcePaths", 12L);
    assertThat(String.valueOf(status.get("fingerprints"))).contains("old-repo", "orders", "abc123");
    assertThat(Files.readString(profiles.resolve("old-repo.md"))).isEqualTo(content);
    assertThat(Files.exists(profiles.resolve("old-repo.json"))).isFalse();
  }

  @Test
  void excludesSensitiveAndLinkedSourcesAndRespectsExplicitRepositorySelection() throws Exception {
    Path data = directory.resolve("data"),
        first = Files.createDirectory(directory.resolve("first")),
        second = Files.createDirectory(directory.resolve("second"));
    Files.writeString(first.resolve("README.md"), "# First\nInvoice request routing");
    Files.writeString(first.resolve("secret-key.txt"), "never include");
    Files.writeString(first.resolve(".env"), "TOKEN=never include");
    Files.createSymbolicLink(first.resolve("external.md"), second.resolve("README.md"));
    Files.writeString(second.resolve("README.md"), "# Second\nOrders route and validation");
    var properties = new ArgusProperties(data, directory, "test", "token");
    var mapper = new ObjectMapper();
    var service = new RepositoryBriefService(properties, mapper, new AtomicJsonStore(mapper));
    var a = new Repository("a", "first", first.toString(), "now", "main");
    var b = new Repository("b", "second", second.toString(), "now", "main");
    assertThat(String.valueOf(service.build(a).get("context")))
        .doesNotContain("never include", "external.md");
    var result = service.retrieve(List.of(b, a), "invoice", "global", true);
    assertThat(((java.util.Map<?, ?>) result.get("metrics")).get("selectedRepositoryNames"))
        .isEqualTo(List.of("second", "first"));
    assertThat(Files.exists(data.resolve("repository-contexts/a.json"))).isTrue();
    assertThat(service.purge(a)).isEqualTo(2);
    assertThat(Files.exists(first.resolve("README.md"))).isTrue();
  }
}
