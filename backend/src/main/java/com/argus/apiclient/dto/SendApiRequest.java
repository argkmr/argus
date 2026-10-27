package com.argus.apiclient.dto;

import java.util.List;
import java.util.Map;

public record SendApiRequest(
    String repositoryId,
    String environmentId,
    String method,
    String url,
    Map<String, Object> headers,
    String body,
    Map<String, Object> variables,
    List<Map<String, Object>> pathVariables,
    List<Map<String, Object>> queryParams,
    Map<String, Object> postman) {
  public SendApiRequest(
      String repositoryId,
      String environmentId,
      String method,
      String url,
      Map<String, Object> headers,
      String body,
      Map<String, Object> variables) {
    this(repositoryId, environmentId, method, url, headers, body, variables, List.of(), null, null);
  }
}
