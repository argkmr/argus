package com.argus.tasks.repository;

import static org.assertj.core.api.Assertions.assertThat;

import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.tasks.service.TaskService;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class TaskRepositoryMessageIdTest {
  @TempDir Path directory;

  @Test
  void exposesStableLegacyIdsMatchingNodeWithoutRewritingTheTask() throws Exception {
    String source =
        """
        {"id":"legacy-task","messages":[{"role":"user","createdAt":"2026-09-06T10:00:00Z","content":"First prompt 🐟"},{"id":"saved-message-id","role":"assistant","content":"Done"}],"cliSessions":{"codex":{"id":"existing-session"}}}
        """;
    Path taskPath = directory.resolve("ai-tasks/legacy-task.json");
    Files.createDirectories(taskPath.getParent());
    Files.writeString(taskPath, source);
    ObjectMapper mapper = new ObjectMapper();
    var repository =
        new TaskRepository(
            new ArgusProperties(directory, null, "test", ""), new AtomicJsonStore(mapper), mapper);

    var task = repository.get("legacy-task");

    assertThat(task.messages.get(0).id)
        .isEqualTo("legacy-773decc34323766bb96a9f768b02335344b59105e03b5118b5f397a8756e2163");
    assertThat(repository.get("legacy-task").messages.get(0).id).isEqualTo(task.messages.get(0).id);
    assertThat(task.messages.get(1).id).isEqualTo("saved-message-id");
    assertThat(task.additionalProperties()).containsKey("cliSessions");
    assertThat(Files.readString(taskPath)).isEqualTo(source);
  }

  @Test
  void listsEmptyRevisionDraftsAndPreservesNodeMetadataWithoutRewritingSource() throws Exception {
    String source =
        """
        {"id":"revision-task","scope":"global","repositoryId":"global","repositoryIds":["repo-a"],"title":"Edited prompt","updatedAt":"2026-09-06T10:00:00Z","messages":[],"revisionOf":{"taskId":"source-task","pending":true},"revisionDraft":{"prompt":"Unsent exact prompt","attachments":[{"id":"file-a"}]}}
        """;
    String oldIndex =
        """
        [{"id":"revision-task","scope":"global","repositoryId":"global","title":"Edited prompt","updatedAt":"2026-09-06T10:00:00Z","messageCount":0,"visibleMessageCount":0,"archivedMessageCount":0}]
        """;
    Path taskPath = directory.resolve("ai-tasks/revision-task.json");
    Path indexPath = directory.resolve("ai-tasks/index.json");
    Files.createDirectories(taskPath.getParent());
    Files.writeString(taskPath, source);
    Files.writeString(indexPath, oldIndex);
    ObjectMapper mapper = new ObjectMapper();
    var repository =
        new TaskRepository(
            new ArgusProperties(directory, null, "test", ""), new AtomicJsonStore(mapper), mapper);

    var listed = new TaskService(repository).list("global", "global");

    assertThat(listed).hasSize(1);
    assertThat(listed.get(0).revisionCount()).isZero();
    assertThat(mapper.writeValueAsString(listed.get(0).revisionDraft()))
        .contains("Unsent exact prompt", "file-a");
    assertThat(mapper.writeValueAsString(repository.get("revision-task")))
        .contains("revisionDraft", "Unsent exact prompt");
    assertThat(Files.readString(taskPath)).isEqualTo(source);
    assertThat(Files.readString(indexPath)).isEqualTo(oldIndex);
  }

  @Test
  void missingOrNullRevisionCountInLegacyIndexDefaultsToZeroWithoutHydratingOrRewriting()
      throws Exception {
    var mapper = new ObjectMapper();
    var repository =
        new TaskRepository(
            new ArgusProperties(directory, null, "test", ""), new AtomicJsonStore(mapper), mapper);
    Path index = directory.resolve("ai-tasks/index.json");
    Files.createDirectories(index.getParent());
    for (String count : new String[] {"", ",\"revisionCount\":null"}) {
      String source =
          "[{\"id\":\"legacy-index-task\",\"scope\":\"global\",\"title\":\"Legacy\","
              + "\"updatedAt\":\"2026-09-06T10:00:00Z\",\"messageCount\":1,\"visibleMessageCount\":1,"
              + "\"archivedMessageCount\":0"
              + count
              + "}]";
      Files.writeString(index, source);
      assertThat(new TaskService(repository).list("global", null).get(0).revisionCount()).isZero();
      assertThat(Files.readString(index)).isEqualTo(source);
      assertThat(directory.resolve("ai-tasks/legacy-index-task.json")).doesNotExist();
    }
  }
}
