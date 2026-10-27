package com.argus.platform;

import com.argus.agents.service.AgentExecutionService;
import com.argus.agents.service.AgentRunService;
import com.argus.runtime.service.ProcessManager;
import com.argus.terminal.service.TerminalService;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.SmartLifecycle;
import org.springframework.stereotype.Service;

/** One drain order for application shutdown and restore; no JavaScript callback is involved. */
@Service
public class BackendQuiescence implements SmartLifecycle {
  private final ObjectProvider<NativeBackgroundOwner> background;
  private final ObjectProvider<AgentRunService> requests;
  private final ObjectProvider<AgentExecutionService> agents;
  private final ObjectProvider<ProcessManager> processes;
  private final ObjectProvider<TerminalService> terminals;
  private volatile boolean running;

  public BackendQuiescence(
      ObjectProvider<NativeBackgroundOwner> background,
      ObjectProvider<AgentRunService> requests,
      ObjectProvider<AgentExecutionService> agents,
      ObjectProvider<ProcessManager> processes,
      ObjectProvider<TerminalService> terminals) {
    this.background = background;
    this.requests = requests;
    this.agents = agents;
    this.processes = processes;
    this.terminals = terminals;
  }

  public synchronized void quiesce() {
    List<Runnable> stops = new ArrayList<>();
    List<NativeBackgroundOwner> owners =
        background
            .orderedStream()
            .sorted(Comparator.comparingInt(NativeBackgroundOwner::shutdownOrder))
            .toList();
    owners.stream()
        .filter(owner -> owner.shutdownOrder() < 100)
        .forEach(owner -> stops.add(owner::quiesce));
    stops.add(() -> requests.ifAvailable(AgentRunService::stopAll));
    stops.add(() -> agents.ifAvailable(AgentExecutionService::stopAll));
    stops.add(() -> processes.ifAvailable(ProcessManager::stopAll));
    stops.add(() -> terminals.ifAvailable(TerminalService::stopAll));
    owners.stream()
        .filter(owner -> owner.shutdownOrder() >= 100)
        .forEach(owner -> stops.add(owner::quiesce));
    RuntimeException first = null;
    for (Runnable stop : stops)
      try {
        stop.run();
      } catch (RuntimeException failure) {
        if (first == null) first = failure;
        else first.addSuppressed(failure);
      }
    if (first != null) throw first;
    running = false;
  }

  @Override
  public void start() {
    running = true;
  }

  @Override
  public void stop() {
    quiesce();
  }

  @Override
  public boolean isRunning() {
    return running;
  }

  @Override
  public int getPhase() {
    return Integer.MAX_VALUE - 10;
  }
}
