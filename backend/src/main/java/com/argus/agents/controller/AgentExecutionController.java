package com.argus.agents.controller;

import com.argus.agents.domain.CancellationRequest;
import com.argus.agents.service.AgentExecutionService;
import com.argus.agents.service.AgentRunService;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/agents")
public class AgentExecutionController {
  private final AgentExecutionService agents;
  private final AgentRunService runs;

  public AgentExecutionController(AgentExecutionService agents, AgentRunService runs) {
    this.agents = agents;
    this.runs = runs;
  }

  @PostMapping("/run")
  @ResponseStatus(HttpStatus.CREATED)
  public Map<String, Object> run(@RequestBody Map<String, Object> input) {
    return runs.run(input);
  }

  @PostMapping("/questions/answer")
  @ResponseStatus(HttpStatus.CREATED)
  public Map<String, Object> answerQuestion(@RequestBody Map<String, Object> input) {
    return runs.answerQuestion(input);
  }

  @PostMapping("/questions/cancel")
  public Map<String, Object> cancelQuestion(@RequestBody Map<String, Object> input) {
    return runs.cancelQuestion(input);
  }

  @DeleteMapping("/preparations/{id}")
  public Map<String, Object> preparation(
      @PathVariable String id,
      @RequestHeader(value = "X-Argus-Cancel-Control", required = false) String reportedControl) {
    return Map.of(
        "ok",
        true,
        "cancellation",
        runs.cancelPreparation(id, CancellationRequest.preparationRequest(reportedControl)));
  }

  @GetMapping("/jobs")
  public List<Map<String, Object>> jobs(@RequestParam(required = false) String repositoryId) {
    return agents.list(repositoryId);
  }

  @GetMapping("/cancellations")
  public List<Map<String, Object>> cancellations(@RequestParam(defaultValue = "200") int limit) {
    return agents.cancellations(limit);
  }

  @GetMapping("/jobs/{id}")
  public Map<String, Object> job(
      @PathVariable String id,
      @RequestParam(required = false) String afterOutput,
      @RequestParam(required = false) String afterError) {
    return agents.get(id, cursor(afterOutput), cursor(afterError));
  }

  private static Long cursor(String input) {
    if (input == null) return null;
    try {
      double value = input.isBlank() ? 0 : Double.parseDouble(input);
      return Double.isFinite(value)
              && Math.abs(value) <= 9007199254740991d
              && value == Math.rint(value)
          ? (long) value
          : null;
    } catch (NumberFormatException error) {
      return null;
    }
  }

  @DeleteMapping("/jobs/{id}")
  public Map<String, Object> stop(
      @PathVariable String id,
      @RequestHeader(value = "X-Argus-Cancel-Control", required = false) String reportedControl) {
    return Map.of(
        "ok", true, "job", agents.stop(id, CancellationRequest.jobRequest(reportedControl)));
  }

  @PostMapping("/jobs/{id}/pause")
  public Map<String, Object> pause(@PathVariable String id) {
    return agents.pause(id);
  }

  @PostMapping("/jobs/{id}/resume")
  public Map<String, Object> resume(@PathVariable String id) {
    return agents.resume(id);
  }
}
