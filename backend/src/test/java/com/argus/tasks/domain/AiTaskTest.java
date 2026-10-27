package com.argus.tasks.domain;

import static org.assertj.core.api.Assertions.assertThat;

import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.tasks.repository.TaskRepository;
import com.argus.tasks.service.TaskService;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class AiTaskTest {
  @TempDir Path dataDirectory;

  @Test
  void renamingAChatPreservesItsSelectedModelAndNodeOwnedSessionMetadata() {
    ObjectMapper mapper = new ObjectMapper();
    AtomicJsonStore store = new AtomicJsonStore(mapper);
    var original =
        mapper.readTree(
            """
        {
          "id":"chat-12345678", "scope":"global", "repositoryId":"global",
          "repositoryIds":["orders"], "title":"Original title",
          "provider":"codex", "model":"gpt-6-astra", "effort":"ultra", "speed":"standard",
          "modelSettingsSavedAt":"2026-09-06T10:00:00Z",
          "contextMode":"fresh", "createdAt":"2026-09-06T09:00:00Z",
          "updatedAt":"2026-09-06T10:00:00Z", "messages":[],
          "cliSessions":{"codex":{"sessionId":"session-456","repositoryIds":["orders"]}},
          "futureNodeMetadata":{"keep":true,"schema":2}
        }
        """);
    Path path = dataDirectory.resolve("ai-tasks/chat-12345678.json");
    store.write(path, original);
    TaskService service =
        new TaskService(
            new TaskRepository(
                new ArgusProperties(dataDirectory, null, "test", ""), store, mapper));

    AiTask renamed = service.rename("chat-12345678", "Updated title");
    var saved = mapper.readTree(path.toFile());

    assertThat(renamed.title).isEqualTo("Updated title");
    for (String field :
        new String[] {
          "provider",
          "model",
          "effort",
          "speed",
          "modelSettingsSavedAt",
          "contextMode",
          "cliSessions",
          "futureNodeMetadata"
        }) {
      assertThat(saved.path(field)).as(field).isEqualTo(original.path(field));
    }
    assertThat(saved.has("additionalProperties")).isFalse();
    assertThat(mapper.valueToTree(service.get("chat-12345678")).path("cliSessions"))
        .isEqualTo(original.path("cliSessions"));
  }
}
