package com.argus.workspace.domain;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/** Canonical persisted repository, including fields written by older/newer versions. */
public final class Repository {
  public final String id;
  public final String name;
  public final String path;
  public final String addedAt;
  public String productionBranch;
  private final Map<String, Object> additionalProperties = new LinkedHashMap<>();

  @JsonCreator
  public Repository(
      @JsonProperty("id") String id,
      @JsonProperty("name") String name,
      @JsonProperty("path") String path,
      @JsonProperty("addedAt") String addedAt,
      @JsonProperty("productionBranch") String productionBranch) {
    this.id = id;
    this.name = name;
    this.path = path;
    this.addedAt = addedAt;
    this.productionBranch = productionBranch == null ? "" : productionBranch.trim();
  }

  public Repository(String id, String name, String path, String addedAt) {
    this(id, name, path, addedAt, "");
  }

  public String id() {
    return id;
  }

  public String name() {
    return name;
  }

  public String path() {
    return path;
  }

  public String addedAt() {
    return addedAt;
  }

  public String productionBranch() {
    return productionBranch;
  }

  @JsonAnySetter
  public void preserveAdditionalProperty(String name, Object value) {
    additionalProperties.put(name, value);
  }

  @JsonAnyGetter
  public Map<String, Object> additionalProperties() {
    return additionalProperties;
  }

  @Override
  public boolean equals(Object value) {
    return value instanceof Repository other
        && Objects.equals(id, other.id)
        && Objects.equals(name, other.name)
        && Objects.equals(path, other.path)
        && Objects.equals(addedAt, other.addedAt)
        && Objects.equals(productionBranch, other.productionBranch)
        && additionalProperties.equals(other.additionalProperties);
  }

  @Override
  public int hashCode() {
    return Objects.hash(id, name, path, addedAt, productionBranch, additionalProperties);
  }
}
