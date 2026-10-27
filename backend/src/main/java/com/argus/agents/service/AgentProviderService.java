package com.argus.agents.service;

import com.argus.agents.dto.AgentProvider;
import com.argus.agents.repository.CliProviderAdapterRepository;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Service;

@Service
public class AgentProviderService {
  private final CliProviderAdapterRepository cliAdapters;
  private final CliProviderAdapterService cliAdapterService;
  private final AgentModelCatalogService modelCatalog;
  private List<AgentProvider> cache;
  private Instant cachedAt;

  public AgentProviderService(
      CliProviderAdapterRepository cliAdapters,
      CliProviderAdapterService cliAdapterService,
      AgentModelCatalogService modelCatalog) {
    this.cliAdapters = cliAdapters;
    this.cliAdapterService = cliAdapterService;
    this.modelCatalog = modelCatalog;
  }

  public synchronized List<AgentProvider> providers(boolean refresh) {
    if (!refresh && cache != null && cachedAt.plusSeconds(15).isAfter(Instant.now())) return cache;
    List<AgentProvider> detected = new ArrayList<>();
    cliAdapters
        .list()
        .forEach(
            adapter ->
                detected.add(
                    modelCatalog.enrich(
                        cliAdapterService.detectMetadata(adapter, refresh), refresh)));
    cache = List.copyOf(detected);
    cachedAt = Instant.now();
    return cache;
  }

  public AgentProvider refreshProvider(String providerId) {
    AgentProvider refreshed =
        cliAdapters.list().stream()
            .filter(adapter -> adapter.id().equals(providerId))
            .findFirst()
            .map(
                adapter ->
                    modelCatalog.enrich(cliAdapterService.detectMetadata(adapter, true), true))
            .orElseThrow(
                () ->
                    new IllegalArgumentException(
                        "Argus answer providers must be coding-agent CLIs"));
    updateCachedProvider(refreshed);
    return refreshed;
  }

  public synchronized void invalidate() {
    cache = null;
    cachedAt = null;
  }

  private synchronized void updateCachedProvider(AgentProvider refreshed) {
    String providerId = refreshed.id();
    List<AgentProvider> updated =
        cache == null ? new ArrayList<>(providers(false)) : new ArrayList<>(cache);
    updated.removeIf(provider -> provider.id().equals(providerId));
    List<String> orderedIds = new ArrayList<>();
    cliAdapters.list().forEach(adapter -> orderedIds.add(adapter.id()));
    int insertAt = orderedIds.indexOf(providerId);
    if (insertAt < 0 || insertAt > updated.size()) insertAt = updated.size();
    updated.add(insertAt, refreshed);
    cache = List.copyOf(updated);
    cachedAt = Instant.now();
  }
}
