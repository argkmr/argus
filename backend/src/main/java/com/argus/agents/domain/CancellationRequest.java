package com.argus.agents.domain;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Server-selected cancellation cause with optional, unverified UI context. */
public record CancellationRequest(
    Cause cause, String reportedControl, String runId, String preparationId) {
  private static final Set<String> REPORTED_CONTROLS =
      Set.of(
          "global-composer-stop",
          "repository-composer-stop",
          "ide-code-discussion-stop",
          "global-prompt-edit",
          "repository-prompt-edit",
          "global-question-cancel",
          "repository-question-cancel",
          "background-job-stop");

  public enum Cause {
    JOB_STOP_REQUEST,
    PREPARATION_STOP_REQUEST,
    QUESTION_CANCEL_REQUEST,
    APPLICATION_SHUTDOWN,
    REPOSITORY_REMOVED,
    BACKGROUND_CANCEL,
    BACKGROUND_SHUTDOWN,
    INTERNAL_STOP
  }

  public CancellationRequest {
    cause = cause == null ? Cause.INTERNAL_STOP : cause;
    reportedControl =
        clientRequest(cause)
                && REPORTED_CONTROLS.contains(reportedControl == null ? "" : reportedControl)
            ? reportedControl
            : "unspecified";
    runId = safeId(runId);
    preparationId = safeId(preparationId);
  }

  public CancellationRequest(Cause cause, String reportedControl, String runId) {
    this(cause, reportedControl, runId, "");
  }

  public static CancellationRequest jobRequest(String reportedControl) {
    return new CancellationRequest(Cause.JOB_STOP_REQUEST, reportedControl, "");
  }

  public static CancellationRequest preparationRequest(String reportedControl) {
    return new CancellationRequest(Cause.PREPARATION_STOP_REQUEST, reportedControl, "");
  }

  public static CancellationRequest questionRequest(String reportedControl) {
    return new CancellationRequest(Cause.QUESTION_CANCEL_REQUEST, reportedControl, "");
  }

  public static CancellationRequest internal(Cause cause) {
    return new CancellationRequest(cause, "unspecified", "");
  }

  public CancellationRequest withPreparationId(String preparationId) {
    return new CancellationRequest(cause, reportedControl, runId, preparationId);
  }

  public Map<String, Object> provenance(String jobId, String explicitRunId) {
    var result = new LinkedHashMap<String, Object>();
    result.put("id", UUID.randomUUID().toString());
    result.put("requestedAt", Instant.now().toString());
    result.put("cause", cause.name().toLowerCase(Locale.ROOT));
    result.put(
        "route",
        switch (cause) {
          case JOB_STOP_REQUEST -> "DELETE /api/agents/jobs/{id}";
          case PREPARATION_STOP_REQUEST -> "DELETE /api/agents/preparations/{id}";
          case QUESTION_CANCEL_REQUEST -> "POST /api/agents/questions/cancel";
          default -> "internal";
        });
    result.put("reportedControl", reportedControl);
    result.put(
        "attribution",
        !clientRequest(cause)
            ? "internal"
            : "unspecified".equals(reportedControl)
                ? "unattributed_client"
                : "reported_ui_context");
    result.put("jobId", safeId(jobId));
    result.put(
        "runId", explicitRunId == null || explicitRunId.isBlank() ? runId : safeId(explicitRunId));
    if (!preparationId.isEmpty()) result.put("preparationId", preparationId);
    return result;
  }

  public static String safeId(String value) {
    return value != null && value.length() <= 128 && value.matches("[A-Za-z0-9][A-Za-z0-9_-]*")
        ? value
        : "";
  }

  private static boolean clientRequest(Cause cause) {
    return cause == Cause.JOB_STOP_REQUEST
        || cause == Cause.QUESTION_CANCEL_REQUEST
        || cause == Cause.PREPARATION_STOP_REQUEST;
  }
}
