package com.argus.apiclient.controller;

import com.argus.apiclient.domain.ApiEnvironment;
import com.argus.apiclient.dto.EditableApiEnvironment;
import com.argus.apiclient.dto.SaveApiEnvironmentRequest;
import com.argus.apiclient.service.ApiEnvironmentService;
import com.argus.common.constants.ApiRoutes;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(ApiRoutes.API_ENVIRONMENTS)
public class ApiEnvironmentController {
  private final ApiEnvironmentService environments;

  public ApiEnvironmentController(ApiEnvironmentService environments) {
    this.environments = environments;
  }

  @GetMapping
  public List<ApiEnvironment> list() {
    return environments.list();
  }

  @PostMapping
  @ResponseStatus(HttpStatus.CREATED)
  public ApiEnvironment save(@RequestBody SaveApiEnvironmentRequest request) {
    return environments.save(request);
  }

  @GetMapping("/{id}")
  public EditableApiEnvironment get(@PathVariable String id) {
    return environments.editable(id);
  }

  @DeleteMapping("/{id}")
  public Map<String, Object> delete(@PathVariable String id) {
    return environments.delete(id);
  }
}
