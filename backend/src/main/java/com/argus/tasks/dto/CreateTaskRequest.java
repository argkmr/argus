package com.argus.tasks.dto;

import java.util.List;

public record CreateTaskRequest(
    String scope,
    String repositoryId,
    List<String> repositoryIds,
    String title,
    String provider,
    String mode,
    String model,
    String effort,
    String speed) {}
