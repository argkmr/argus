package com.argus.agents.service;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.agents.domain.CliProviderAdapter;
import com.argus.agents.repository.CliProviderAdapterRepository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class NativeCliMetadataTest {
  @TempDir Path directory;
  private final ObjectMapper json = new ObjectMapper();

  @Test
  void codexPaginatesDeduplicatesAndCachesWithoutStartingATurnOrAcceptingApproval()
      throws Exception {
    var fixture = fixture("codex", "models");
    var service = new AgentModelCatalogService(fixture.repository, json, environment());
    var catalog = json.valueToTree(service.discover("codex", false));
    assertThat(catalog.path("source").asText()).isEqualTo("codex-app-server");
    assertThat(catalog.path("models").size()).isEqualTo(2);
    assertThat(catalog.path("models").get(0).path("id").asText()).isEqualTo("gpt-6-astra");
    assertThat(catalog.path("models").get(0).path("defaultReasoningEffort").asText())
        .isEqualTo("ultra");
    assertThat(catalog.path("models").get(1).path("isDefault").asBoolean()).isTrue();
    service.discover("codex", false);
    String log = Files.readString(fixture.log);
    assertThat(log.lines().filter(line -> line.startsWith("START")).count()).isEqualTo(1);
    assertThat(log)
        .contains("unexpected-approval", "does not execute tools or approvals")
        .doesNotContain("turn/start", "exec resume");
    assertThat(json.writeValueAsString(catalog)).doesNotContain("synthetic-secret");
  }

  @Test
  void repeatedPaginationUsesOnlyVerifiedVisibleCacheMetadata() throws Exception {
    Files.writeString(
        directory.resolve("models_cache.json"),
        """
        {"models":[{"slug":"cached","visibility":"list","priority":1,"supported_reasoning_levels":[{"effort":"max"}]},
        {"slug":"hidden","visibility":"hide","priority":0},{"slug":"not-visible","hidden":true,"visibility":"list"}]}
        """);
    var fixture = fixture("codex", "repeat");
    var service = new AgentModelCatalogService(fixture.repository, json, environment());
    var catalog = json.valueToTree(service.discover("codex", true));
    assertThat(catalog.path("source").asText()).isEqualTo("codex-cache");
    assertThat(catalog.path("models").size()).isEqualTo(1);
    assertThat(catalog.path("models").get(0).path("id").asText()).isEqualTo("cached");
  }

  @Test
  void unavailableCacheDoesNotInventAccountModels() throws Exception {
    var fixture = fixture("codex", "exit");
    var catalog =
        json.valueToTree(
            new AgentModelCatalogService(fixture.repository, json, environment())
                .discover("codex", false));
    assertThat(catalog.path("source").asText()).isEqualTo("unavailable");
    assertThat(catalog.path("models").isEmpty()).isTrue();
  }

  @Test
  void claudeAliasesEffortsAndFastModeComeOnlyFromInitialization() throws Exception {
    var fixture = fixture("claude", "claude");
    var catalog =
        json.valueToTree(
            new AgentModelCatalogService(fixture.repository, json, environment())
                .discover("claude", false));
    assertThat(catalog.path("source").asText()).isEqualTo("claude-initialize");
    var models = catalog.path("models");
    assertThat(models.size()).isEqualTo(2);
    assertThat(models.get(0).path("id").asText()).isEqualTo("opus[1m]");
    assertThat(models.get(0).path("isDefault").asBoolean()).isTrue();
    assertThat(models.get(0).path("defaultReasoningEffort").asText()).isEqualTo("auto");
    assertThat(models.get(0).path("supportsFastMode").asBoolean()).isTrue();
    assertThat(models.get(1).path("supportsFastMode").asBoolean()).isFalse();
    assertThat(Files.readString(fixture.log))
        .contains("--safe-mode", "--no-session-persistence", "--strict-mcp-config")
        .doesNotContain("turn/start");
  }

  @Test
  void capabilityDiscoveryPreservesAuthAndEnabledStatesWithoutExposingEndpoints() throws Exception {
    var fixture = fixture("codex", "capabilities");
    var capabilities =
        json.valueToTree(
            new CliCapabilityService(fixture.repository, json, environment())
                .discover("codex", directory, false));
    assertThat(capabilities.path("status").asText()).isEqualTo("checked");
    assertThat(capabilities.path("integrations").size()).isEqualTo(4);
    assertThat(
            capabilities
                .path("integrations")
                .get(0)
                .path("tools")
                .get(0)
                .path("readOnly")
                .asBoolean())
        .isTrue();
    assertThat(capabilities.path("integrations").get(1).path("status").asText())
        .isEqualTo("needs-auth");
    assertThat(capabilities.path("integrations").get(3).path("status").asText())
        .isEqualTo("disabled");
    assertThat(capabilities.toString()).doesNotContain("private.example", "synthetic-secret");
  }

  @Test
  void partialCapabilityDiscoveryDoesNotClaimFullVerification() throws Exception {
    var fixture = fixture("codex", "partial");
    var capabilities =
        json.valueToTree(
            new CliCapabilityService(fixture.repository, json, environment())
                .discover("codex", directory, false));
    assertThat(capabilities.path("status").asText()).isEqualTo("partial");
    assertThat(capabilities.path("integrations").size()).isEqualTo(2);
    assertThat(capabilities.toString())
        .contains("could not verify")
        .doesNotContain("synthetic-secret");
  }

  @Test
  void claudeCapabilityCheckUsesPlanModeAndDisablesHooks() throws Exception {
    var fixture = fixture("claude", "claude");
    var capabilities =
        json.valueToTree(
            new CliCapabilityService(fixture.repository, json, environment())
                .discover("claude", directory, false));
    assertThat(capabilities.path("source").asText()).isEqualTo("claude-control");
    assertThat(capabilities.path("integrations").get(0).path("name").asText()).isEqualTo("Browser");
    assertThat(Files.readString(fixture.log))
        .contains("--permission-mode plan", "disableAllHooks")
        .doesNotContain("turn/start");
  }

  private Map<String, String> environment() {
    return Map.of("PATH", "/usr/bin:/bin", "CODEX_HOME", directory.toString());
  }

  private Fixture fixture(String providerId, String scenario) throws Exception {
    Path script = directory.resolve("fake-cli");
    Path log = directory.resolve("protocol.log");
    String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
    String classpath = System.getProperty("java.class.path");
    Files.writeString(
        script,
        "#!/bin/sh\nexec "
            + quote(java)
            + " -cp "
            + quote(classpath)
            + " "
            + CliMetadataFixture.class.getName()
            + " "
            + quote(scenario)
            + " "
            + quote(log.toString())
            + " \"$@\"\n");
    assertThat(script.toFile().setExecutable(true)).isTrue();
    CliProviderAdapter adapter =
        json.convertValue(
            Map.of(
                "id",
                providerId,
                "name",
                "Fixture CLI",
                "executable",
                script.toString(),
                "builtin",
                true,
                "promptViaStdin",
                false,
                "toolCapable",
                true),
            CliProviderAdapter.class);
    CliProviderAdapterRepository repository = mock(CliProviderAdapterRepository.class);
    when(repository.list()).thenReturn(List.of(adapter));
    return new Fixture(repository, log);
  }

  private String quote(String value) {
    return "'" + value.replace("'", "'\\''") + "'";
  }

  private record Fixture(CliProviderAdapterRepository repository, Path log) {}
}
