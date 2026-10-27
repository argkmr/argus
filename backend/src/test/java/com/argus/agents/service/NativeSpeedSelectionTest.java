package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;
import static org.assertj.core.api.Assertions.*;

import com.argus.agents.domain.CliProviderAdapter;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;

class NativeSpeedSelectionTest {
  private final ObjectMapper json = new ObjectMapper();
  private final CliInvocationService invocations = new CliInvocationService();

  private CliProviderAdapter adapter(String id) throws Exception {
    try (var source = getClass().getResourceAsStream("/default-cli-provider-adapters.json")) {
      return Arrays.stream(json.readValue(source, CliProviderAdapter[].class))
          .filter(item -> id.equals(item.id()))
          .findFirst()
          .orElseThrow();
    }
  }

  @Test
  void everyCodexExecutionExplicitlyOverridesGlobalSpeedIncludingResumes() throws Exception {
    var adapter = adapter("codex");
    for (String speed : List.of("standard", "fast")) {
      for (String kind : List.of("fresh", "resume", "conversation")) {
        var request =
            fields(
                "prompt",
                "question",
                "model",
                "gpt-6-astra",
                "effort",
                "ultra",
                "speed",
                speed,
                "workingDirectory",
                "/fixture/repository");
        if (kind.equals("resume")) request.put("sessionId", "saved-session");
        if (kind.equals("conversation")) request.put("conversationOnly", true);
        var args = invocations.invocation(adapter, request, 4173).arguments();
        assertThat(args)
            .containsSubsequence(
                "--model",
                "gpt-6-astra",
                "--config",
                "model_reasoning_effort=\"ultra\"",
                "--config",
                "service_tier=\"" + (speed.equals("fast") ? "fast" : "default") + "\"");
        assertThat(args.stream().filter(item -> item.startsWith("service_tier="))).hasSize(1);
        if (speed.equals("fast")) assertThat(args).contains("features.fast_mode=true");
        else assertThat(args).doesNotContain("service_tier=\"fast\"", "service_tier=\"priority\"");
        if (kind.equals("resume"))
          assertThat(args.indexOf("resume"))
              .isGreaterThan(
                  args.indexOf(
                      "service_tier=\"" + (speed.equals("fast") ? "fast" : "default") + "\""));
      }
    }
  }

  @Test
  void claudeStandardAlsoDisablesAnInheritedFastDefault() throws Exception {
    for (String speed : List.of("standard", "fast")) {
      for (String kind : List.of("fresh", "resume", "conversation")) {
        var input = fields("prompt", "question", "speed", speed);
        if (kind.equals("resume")) input.put("sessionId", "saved-session");
        if (kind.equals("conversation")) input.put("conversationOnly", true);
        assertThat(invocations.invocation(adapter("claude"), input, 4173).arguments())
            .containsSubsequence("--settings", "{\"fastMode\":" + speed.equals("fast") + "}");
      }
    }
  }

  @Test
  void customAdapterFastArgumentContractIsUnchanged() throws Exception {
    var definition = (tools.jackson.databind.node.ObjectNode) json.valueToTree(adapter("codex"));
    definition.put("id", "custom");
    definition.put("builtin", false);
    definition.set("runArguments", json.valueToTree(List.of("{fastArguments}", "{prompt}")));
    definition.set("fastArguments", json.valueToTree(List.of("--turbo")));
    var adapter = json.treeToValue(definition, CliProviderAdapter.class);
    assertThat(
            invocations
                .invocation(adapter, fields("prompt", "question", "speed", "standard"), 4173)
                .arguments())
        .containsExactly("question");
    assertThat(
            invocations
                .invocation(adapter, fields("prompt", "question", "speed", "fast"), 4173)
                .arguments())
        .containsExactly("--turbo", "question");
  }

  @Test
  void fastRequiresAdvertisedModelSupportAndUnknownSpeedsAreRejected() throws Exception {
    var adapter = adapter("codex");
    var model = fields("id", "fixture", "isDefault", true);
    var catalog = fields("models", List.of(model));
    for (String speed : List.of("fast", "ultra", "priority", "auto"))
      assertThatThrownBy(() -> invocations.settings(adapter, catalog, fields("speed", speed)))
          .isInstanceOf(ResponseStatusException.class);
    model.put("supportsFastMode", true);
    assertThat(invocations.settings(adapter, catalog, fields("speed", "fast")))
        .containsEntry("speed", "fast");
    model.put("supportsFastMode", false);
    assertThatThrownBy(() -> invocations.settings(adapter, catalog, fields("speed", "fast")))
        .isInstanceOf(ResponseStatusException.class);
    assertThat(invocations.settings(adapter, catalog, Map.of())).containsEntry("speed", "standard");
  }

  @Test
  void nativeAndCachedCatalogueTiersAreNormalizedWithoutGuessingFromNameOrDefault() {
    var items =
        json.readTree(
            """
        [{"id":"live","serviceTiers":[{"id":"priority"}]},
         {"id":"legacy-live","additionalSpeedTiers":["fast"]},
         {"slug":"cache","service_tiers":[{"id":"fast"}]},
         {"slug":"legacy-cache","additional_speed_tiers":["fast"]},
         {"id":"explicit-no","supportsFastMode":false,"serviceTiers":[{"id":"priority"}]},
         {"id":"other-tier","serviceTiers":[{"id":"flex"}]},
         {"id":"gpt-6-astra","defaultServiceTier":"priority"}]
        """);
    var normalized =
        AgentModelCatalogService.normalizeCodex(
            java.util.stream.StreamSupport.stream(items.spliterator(), false).toList(), false);
    assertThat(normalized)
        .extracting(item -> item.get("supportsFastMode"))
        .containsExactly(true, true, true, true, false, false, false);
  }
}
