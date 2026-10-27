package com.argus.workspace.domain;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class Workspace {
  public int version = 1;
  public String activeRepositoryId;
  public Map<String, Object> preferences = new LinkedHashMap<>(Map.of("gitView", "changes"));
  public List<Repository> repositories = new ArrayList<>();

  /** Saved identities only: these are not active connections and never auto-onboard. */
  public List<Repository> disconnectedRepositories = new ArrayList<>();

  public List<Map<String, Object>> runConfigurations = new ArrayList<>();
  public List<Map<String, Object>> apiRequests = new ArrayList<>();
  public Map<String, Map<String, Object>> javaProjectSettings = new LinkedHashMap<>();
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
