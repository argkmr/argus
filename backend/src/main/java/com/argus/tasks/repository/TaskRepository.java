package com.argus.tasks.repository;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.NotFoundException;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.domain.TaskCheckpoint;
import com.argus.tasks.domain.TaskHistory;
import com.argus.tasks.dto.TaskSummary;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.Consumer;
import java.util.function.Function;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.ObjectMapper;

@Repository
public class TaskRepository {
  private final Path directory;
  private final Path indexPath;
  private final AtomicJsonStore json;
  private final ObjectMapper mapper;
  private final TaskRevisionArchive revisions;

  public TaskRepository(ArgusProperties properties, AtomicJsonStore json, ObjectMapper mapper) {
    this.directory = properties.dataDirectory().resolve("ai-tasks");
    this.indexPath = directory.resolve("index.json");
    this.json = json;
    this.mapper = mapper;
    this.revisions = new TaskRevisionArchive(directory, json, mapper);
  }

  public record RevisionBase(AiTask task, String revisionId, String createdAt) {}

  public record RevisionResult(AiTask task, String revisionId, boolean replayed) {}

  public synchronized RevisionResult replayRevision(
      String id, String requestId, String fingerprint) {
    return revisions.replay(readTask(id), requestId, fingerprint);
  }

  public synchronized RevisionResult revise(
      String id,
      String requestId,
      String fingerprint,
      long expectedCount,
      String messageId,
      Function<RevisionBase, AiTask> change) {
    return revisions.revise(
        readTask(id), requestId, fingerprint, expectedCount, messageId, change, this::save);
  }

  public synchronized List<Map<String, Object>> revisions(String id) {
    return revisions.list(readTask(id));
  }

  public synchronized Map<String, Object> revision(String id, String revisionId) {
    return revisions.get(readTask(id), revisionId);
  }

  public synchronized AiTask get(String id) {
    AiTask task = readTask(id);
    TaskHistory.cap(task);
    return task;
  }

  public synchronized AiTask readTask(String id) {
    Path path = taskPath(id);
    if (!Files.exists(path)) throw new NotFoundException("AI task not found");
    AiTask task = json.read(path, AiTask.class);
    identifyMessages(task);
    return task;
  }

  public synchronized List<TaskSummary> list() {
    if (!Files.exists(indexPath)) return new ArrayList<>();
    try {
      var summaries =
          new ArrayList<>(Arrays.asList(mapper.readValue(indexPath.toFile(), TaskSummary[].class)));
      // Older Java writers omitted Node-owned revision metadata from the index.
      // Hydrate empty revisions without rewriting either source or index on GET.
      for (int i = 0; i < summaries.size(); i++) {
        var item = summaries.get(i);
        if (item.messageCount() == 0
            && item.revisionOf() == null
            && Files.exists(directory.resolve(item.id() + ".json"))) {
          var task = get(item.id());
          if (task.additionalProperties().get("revisionOf") != null)
            summaries.set(i, summary(task));
        }
      }
      return summaries;
    } catch (RuntimeException error) {
      throw new IllegalStateException("Could not read task index", error);
    }
  }

  public synchronized AiTask save(AiTask task) {
    taskPath(task.id);
    task.updatedAt = Instant.now().toString();
    task.additionalProperties()
        .put(
            "contextMode",
            "history".equals(task.additionalProperties().get("contextMode")) ? "history" : "fresh");
    identifyMessages(task);
    TaskHistory.cap(task);
    writeTranscript(task);
    List<TaskSummary> index = list();
    TaskSummary summary = summary(task);
    int found = -1;
    for (int i = 0; i < index.size(); i++)
      if (index.get(i).id().equals(task.id)) {
        found = i;
        break;
      }
    if (found >= 0) index.set(found, summary);
    else index.add(summary);
    json.write(indexPath, index);
    return task;
  }

  public synchronized void delete(AiTask task) {
    try {
      taskPath(task.id);
      revisions.delete(task.id);
      Files.deleteIfExists(taskPath(task.id));
      deleteTranscript(task.transcriptPath);
    } catch (IOException error) {
      throw new IllegalStateException("Could not delete task", error);
    }
    List<TaskSummary> index = list();
    index.removeIf(item -> item.id().equals(task.id));
    json.write(indexPath, index);
  }

