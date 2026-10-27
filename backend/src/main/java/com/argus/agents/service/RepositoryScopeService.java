package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;

import com.argus.common.error.ConflictException;
import com.argus.tasks.domain.AiTask;
import com.argus.workspace.domain.Repository;
import java.util.*;
import org.springframework.stereotype.Service;

@Service
public class RepositoryScopeService {
  public record Scope(List<String> requestedIds, List<Repository> repositories) {}

  public Scope resolve(List<Repository> connected, Object requested) {
    var selected =
        validIds(requested == null ? List.of() : requested, "Repository IDs must be an array")
            .stream()
            .distinct()
            .toList();
    if (selected.size() > 6)
      throw new IllegalArgumentException("Select up to 6 repositories for a Nexus request");
    List<Repository> repositories =
        selected.isEmpty()
            ? List.copyOf(connected)
            : selected.stream()
                .map(
                    id ->
                        connected.stream()
                            .filter(repository -> id.equals(repository.id()))
                            .findFirst()
                            .orElseThrow(
                                () ->
                                    new IllegalArgumentException(
                                        "A selected repository is no longer connected")))
                .toList();
    return new Scope(selected, repositories);
  }

  public Scope revision(AiTask task, List<Repository> connected, Object requested) {
    if (task == null
        || !truth(obj(task.additionalProperties().get("revisionOf")).get("pending"))
        || !"global".equals(task.scope)) return null;
    var saved = task.repositoryIds;
    if (saved == null
        || saved.isEmpty()
        || saved.stream().anyMatch(id -> id == null || id.isEmpty())
        || new HashSet<>(saved).size() != saved.size())
      throw new ConflictException("This revision has no valid saved repository scope");
    var selected =
        validIds(requested == null ? List.of() : requested, "Repository IDs must be an array");
    if (!selected.isEmpty()
        && (selected.size() != saved.size()
            || new HashSet<>(selected).size() != saved.size()
            || !saved.containsAll(selected)))
      throw new ConflictException("A revision must use exactly its original repository selection");
    return new Scope(
        List.copyOf(saved),
        exact(
            connected,
            saved,
            "A repository saved for this revision is no longer connected. Reopen Edit and select connected repositories before resending"));
  }

  /** Validate an explicit revision selection without silently replacing disconnected identities. */
  public List<String> revisionSelection(
      List<String> saved, List<Repository> connected, Map<String, Object> input) {
    if (input.containsKey("repositoryIds") || input.containsKey("expectedRepositoryIds")) {
      var expected =
          validIds(
              input.get("expectedRepositoryIds"), "The saved repository selection is required");
      if (!Objects.equals(saved, expected))
        throw new ConflictException(
            "This revision's repository selection changed; reload the chat before saving");
    }
    if (input.containsKey("repositoryIds")) {
      var requested = validIds(input.get("repositoryIds"), "Repository IDs must be an array");
      // Historical automatic scopes may contain more than the ordinary explicit-selection limit.
      if (!requested.isEmpty() && requested.equals(saved))
        return savedRevisionSelection(saved, connected);
      var selected =
          resolve(connected, requested).repositories().stream().map(Repository::id).toList();
      if (selected.isEmpty())
        throw new ConflictException(
            "Connect a repository, then select it before saving this revision");
      return selected;
    }
    return savedRevisionSelection(saved, connected);
  }

  private List<String> savedRevisionSelection(List<String> saved, List<Repository> connected) {
    if (saved == null
        || saved.isEmpty()
        || saved.stream().anyMatch(id -> id == null || id.isEmpty())
        || new HashSet<>(saved).size() != saved.size())
      throw new ConflictException(
          "Select connected repositories before saving this revision; its saved repository selection is unavailable");
    exact(
        connected,
        saved,
        "An original repository is no longer connected. Select connected repositories in Edit before saving this revision");
    return List.copyOf(saved);
  }

  public Scope queued(Map<String, Object> queued, List<Repository> connected, Object requested) {
    if (queued == null || !"global".equals(queued.get("scope"))) return null;
    List<String> saved;
    try {
      saved = validIds(queued.get("repositoryIds"), "");
    } catch (RuntimeException error) {
      throw new ConflictException(
          "This queued Nexus request has no safe saved repository scope. Remove it and queue the request again.");
    }
    if (saved.isEmpty() || new HashSet<>(saved).size() != saved.size())
      throw new ConflictException(
          "This queued Nexus request has no safe saved repository scope. Remove it and queue the request again.");
    if (!saved.equals(validIds(requested, "The queued Nexus repository selection changed")))
      throw new IllegalArgumentException("The queued Nexus repository selection changed");
    return new Scope(
        List.copyOf(saved),
        exact(connected, saved, "An original queued repository is no longer connected"));
  }

  /** An answer inherits the server-recorded question scope, including Nexus auto-selection. */
  public Scope questionReply(List<Repository> connected, Object savedIds) {
    var saved = validIds(savedIds, "The question's original repository scope is unavailable");
    if (saved.isEmpty() || new HashSet<>(saved).size() != saved.size())
      throw new ConflictException("The question has no safe saved repository scope");
    return new Scope(
        List.copyOf(saved),
        exact(
            connected,
            saved,
            "An original repository is no longer connected; reconnect it before replying"));
  }

  private List<Repository> exact(List<Repository> connected, List<String> saved, String error) {
    return saved.stream()
        .map(
            id ->
                connected.stream()
                    .filter(repository -> id.equals(repository.id()))
                    .findFirst()
                    .orElseThrow(() -> new ConflictException(error)))
        .toList();
  }

  private List<String> validIds(Object value, String error) {
    if (!(value instanceof List<?> list)
        || list.stream().anyMatch(id -> !(id instanceof String) || ((String) id).isEmpty()))
      throw new IllegalArgumentException(error);
    return list.stream().map(Object::toString).toList();
  }

  public Map<String, Object> freeze(
      AiTask task, Map<String, Object> request, List<Repository> connected) {
    var input = new LinkedHashMap<>(request);
    if (!"global".equals(task.scope)) {
      input.put("scope", "repository");
      input.put("repositoryIds", List.of());
      return input;
    }
    var requested =
        validIds(input.get("repositoryIds"), "Queued Nexus repository IDs must be an array");
    var selected = resolve(connected, requested);
    if (selected.repositories().isEmpty())
      throw new IllegalArgumentException("Connect a repository before queueing a Nexus prompt");
    input.put("scope", "global");
    input.put("repositoryIds", selected.repositories().stream().map(Repository::id).toList());
    return input;
  }
}
