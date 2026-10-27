package com.argus.tasks.domain;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class AiTask {
  public String id;
  public String scope;
  public String repositoryId;
  public List<String> repositoryIds = new ArrayList<>();
  public String title;
  public String provider;
  public String mode;
  public String model;
  public String effort;
  public String speed;
  public String modelSettingsSavedAt;
  public String createdAt;
  public String updatedAt;
  public List<TaskMessage> messages = new ArrayList<>();
  public List<Map<String, Object>> promptNotes = new ArrayList<>();
  // Navigation-only snapshots: never merged into the model's working conversation.
  public List<TaskCheckpoint> checkpoints = new ArrayList<>();
  public long checkpointRevision;
  public String rollingContext = "";
  public int archivedMessageCount;
  public List<String> completedJobIds = new ArrayList<>();
  public String transcriptPath;

  // Preserve session, revision, and future metadata in the shared on-disk task contract.
  private final Map<String, Object> additionalProperties = new LinkedHashMap<>();

  @JsonAnySetter
  public void preserveAdditionalProperty(String name, Object value) {
    additionalProperties.put(name, value);
  }

  @JsonAnyGetter
  public Map<String, Object> additionalProperties() {
    return additionalProperties;
  }
}
