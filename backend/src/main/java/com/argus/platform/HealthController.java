package com.argus.platform;

import com.argus.common.config.ArgusProperties;
import com.argus.common.constants.ApiRoutes;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthController {
  private final String build;

  public HealthController(ArgusProperties properties) {
    this.build = properties.buildId();
  }

  @GetMapping(ApiRoutes.HEALTH)
  public Map<String, String> health() {
    return Map.of(
        "status",
        "ready",
        "frontend",
        "nextjs",
        "backend",
        "spring-boot",
        "build",
        build,
        "pid",
        Long.toString(ProcessHandle.current().pid()));
  }
}
