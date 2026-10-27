package com.argus.onboarding.service;

import com.argus.agents.service.AgentExecutionService;
import com.argus.agents.service.AgentRunService;
import com.argus.codediscussions.service.CodeDiscussionService;
import com.argus.git.service.GitFileRevertService;
import com.argus.ide.IdeService;
import com.argus.ide.debug.DebugService;
import com.argus.runtime.service.ProcessManager;
import com.argus.tasks.service.PromptQueueService;
import com.argus.terminal.service.TerminalService;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

/** Disconnect a workspace connection, never delete user data or cross-repository history. */
@Service
public class RepositoryDisconnectService {
  private final ObjectProvider<RepositoryOnboardingService> onboarding;
  private final AiKitGenerationService kits;
  private final AgentRunService preparation;
  private final AgentExecutionService agents;
  private final ProcessManager processes;
  private final TerminalService terminals;
  private final PromptQueueService prompts;
  private final GitFileRevertService git;
  private final IdeService ide;
  private final DebugService debugger;
  private final CodeDiscussionService discussions;
  private final WorkspaceService workspace;

  public RepositoryDisconnectService(
      ObjectProvider<RepositoryOnboardingService> onboarding,
      AiKitGenerationService kits,
      AgentRunService preparation,
      AgentExecutionService agents,
      ProcessManager processes,
      TerminalService terminals,
      PromptQueueService prompts,
      GitFileRevertService git,
      IdeService ide,
      DebugService debugger,
      CodeDiscussionService discussions,
      WorkspaceService workspace) {
    this.onboarding = onboarding;
    this.kits = kits;
    this.preparation = preparation;
    this.agents = agents;
    this.processes = processes;
    this.terminals = terminals;
    this.prompts = prompts;
    this.git = git;
    this.ide = ide;
    this.debugger = debugger;
    this.discussions = discussions;
    this.workspace = workspace;
  }

  public Map<String, Object> disconnectRepository(Repository repository) {
    return disconnectRepository(repository, false);
  }

  Map<String, Object> disconnectRepository(Repository repository, boolean skipCurrentOnboarding) {
    var ids = List.of(repository.id());
    discussions.retireRepository(repository.id());
    prompts.pauseRepositories(ids);
    if (!skipCurrentOnboarding) onboarding.getObject().cancelRepositories(ids);
    ide.disconnectRepository(repository.id());
    debugger.disconnectRepository(repository.id());
    kits.disconnectRepositories(ids);
    preparation.disconnectRepositories(ids);
    // Normal cancellation persists final partial replies and CLI context before removal.
    agents.disconnectRepositories(ids);
    git.disconnectRepositories(ids);
    terminals.disconnectRepository(repository.id());
    processes.disconnectRepositories(ids);
    // Commit the connection change only after every active producer has drained.
    workspace.disconnect(repository.id());
    return Map.of(
        "repositoryId",
        repository.id(),
        "repositoryName",
        repository.name(),
        "sourceRepositoryDeleted",
        false,
        "dataPreserved",
        true);
  }

  /** Called only following an explicit, successful registration; never on startup. */
  public void reconnectRepository(String id) {
    workspace.requireRepository(id);
    var ids = List.of(id);
    preparation.releaseRetiredRepositories(ids);
    agents.releaseRetiredRepositories(ids);
    git.releaseRetiredRepositories(ids);
    processes.releaseRetiredRepositories(ids);
    terminals.releaseRepository(id);
    ide.releaseRepository(id);
    debugger.releaseRepository(id);
    discussions.releaseRepository(id);
    kits.allowRepositories(ids);
  }
}
