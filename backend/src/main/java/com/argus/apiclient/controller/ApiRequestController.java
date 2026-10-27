package com.argus.apiclient.controller;

import com.argus.apiclient.dto.ApiResponse;
import com.argus.apiclient.dto.SendApiRequest;
import com.argus.apiclient.service.ApiEnvironmentService;
import com.argus.apiclient.service.ApiRequestService;
import com.argus.common.constants.ApiRoutes;
import com.argus.workspace.service.WorkspaceService;
import java.util.Map;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(ApiRoutes.API_REQUESTS)
public class ApiRequestController {
  private final ApiRequestService requests;
  private final ApiEnvironmentService environments;
  private final WorkspaceService workspace;

  public ApiRequestController(
      ApiRequestService requests, ApiEnvironmentService environments, WorkspaceService workspace) {
    this.requests = requests;
    this.environments = environments;
    this.workspace = workspace;
  }

  @PostMapping("/send")
  public ApiResponse send(@RequestBody SendApiRequest request) {
    validateRepository(request.repositoryId());
    return requests.send(request, environment(request.environmentId()));
  }

  @PostMapping("/curl")
  public Map<String, Object> curl(@RequestBody SendApiRequest request) {
    validateRepository(request.repositoryId());
    var environment =
        request.environmentId() == null ? null : environments.require(request.environmentId());
    return Map.of(
        "curl",
        requests.curl(request, environment == null ? Map.of() : environment.values()),
        "environmentName",
        environment == null ? "" : environment.name());
  }

  private Map<String, String> environment(String id) {
    return id == null || id.isBlank() ? Map.of() : environments.require(id).values();
  }

  private void validateRepository(String id) {
    if (id != null
        && !id.isBlank()
        && !"standalone".equals(id)
        && !"standalone-api-client".equals(id)) workspace.requireRepository(id);
  }
}