  private void writeTranscript(AiTask task) {
    identifyMessages(task);
    String safe = task.title.replaceAll("[^A-Za-z0-9._-]+", "-").replaceAll("^-+|-+$", "");
    if (safe.isBlank()) safe = "task";
    Path transcript =
        directory.resolve(
            safe.substring(0, Math.min(safe.length(), 70)) + "-" + task.id.substring(0, 8) + ".md");
    String previousTranscript = task.transcriptPath;
    task.transcriptPath = transcript.toString();
    List<String> lines =
        new ArrayList<>(
            List.of(
                "# " + task.title,
                "",
                "Scope: " + task.scope,
                "Updated: " + task.updatedAt,
                "Visible messages: " + task.messages.size(),
                "Compacted earlier messages: " + task.archivedMessageCount,
                ""));
    if (!task.rollingContext.isEmpty()) {
      lines.add("## Compacted earlier task context");
      lines.add("");
      lines.add(task.rollingContext);
      lines.add("");
    }
    for (var message : task.messages) {
      lines.add("## " + ("user".equals(message.role) ? "User" : "AI") + " · " + message.createdAt);
      lines.add("");
      lines.add(message.content);
      lines.add("");
    }
    try {
      Files.createDirectories(directory);
      Files.writeString(transcript, String.join("\n", lines) + "\n");
      try {
        Files.setPosixFilePermissions(
            transcript,
            java.util.Set.of(
                java.nio.file.attribute.PosixFilePermission.OWNER_READ,
                java.nio.file.attribute.PosixFilePermission.OWNER_WRITE));
      } catch (UnsupportedOperationException ignored) {
      }
      if (previousTranscript != null && !previousTranscript.equals(task.transcriptPath))
        deleteTranscript(previousTranscript);
      Files.deleteIfExists(Path.of(task.transcriptPath + ".gz"));
    } catch (IOException error) {
      throw new IllegalStateException("Could not write task transcript", error);
    }
    json.write(directory.resolve(task.id + ".json"), task);
  }

  public synchronized AiTask mutate(String id, Consumer<AiTask> change) {
    AiTask task = get(id);
    change.accept(task);
    return save(task);
  }

  /**
   * Save navigation metadata under the same lock as appends, without changing conversation recency,
   * transcript text, prompt history, or the task index. Returning the existing list is an
   * idempotent no-op; a replacement list advances the checkpoint-only revision for stale-response
   * protection.
   */
  public synchronized AiTask updateCheckpoints(
      String id, Function<AiTask, List<TaskCheckpoint>> change) {
    AiTask task = readTask(id);
    List<TaskCheckpoint> replacement = change.apply(task);
    if (replacement != task.checkpoints) {
      task.checkpoints = replacement;
      task.checkpointRevision++;
      json.write(taskPath(id), task);
    }
    return get(id);
  }

  private Path taskPath(String id) {
    if (id == null || !id.matches("[A-Za-z0-9_-]+") || id.length() > 200)
      throw new IllegalArgumentException("Invalid task ID");
    return directory.resolve(id + ".json");
  }

  private void deleteTranscript(String value) throws IOException {
    if (value == null || value.isBlank()) return;
    Path path = Path.of(value).toAbsolutePath().normalize();
    if (!path.getParent().equals(directory.toAbsolutePath().normalize()))
      throw new IllegalArgumentException("Task transcript is outside the managed directory");
    Files.deleteIfExists(path);
    Files.deleteIfExists(Path.of(path + ".gz"));
  }

  private void identifyMessages(AiTask task) {
    for (int index = 0; index < task.messages.size(); index++) {
      var message = task.messages.get(index);
      if (message.id != null && !message.id.isEmpty()) continue;
      // Match Node's legacy IDs without modifying the stored task on a GET.
      String source =
          String.join(
              "\u0000",
              Objects.toString(task.id, ""),
              String.valueOf(index),
              Objects.toString(message.role, ""),
              Objects.toString(message.createdAt, ""),
              Objects.toString(message.content, ""));
      try {
        message.id =
            "legacy-"
                + HexFormat.of()
                    .formatHex(
                        MessageDigest.getInstance("SHA-256")
                            .digest(source.getBytes(StandardCharsets.UTF_8)));
      } catch (NoSuchAlgorithmException impossible) {
        throw new IllegalStateException(impossible);
      }
    }
  }

  private TaskSummary summary(AiTask task) {
    int count = task.archivedMessageCount + task.messages.size();
    return new TaskSummary(
        task.id,
        task.scope,
        task.repositoryId,
        task.repositoryIds,
        task.title,
        task.provider,
        task.mode,
        task.model,
        task.effort,
        task.speed,
        Objects.toString(task.additionalProperties().get("contextMode"), "fresh"),
        count,
        task.messages.size(),
        task.archivedMessageCount,
        task.createdAt,
        task.updatedAt,
        task.transcriptPath,
        task.additionalProperties().get("revisionOf"),
        task.additionalProperties().get("revisionDraft"),
        TaskRevisionArchive.revisionCount(task));
  }
}
