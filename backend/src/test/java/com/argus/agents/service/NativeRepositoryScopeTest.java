package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;
import static org.assertj.core.api.Assertions.*;

import com.argus.tasks.domain.AiTask;
import com.argus.workspace.domain.Repository;
import java.util.*;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;

class NativeRepositoryScopeTest {
  RepositoryScopeService scopes = new RepositoryScopeService();
  List<Repository> repositories =
      IntStream.range(0, 8)
          .mapToObj(i -> new Repository("repo-" + i, "Repo " + i, "/fixture/" + i, "", "main"))
          .toList();

  @Test
  void autoScopeFreezesAllWhileExplicitOrdinaryScopeKeepsSixLimit() {
    var task = new AiTask();
    task.scope = "global";
    var queued = scopes.freeze(task, fields("repositoryIds", List.of()), repositories);
    assertThat(list(queued.get("repositoryIds"))).hasSize(8);
    assertThat(scopes.queued(queued, repositories, queued.get("repositoryIds")).repositories())
        .hasSize(8);
    assertThatThrownBy(
            () -> scopes.resolve(repositories, repositories.stream().map(Repository::id).toList()))
        .hasMessageContaining("6");
  }

  @Test
  void pendingRevisionNeverExpandsToNewOrMissingRepositories() {
    var task = new AiTask();
    task.scope = "global";
    task.repositoryIds = new ArrayList<>(repositories.stream().map(Repository::id).toList());
    task.additionalProperties().put("revisionOf", fields("pending", true));
    assertThat(scopes.revision(task, repositories, List.of()).repositories()).hasSize(8);
    assertThatThrownBy(() -> scopes.revision(task, repositories.subList(0, 7), List.of()))
        .hasMessageContaining("no longer connected");
    assertThatThrownBy(() -> scopes.revision(task, repositories, List.of("repo-0")))
        .hasMessageContaining("exactly");
    var queued = fields("scope", "global", "repositoryIds", List.of("repo-0", "repo-1"));
    assertThatThrownBy(() -> scopes.queued(queued, repositories, List.of("repo-1", "repo-0")))
        .hasMessageContaining("changed");
  }
}
