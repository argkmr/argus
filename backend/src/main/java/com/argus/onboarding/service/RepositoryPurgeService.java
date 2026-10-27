package com.argus.onboarding.service;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.agents.service.AgentExecutionService;
import com.argus.agents.service.AgentRunService;
import com.argus.apiclient.service.ApiCollectionService;
import com.argus.background.service.AiKitRefreshQueue;
import com.argus.background.service.BackgroundJobService;
import com.argus.context.service.ContextService;
import com.argus.ide.IdeService;
import com.argus.ide.debug.DebugService;
import com.argus.repositorycontext.service.RepositoryBriefService;
import com.argus.repositorycontext.service.RepositoryContextService;
import com.argus.runtime.service.ProcessManager;
import com.argus.runtime.service.RuntimeConfigurationService;
import com.argus.tasks.service.PromptQueueService;
import com.argus.tasks.service.TaskService;
import com.argus.terminal.service.TerminalService;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

/** Drain every producer before deleting its owned data. Never delete the source repository. */
@Service
public class RepositoryPurgeService {
  private final ObjectProvider<RepositoryOnboardingService> onboarding;
  private final AiKitGenerationService kits;
  private final AgentRunService preparation;
  private final AgentExecutionService agents;
  private final ProcessManager processes;
  private final TerminalService terminals;
  private final PromptQueueService prompts;
  private final AiKitRefreshQueue refresh;
  private final RuntimeConfigurationService configurations;
  private final TaskService tasks;
  private final ContextService contexts;
  private final ApiCollectionService collections;
  private final RepositoryContextService repositoryContexts;
  private final RepositoryBriefService briefs;
  private final BackgroundJobService jobs;
  private final WorkspaceService workspace;
  private final com.argus.git.service.GitFileRevertService gitReverts;
  private final IdeService ide;
  private final DebugService debugger;
  private com.argus.codediscussions.service.CodeDiscussionService codeDiscussions;

  @org.springframework.beans.factory.annotation.Autowired
  public void setCodeDiscussions(
      com.argus.codediscussions.service.CodeDiscussionService codeDiscussions) {
    this.codeDiscussions = codeDiscussions;
  }

  public RepositoryPurgeService(
      ObjectProvider<RepositoryOnboardingService> onboarding,
      AiKitGenerationService kits,
      AgentRunService preparation,
      AgentExecutionService agents,
      ProcessManager processes,
      TerminalService terminals,
      PromptQueueService prompts,
      AiKitRefreshQueue refresh,
      RuntimeConfigurationService configurations,
      TaskService tasks,
      ContextService contexts,
      ApiCollectionService collections,
      RepositoryContextService repositoryContexts,
      RepositoryBriefService briefs,
      BackgroundJobService jobs,
      WorkspaceService workspace,
      com.argus.git.service.GitFileRevertService gitReverts,
      IdeService ide,
      DebugService debugger) {
    this.onboarding = onboarding;
    this.kits = kits;
    this.preparation = preparation;
    this.agents = agents;
    this.processes = processes;
    this.terminals = terminals;
    this.prompts = prompts;
    this.refresh = refresh;
    this.configurations = configurations;
    this.tasks = tasks;
    this.contexts = contexts;
    this.collections = collections;
    this.repositoryContexts = repositoryContexts;
    this.briefs = briefs;
    this.jobs = jobs;
    this.workspace = workspace;
    this.gitReverts = gitReverts;
    this.ide = ide;
    this.debugger = debugger;
  }

  public Map<String, Object> purgeRepository(Repository repository, String jobId) {
    return purgeRepository(repository, jobId, false);
  }

  public Map<String, Object> purgeRepository(
      Repository repository, String jobId, boolean skipCurrentOnboarding) {
    var ids = List.of(repository.id());
    if (codeDiscussions != null) codeDiscussions.retireRepository(repository.id());
    var result =
        object(
            "repositoryId",
            repository.id(),
            "repositoryName",
            repository.name(),
            "sourceRepositoryDeleted",
            false);
    if (!skipCurrentOnboarding) onboarding.getObject().cancelRepositories(ids);
    ide.stopRepository(repository.id());
    debugger.stopRepository(repository.id());
    kits.cancelRepositories(ids);
    result.putAll(preparation.purgeRepositories(ids));
    result.putAll(agents.purgeRepositories(ids));
    result.putAll(gitReverts.purgeRepositories(ids));
    terminals.purge(repository.id());
    result.putAll(processes.purgeRepositories(ids));
    prompts.purgeRepositories(ids);
    refresh.purgeRepositories(ids);
    result.putAll(configurations.purgeRepositories(ids));
    var removedTasks = tasks.purgeRepositories(ids);
    result.put("tasksDeleted", removedTasks.get("tasksDeleted"));
    result.putAll(contexts.purgeRepositories(ids, strings(removedTasks.get("attachmentIds"))));
    result.putAll(collections.purgeRepository(repository));
    result.putAll(repositoryContexts.purgeRepository(repository));
    result.put("briefsDeleted", briefs.purge(repository));
    result.putAll(jobs.purgeRepositories(ids, jobId));
    workspace.remove(repository.id());
    preparation.releaseRetiredRepositories(ids);
    agents.releaseRetiredRepositories(ids);
    gitReverts.releaseRetiredRepositories(ids);
    if (codeDiscussions != null) codeDiscussions.releaseRepository(repository.id());
    return result;
  }
}
