package com.argus.repositorycontext.service;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.workspace.domain.Repository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class RepositoryContextServiceTest {
  @TempDir Path root;
  final ObjectMapper mapper = new ObjectMapper();

  RepositoryContextService service() {
    return new RepositoryContextService(
        new ArgusProperties(root.resolve("data"), root, "test", ""),
        new AtomicJsonStore(mapper),
        mapper,
        new AiKitCoverageService(mapper));
  }

  Repository repo() throws Exception {
    Path source = Files.createDirectories(root.resolve("source"));
    Files.writeString(
        source.resolve("Controller.java"),
        "class Controller {\n@GetMapping(\"/orders\")\nvoid orders(){}\n}\n");
    return new Repository("repo-a", "orders", source.toString(), "now", "main");
  }

  Map<String, Object> writeKit(Path staging, Repository repo) throws Exception {
    var inventory = new AiKitCoverageService(mapper).inventory(repo);
    Path skill = Files.createDirectories(staging.resolve("skills/order-query"));
    Files.writeString(
        skill.resolve("SKILL.md"),
        "---\nname: order-query\ndescription: Query orders and their state.\n---\n# Purpose\nRead orders.\n## Entry points\nController.java\n## Flow\nQuery.\n## Validations\nValidate.\n## Dependencies\nStore.\n## Failure behavior\nPropagate.\n## Observability\nLogs.\n## Source files and tests\nController.java\n");
    var entry = map(list(inventory.get("entryPoints")).get(0));
    Files.writeString(staging.resolve("AGENTS.md"), "Use order-query");
    Files.writeString(
        staging.resolve("skill-coverage.json"),
        mapper.writeValueAsString(
            object(
                "schemaVersion",
                1,
                "inventoryFingerprint",
                inventory.get("fingerprint"),
                "entries",
                List.of(
                    object(
                        "entryPointId",
                        entry.get("id"),
                        "businessFlow",
                        "Order querying",
                        "skill",
                        "order-query",
                        "evidence",
                        List.of(entry.get("source")))))));
    return inventory;
  }

  @Test
  void onlyPublishesCompleteCoverageAndKeepsPreviousKitOnFailedReplacement() throws Exception {
    var repo = repo();
    var service = service();
    Path staging = service.createGeneratedKitStaging(repo);
    var inventory = writeKit(staging, repo);
    var committed = service.commitGeneratedKit(repo, staging, "codex", "revision-1", inventory);
    assertThat(map(committed.get("validation"))).containsEntry("coveredEntryPoints", 1);
    assertThat(service.artifactStatus(List.of(repo)).get(0))
        .containsEntry("privateReady", true)
        .containsEntry("sourceRevision", "revision-1");
    Path bad = service.createGeneratedKitStaging(repo);
    writeKit(bad, repo);
    Files.writeString(
        bad.resolve("skill-coverage.json"),
        mapper.writeValueAsString(
            object(
                "schemaVersion",
                1,
                "inventoryFingerprint",
                inventory.get("fingerprint"),
                "entries",
                List.of())));
    assertThatThrownBy(
            () -> service.commitGeneratedKit(repo, bad, "codex", "revision-2", inventory))
        .hasMessageContaining("incomplete");
    assertThat(service.artifactStatus(List.of(repo)).get(0))
        .containsEntry("sourceRevision", "revision-1");
    assertThat(Files.exists(Path.of(repo.path(), "argus-ai"))).isFalse();
    assertThat(Files.readString(Path.of(repo.path(), "Controller.java"))).contains("@GetMapping");
  }

  @Test
  void exportProtectsUnmanagedFilesAndPurgeProtectsRepositorySource() throws Exception {
    var repo = repo();
    var service = service();
    Path staging = service.createGeneratedKitStaging(repo);
    service.commitGeneratedKit(repo, staging, "codex", "revision", writeKit(staging, repo));
    Path export = Files.createDirectories(Path.of(repo.path(), "argus-ai"));
    Files.writeString(export.resolve("mine.md"), "mine");
    assertThatThrownBy(() -> service.exportArtifacts(repo)).hasMessageContaining("not managed");
    service.purgeRepository(repo);
    assertThat(Files.readString(export.resolve("mine.md"))).isEqualTo("mine");
    assertThat(Files.exists(Path.of(repo.path(), "Controller.java"))).isTrue();
    assertThat(Files.exists(service.artifactRoot(repo))).isFalse();
  }

  @Test
  void refusesEscapingPrivateSymlinksAndCanPurgeDisconnectedPaths() throws Exception {
    var repo = repo();
    var service = service();
    Path outside = Files.createDirectories(root.resolve("outside"));
    Files.createDirectories(service.artifactRoot(repo).getParent());
    Files.createSymbolicLink(service.artifactRoot(repo), outside);
    assertThatThrownBy(() -> service.aiKitContexts(List.of(repo)))
        .hasMessageContaining("symbolic link");
    service.purgeRepository(
        new Repository(
            repo.id(), repo.name(), root.resolve("already-missing").toString(), "now", "main"));
    assertThat(Files.isDirectory(outside)).isTrue();
  }

  @Test
  void restartClearsOnlyTheSelectedPrivateKitAndOwnedStaging() throws Exception {
    var repository = repo();
    var service = service();
    Path live = Files.createDirectories(service.artifactRoot(repository));
    Files.writeString(live.resolve("partial.md"), "partial");
    Path staging = service.createGeneratedKitStaging(repository);
    Path sibling = Files.createDirectories(live.resolveSibling("repo-other"));
    Files.writeString(sibling.resolve("keep.md"), "keep");
    Path unowned = Files.createDirectories(live.resolveSibling("repo-a.previous-user"));
    service.resetGeneratedKit(repository);
    assertThat(live).doesNotExist();
    assertThat(staging).doesNotExist();
    assertThat(Files.readString(sibling.resolve("keep.md"))).isEqualTo("keep");
    assertThat(unowned).isDirectory();
    assertThat(Path.of(repository.path(), "Controller.java")).isRegularFile();
  }
}
