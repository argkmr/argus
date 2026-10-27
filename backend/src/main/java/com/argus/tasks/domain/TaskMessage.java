package com.argus.tasks.domain;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public class TaskMessage {
  private final java.util.Map<String, Object> additionalProperties =
      new java.util.LinkedHashMap<>();

  @com.fasterxml.jackson.annotation.JsonAnySetter
  public void preserveAdditionalProperty(String name, Object value) {
    additionalProperties.put(name, value);
  }

  @com.fasterxml.jackson.annotation.JsonAnyGetter
  public java.util.Map<String, Object> additionalProperties() {
    return additionalProperties;
  }

  public String id;
  public String role;
  public String content;
  public List<Map<String, Object>> attachments = new ArrayList<>();
  public String provider;
  public String status;
  public Map<String, Object> execution;
  public String createdAt;
}
