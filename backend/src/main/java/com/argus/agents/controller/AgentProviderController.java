package com.argus.agents.controller;

import com.argus.agents.dto.AgentProvider;
import com.argus.agents.service.AgentProviderService;
import com.argus.common.constants.ApiRoutes;
import java.util.List;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(ApiRoutes.AGENT_PROVIDERS)
public class AgentProviderController {
  private final AgentProviderService providers;

  public AgentProviderController(AgentProviderService providers) {
    this.providers = providers;
  }

  @GetMapping
  public List<AgentProvider> list(@RequestParam(defaultValue = "false") boolean refresh) {
    return providers.providers(refresh);
  }

  @PostMapping("/{providerId}/refresh")
  public AgentProvider refresh(@PathVariable String providerId) {
    return providers.refreshProvider(providerId);
  }
}
