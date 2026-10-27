package com.argus.platform;

import com.argus.common.constants.ApiRoutes;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
public class SpaController {
  @GetMapping(
      value = {
        ApiRoutes.SPA_DAILY_TASKS,
        ApiRoutes.SPA_DIAGRAM_STUDIO,
        ApiRoutes.SPA_SERVICES,
        ApiRoutes.SPA_API_CLIENT,
        ApiRoutes.SPA_GLOBAL_AI,
        ApiRoutes.SPA_AI_CONNECTIONS,
        ApiRoutes.SPA_REPOSITORIES
      })
  public String app() {
    return "forward:/index.html";
  }
}
