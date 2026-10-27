package com.argus.tasks.dto;

import java.util.List;

public record TaskSummary(
    String id,
    String scope,
    String repositoryId,
    List<String> repositoryIds,
    String title,
    String provider,
    String mode,
    String model,
    String effort,
    String speed,
    String contextMode,
    int messageCount,
    int visibleMessageCount,
    int archivedMessageCount,
    String createdAt,
    String updatedAt,
    String transcriptPath,
    Object revisionOf,
    Object revisionDraft,
    Long revisionCount) {
  public TaskSummary {
    revisionCount = revisionCount == null ? 0L : revisionCount;
  }
}
