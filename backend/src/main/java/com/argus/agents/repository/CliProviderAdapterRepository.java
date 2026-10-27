package com.argus.agents.repository;

import com.argus.agents.domain.CliProviderAdapter;
import com.argus.common.process.CodexExecutableSelector;
import com.argus.common.process.ExecutableDiscovery;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

@Repository
public class CliProviderAdapterRepository {
  private final ObjectMapper mapper;
  private final String codexExecutable;
  private final CodexExecutableSelector selector;
  private final Map<String, String> environment;
  private final Path home;

  @Autowired
  public CliProviderAdapterRepository(ObjectMapper mapper, CodexExecutableSelector selector) {
    this.mapper = mapper;
    this.selector = selector;
    this.codexExecutable = null;
    this.environment = System.getenv();
    this.home = Path.of(System.getProperty("user.home"));
  }

  public CliProviderAdapterRepository(ObjectMapper mapper) {
    this(mapper, new CodexExecutableSelector());
  }

  CliProviderAdapterRepository(ObjectMapper mapper, String codexExecutable) {
    this(mapper, codexExecutable, null, Path.of(System.getProperty("user.home")));
  }

  CliProviderAdapterRepository(
      ObjectMapper mapper, String codexExecutable, Map<String, String> environment, Path home) {
    this.mapper = mapper;
    this.codexExecutable = codexExecutable;
    this.selector = null;
    this.environment = environment == null ? null : Map.copyOf(environment);
    this.home = home;
  }

  public List<CliProviderAdapter> list() {
    try (InputStream source =
        new ClassPathResource("default-cli-provider-adapters.json").getInputStream()) {
      CliProviderAdapter[] defaults = mapper.readValue(source, CliProviderAdapter[].class);
      return new ArrayList<>(
          Arrays.stream(defaults)
              .filter(CliProviderAdapter::builtin)
              .map(this::withSelectedExecutable)
              .toList());
    } catch (Exception error) {
      throw new IllegalStateException("Could not load built-in CLI providers", error);
    }
  }

  private CliProviderAdapter withSelectedExecutable(CliProviderAdapter adapter) {
    String selectedExecutable;
    if ("codex".equals(adapter.id()))
      selectedExecutable = selector == null ? this.codexExecutable : selector.executable();
    else if ("claude".equals(adapter.id()))
      selectedExecutable =
          environment == null
              ? adapter.executable()
              : ExecutableDiscovery.providerExecutable("claude", environment, home);
    else return adapter;
    if (selectedExecutable == null || selectedExecutable.isBlank()) return adapter;
    try {
      Path selected = Path.of(selectedExecutable.trim());
      if (!selected.isAbsolute() || !Files.isRegularFile(selected) || !Files.isExecutable(selected))
        return adapter;
      ObjectNode definition = mapper.valueToTree(adapter);
      definition.put("executable", selected.normalize().toString());
      return mapper.treeToValue(definition, CliProviderAdapter.class);
    } catch (IllegalArgumentException ignored) {
      return adapter;
    }
  }
}
