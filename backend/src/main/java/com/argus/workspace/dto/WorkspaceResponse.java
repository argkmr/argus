package com.argus.workspace.dto;

import com.argus.workspace.domain.Repository;
import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonIgnore;
import java.util.List;
import java.util.Map;

public record WorkspaceResponse(
    int version,
    String activeRepositoryId,
    Map<String, Object> preferences,
    List<Repository> repositories,
    List<Map<String, Object>> runConfigurations,
    List<Map<String, Object>> apiRequests,
    Map<String, Map<String, Object>> javaProjectSettings,
    @JsonIgnore Map<String, Object> extraFields) {
  public WorkspaceResponse(
      int version,
      String activeRepositoryId,
      Map<String, Object> preferences,
      List<Repository> repositories,
      List<Map<String, Object>> runConfigurations,
      List<Map<String, Object>> apiRequests,
      Map<String, Map<String, Object>> javaProjectSettings) {
    this(
        version,
        activeRepositoryId,
        preferences,
        repositories,
        runConfigurations,
        apiRequests,
        javaProjectSettings,
        Map.of());
  }

  @JsonAnyGetter
  public Map<String, Object> additionalProperties() {
    return extraFields;
  }
}
