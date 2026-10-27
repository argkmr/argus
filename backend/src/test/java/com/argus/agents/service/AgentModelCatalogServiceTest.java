package com.argus.agents.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.argus.agents.dto.AgentModel;
import com.argus.agents.dto.AgentProvider;
import com.argus.agents.dto.ProviderAvailability;
import com.argus.agents.repository.CliProviderAdapterRepository;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class AgentModelCatalogServiceTest {
  @Test
  void preservesCatalogueOrderLabelsAndModelSpecificReasoningIncludingUltra() throws Exception {
    AtomicReference<String> requestedPath = new AtomicReference<>();
    HttpServer server =
        server(
            200,
            """
        {"source":"codex-app-server","models":[
          {"id":"gpt-6-astra","displayName":"GPT-6 Astra","description":"Most capable",
           "supportedReasoningEfforts":[{"effort":"high","description":"Thorough"},
             {"effort":"ultra","description":"Deepest reasoning"}],
           "defaultReasoningEffort":"high","isDefault":false},
          {"id":"future-model","displayName":"Future model","description":"New model",
           "supportedReasoningEfforts":[{"effort":"medium","description":"Balanced"}],
           "defaultReasoningEffort":"medium","isDefault":true}
        ]}
        """,
            requestedPath);
    try {
      AgentProvider provider = catalog(server).enrich(provider("codex"), true);

      assertThat(requestedPath.get()).isEqualTo("/api/agents/model-catalog/codex?refresh=true");
      assertThat(provider.models()).containsExactly("gpt-6-astra", "future-model");
      assertThat(provider.defaultModel()).isEqualTo("future-model");
      assertThat(provider.modelCatalogSource()).isEqualTo("codex-app-server");
      AgentModel astra = provider.modelCatalog().get(0);
      assertThat(astra.displayName()).isEqualTo("GPT-6 Astra");
      assertThat(astra.description()).isEqualTo("Most capable");
      assertThat(astra.supportedReasoningEfforts())
          .extracting(AgentModel.ReasoningEffort::effort)
          .containsExactly("high", "ultra");
      assertThat(astra.defaultReasoningEffort()).isEqualTo("high");
      assertThat(provider.modelCatalog().get(1).supportedReasoningEfforts())
          .extracting(AgentModel.ReasoningEffort::effort)
          .containsExactly("medium");
      assertThat(provider.supportsEffort()).isTrue();
      var serialized = new ObjectMapper().valueToTree(provider);
      assertThat(serialized.path("modelCatalog").get(1).path("isDefault").asBoolean()).isTrue();
      assertThat(serialized.path("modelCatalog").get(0).path("displayName").asText())
          .isEqualTo("GPT-6 Astra");
    } finally {
      server.stop(0);
    }
  }

  @Test
  void preservesPerModelFastModeIncludingExplicitFalseAndAbsentCapabilities() throws Exception {
    HttpServer server =
        server(
            200,
            """
        {"source":"claude-cli","models":[
          {"id":"opus","supportsFastMode":true,"resolvedModel":"claude-future-opus"},
          {"id":"sonnet","supportsFastMode":false},
          {"id":"haiku"}
        ]}
        """,
            new AtomicReference<>());
    try {
      AgentProvider provider = catalog(server).enrich(provider("claude"), false);
      assertThat(provider.modelCatalog())
          .extracting(AgentModel::supportsFastMode)
          .containsExactly(true, false, null);
      var serialized = new ObjectMapper().valueToTree(provider).path("modelCatalog");
      assertThat(serialized.get(0).path("supportsFastMode").asBoolean()).isTrue();
      assertThat(serialized.get(0).path("resolvedModel").asText()).isEqualTo("claude-future-opus");
      assertThat(provider.modelCatalog().get(0).resolvedModel()).isEqualTo("claude-future-opus");
      assertThat(serialized.get(1).has("resolvedModel")).isFalse();
      assertThat(serialized.get(1).has("supportsFastMode")).isTrue();
      assertThat(serialized.get(1).path("supportsFastMode").asBoolean()).isFalse();
      assertThat(serialized.get(2).has("supportsFastMode")).isFalse();
    } finally {
      server.stop(0);
    }
  }

  @Test
  void failedDiscoveryDoesNotFabricateCodexModelsOrInvalidateCliAuthentication() throws Exception {
    HttpServer server = server(503, "{\"error\":\"offline\"}", new AtomicReference<>());
    try {
      AgentProvider original = provider("codex");
      AgentProvider provider = catalog(server).enrich(original, false);

      assertThat(provider.models()).isEmpty();
      assertThat(provider.modelCatalog()).isEmpty();
      assertThat(provider.defaultModel()).isEmpty();
      assertThat(provider.modelCatalogSource()).isEqualTo("unavailable");
      assertThat(provider.installed()).isTrue();
      assertThat(provider.authenticated()).isTrue();
      assertThat(provider.canRun()).isTrue();
      assertThat(provider.availability()).isEqualTo(original.availability());
      assertThat(provider.executablePath()).isEqualTo(original.executablePath());
    } finally {
      server.stop(0);
    }
  }

  @Test
  void failedClaudeDiscoveryDoesNotRestoreUnverifiedBundledModels() throws Exception {
    HttpServer server = server(503, "{\"error\":\"offline\"}", new AtomicReference<>());
    try {
      AgentProvider provider = catalog(server).enrich(provider("claude"), false);

      assertThat(provider.models()).isEmpty();
      assertThat(provider.modelCatalog()).isEmpty();
      assertThat(provider.defaultModel()).isEmpty();
      assertThat(provider.modelCatalogSource()).isEqualTo("unavailable");
      assertThat(provider.installed()).isTrue();
      assertThat(provider.authenticated()).isTrue();
      assertThat(provider.canRun()).isTrue();
    } finally {
      server.stop(0);
    }
  }

  @Test
  void acceptsAnEmptyAccountCatalogueWithoutRestoringBundledModels() throws Exception {
    HttpServer server =
        server(200, "{\"models\":[],\"source\":\"codex-app-server\"}", new AtomicReference<>());
    try {
      AgentProvider provider = catalog(server).enrich(provider("codex"), false);

      assertThat(provider.models()).isEmpty();
      assertThat(provider.modelCatalogSource()).isEqualTo("codex-app-server");
      assertThat(provider.canRun()).isTrue();
    } finally {
      server.stop(0);
    }
  }

  @Test
  void malformedDiscoveryUsesExplicitAdapterFallbackForOtherClisOnly() throws Exception {
    HttpServer server = server(200, "not json", new AtomicReference<>());
    try {
      AgentProvider provider = catalog(server).enrich(provider("other-cli"), false);

      assertThat(provider.models()).containsExactly("legacy-model");
      assertThat(provider.defaultModel()).isEqualTo("legacy-model");
      assertThat(provider.modelCatalogSource()).isEqualTo("adapter");
      assertThat(provider.modelCatalog().get(0).supportedReasoningEfforts()).isEmpty();
    } finally {
      server.stop(0);
    }
  }

  private AgentModelCatalogService catalog(HttpServer server) {
    URI origin = URI.create("http://127.0.0.1:" + server.getAddress().getPort());
    // Keep the enrichment-contract fixtures independent of process discovery.
    // Native stdio discovery is covered separately; this local fixture has no Node dependency.
    return new AgentModelCatalogService(
        org.mockito.Mockito.mock(CliProviderAdapterRepository.class),
        new ObjectMapper(),
        java.util.Map.of()) {
      @Override
      @SuppressWarnings("unchecked")
      public java.util.Map<String, Object> discover(String providerId, boolean refresh) {
        try {
          var request =
              java.net.http.HttpRequest.newBuilder(
                      origin.resolve(
                          "/api/agents/model-catalog/" + providerId + "?refresh=" + refresh))
                  .timeout(java.time.Duration.ofSeconds(2))
                  .GET()
                  .build();
          var response =
              java.net.http.HttpClient.newHttpClient()
                  .send(request, java.net.http.HttpResponse.BodyHandlers.ofString());
          if (response.statusCode() != 200) throw new IllegalStateException("Fixture unavailable");
          return new ObjectMapper().readValue(response.body(), java.util.Map.class);
        } catch (Exception error) {
          throw new IllegalStateException("Fixture unavailable", error);
        }
      }
    };
  }

  private HttpServer server(int status, String response, AtomicReference<String> path)
      throws Exception {
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext(
        "/api/agents/model-catalog/",
        exchange -> {
          path.set(exchange.getRequestURI().toString());
          byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
          exchange.getResponseHeaders().set("Content-Type", "application/json");
          exchange.sendResponseHeaders(status, bytes.length);
          exchange.getResponseBody().write(bytes);
          exchange.close();
        });
    server.start();
    return server;
  }

  private AgentProvider provider(String id) {
    return new AgentProvider(
        id,
        "Test CLI",
        true,
        "1.2.3",
        "/usr/bin/test-cli",
        true,
        "CLI login",
        ProviderAvailability.unknown(),
        true,
        false,
        false,
        "cli",
        List.of("legacy-model"),
        "legacy-model",
        true,
        true,
        true,
        false,
        List.of("file"),
        List.of(),
        "unavailable");
  }
}
