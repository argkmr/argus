package com.argus.agents.controller;

import static org.mockito.Mockito.verify;

import com.argus.agents.service.AgentProviderService;
import org.junit.jupiter.api.Test;

class AgentProviderControllerTest {
  @Test
  void refreshesOnlyTheRequestedProvider() {
    AgentProviderService providers = org.mockito.Mockito.mock(AgentProviderService.class);
    AgentProviderController controller = new AgentProviderController(providers);

    controller.refresh("codex");

    verify(providers).refreshProvider("codex");
  }
}
