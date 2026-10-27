package com.argus.terminal.controller;

import com.argus.common.constants.ApiRoutes;
import com.argus.terminal.dto.TerminalInputRequest;
import com.argus.terminal.dto.TerminalResizeRequest;
import com.argus.terminal.dto.TerminalResponse;
import com.argus.terminal.dto.TerminalSessionRequest;
import com.argus.terminal.service.TerminalService;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(ApiRoutes.REPOSITORY_TERMINAL)
public class TerminalController {
  private final TerminalService terminals;
  private final WorkspaceService workspace;

  public TerminalController(TerminalService terminals, WorkspaceService workspace) {
    this.terminals = terminals;
    this.workspace = workspace;
  }

  private Repository repository(String id) {
    return workspace.requireRepository(id);
  }

  @GetMapping
  public TerminalResponse status(
      @PathVariable String repositoryId, @RequestParam(defaultValue = "0") long after) {
    return terminals.status(repository(repositoryId), after);
  }

  @PostMapping("/start")
  @ResponseStatus(HttpStatus.CREATED)
  public TerminalResponse start(@PathVariable String repositoryId) {
    return terminals.start(repository(repositoryId));
  }

  @PostMapping("/input")
  public TerminalResponse input(
      @PathVariable String repositoryId, @RequestBody TerminalInputRequest request) {
    repository(repositoryId);
    return terminals.write(repositoryId, request.sessionId(), request.input());
  }

  @PostMapping("/resize")
  public TerminalResponse resize(
      @PathVariable String repositoryId, @RequestBody TerminalResizeRequest request) {
    repository(repositoryId);
    return terminals.resize(repositoryId, request.sessionId(), request.cols(), request.rows());
  }

  @PostMapping("/clear")
  public TerminalResponse clear(
      @PathVariable String repositoryId, @RequestBody TerminalSessionRequest request) {
    repository(repositoryId);
    return terminals.clear(repositoryId, request.sessionId());
  }

  @PostMapping("/stop")
  public TerminalResponse stop(
      @PathVariable String repositoryId, @RequestBody TerminalSessionRequest request) {
    repository(repositoryId);
    return terminals.stop(repositoryId, request.sessionId());
  }

  @PostMapping("/purge")
  public Map<String, Object> purge(@PathVariable String repositoryId) {
    // Offboarding must await this before unregistering, but retries remain safe
    // even if an earlier cleanup already removed the workspace entry.
    terminals.purge(repositoryId);
    return Map.of("ok", true, "repositoryId", repositoryId);
  }
}
