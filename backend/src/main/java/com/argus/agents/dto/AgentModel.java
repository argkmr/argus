package com.argus.agents.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

public record AgentModel(
    String id,
    String displayName,
    String description,
    List<ReasoningEffort> supportedReasoningEfforts,
    String defaultReasoningEffort,
    boolean isDefault,
    @JsonInclude(JsonInclude.Include.NON_NULL) Boolean supportsFastMode,
    @JsonInclude(JsonInclude.Include.NON_EMPTY) String resolvedModel) {
  public AgentModel(
      String id,
      String displayName,
      String description,
      List<ReasoningEffort> supportedReasoningEfforts,
      String defaultReasoningEffort,
      boolean isDefault,
      Boolean supportsFastMode) {
    this(
        id,
        displayName,
        description,
        supportedReasoningEfforts,
        defaultReasoningEffort,
        isDefault,
        supportsFastMode,
        "");
  }

  public record ReasoningEffort(String effort, String description) {}
}
