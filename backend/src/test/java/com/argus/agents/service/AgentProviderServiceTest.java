package com.argus.agents.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.argus.agents.domain.CliProviderAdapter;
import com.argus.agents.dto.AgentProvider;
import com.argus.agents.dto.ProviderAvailability;
import com.argus.agents.repository.CliProviderAdapterRepository;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class AgentProviderServiceTest {
  @Test
  void refreshingProviderMetadataNeverRunsAPaidCompletionProbe() {
    CliProviderAdapterRepository adapters = new CliProviderAdapterRepository(new ObjectMapper());
    CliProviderAdapterService detection = mock(CliProviderAdapterService.class);
    AgentModelCatalogService catalogs = mock(AgentModelCatalogService.class);
    AgentProvider codex = provider("codex");
    AgentProvider claude = provider("claude");
    for (CliProviderAdapter adapter : adapters.list()) {
      AgentProvider result = "codex".equals(adapter.id()) ? codex : claude;
      when(detection.detectMetadata(adapter, true)).thenReturn(result);
      when(catalogs.enrich(result, true)).thenReturn(result);
    }
    AgentProviderService providers = new AgentProviderService(adapters, detection, catalogs);

    assertThat(providers.providers(true)).isEqualTo(List.of(codex, claude));
    assertThat(providers.refreshProvider("codex")).isEqualTo(codex);

    verify(detection, never()).detect(any(), eq(true));
    verify(detection, org.mockito.Mockito.times(2)).detectMetadata(adapters.list().get(0), true);
    verify(catalogs, org.mockito.Mockito.times(2)).enrich(codex, true);
  }

  private AgentProvider provider(String id) {
    return new AgentProvider(
        id,
        id,
        true,
        "1",
        "/test/cli",
        true,
        "CLI-managed",
        ProviderAvailability.unknown(),
        true,
        false,
        false,
        "cli",
        List.of(),
        "",
        true,
        true,
        false,
        false,
        List.of("file"),
        List.of(),
        "unavailable");
  }
}
