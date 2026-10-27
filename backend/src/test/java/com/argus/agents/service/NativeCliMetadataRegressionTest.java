package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.agents.domain.CliProviderAdapter;
import com.argus.agents.repository.CliProviderAdapterRepository;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** Real disposable Java child fixtures; never launches a provider or performs a model turn. */
class NativeCliMetadataRegressionTest {
  @TempDir Path directory;
  final ObjectMapper json = new ObjectMapper();
  final List<Call> calls = new ArrayList<>();

  @AfterEach
  void stopFixtureCallers() throws Exception {
    for (Call call : calls) call.thread.interrupt();
    for (Call call : calls) {
      call.thread.join(5000);
      assertThat(call.thread.isAlive()).isFalse();
    }
  }

  @Test
  void codexInventoryKeepsAuthenticationCallabilityAndSanitizesUntrustedMetadata() {
    var servers =
        nodes(
            """
        [{"name":"google","authStatus":"oAuth","tools":{"fetch":{"annotations":{"readOnlyHint":true},"inputSchema":{"secret":"do not include"}},"edit":{"annotations":{"readOnlyHint":false}}},"url":"https://secret/token"},
         {"name":"logged-out","authStatus":"notLoggedIn","tools":{"stale_tool":{}}},
         {"name":"empty","authStatus":"unsupported","tools":{}},{"name":"cua_repl","authStatus":"unsupported","tools":{"js":{}}},
         null,{"name":"https://secret.example/token","tools":{}}]
        """);
    var apps =
        nodes(
            """
        [{"id":"drive","runtimeName":"Google Drive","enabled":true,"callable":true},
         {"id":"inactive","runtimeName":"Inactive","enabled":false,"callable":true},
         {"id":"installed","runtimeName":"Installed only","enabled":true,"callable":false},
         {"id":"app","runtimeName":"Name\\nINJECT","enabled":false,"callable":true,"token":"private-token"}]
        """);
    var report = CliCapabilityService.normalizeCodex(servers, apps, true, true, List.of());
    var entries =
        NativeCliMetadataRegressionTest.<Map<String, Object>>items(report.get("integrations"));
    assertThat(entries)
        .extracting(item -> item.get("status"))
        .containsExactly(
            "available",
            "needs-auth",
            "unknown",
            "available",
            "available",
            "disabled",
            "unavailable",
            "disabled");
    assertThat(entries.get(0).get("tools"))
        .isEqualTo(
            List.of(
                fields("name", "edit", "readOnly", false),
                fields("name", "fetch", "readOnly", true)));
    assertThat(obj(items(entries.get(3).get("tools")).get(0))).containsEntry("readOnly", null);
    assertThat(entries.get(7)).containsEntry("name", "app");
    assertThat(json.writeValueAsString(report))
        .doesNotContain("secret/token", "inputSchema", "do not include", "INJECT", "private-token");
  }

  @Test
  void claudeStatesAndRelativeToolNamesDoNotImplyUnverifiedAccess() {
    var report =
        CliCapabilityService.normalizeClaude(
            nodes(
                """
        [{"name":"drive","status":"connected","tools":[{"name":"fetch","annotations":{"readOnlyHint":true}}]},
         {"name":"empty","status":"connected"},{"name":"auth","status":"needs-auth"},{"name":"off","status":"disabled"},
         {"name":"failed","status":"failed","error":"secret error","config":{"headers":{"Authorization":"Bearer private"}}},
         {"name":"wait","status":"pending"}]
        """));
    assertThat(
            NativeCliMetadataRegressionTest.<Map<String, Object>>items(report.get("integrations")))
        .extracting(item -> item.get("status"))
        .containsExactly(
            "available", "unknown", "needs-auth", "disabled", "unavailable", "unknown");
    assertThat(json.writeValueAsString(report))
        .doesNotContain("secret error", "Bearer private", "headers");
    var paths =
        CliCapabilityService.normalizeCodex(
            nodes(
                """
        [{"name":"drive","tools":{"files/read":{},"/private/secret":{},"../secrets":{},"https://secret.example":{},"a/../b":{}}}]
        """),
            List.of(),
            true,
            true,
            List.of());
    assertThat(obj(items(paths.get("integrations")).get(0)).get("tools"))
        .isEqualTo(List.of(fields("name", "files/read", "readOnly", null)));
  }

  @Test
  void claudeAliasMatrixPreservesDefaultAndDoesNotInventEfforts() {
    var models =
        AgentModelCatalogService.normalizeClaude(
            json.readTree(
                """
        [{"value":"default","resolvedModel":"claude-opus-current[1m]"},
         {"value":"opus[1m]","resolvedModel":"claude-opus-current[1m]","supportedEffortLevels":["low","medium","high","xhigh","max"],"supportsFastMode":true},
         {"value":"sonnet","supportedEffortLevels":"high"},{"value":"haiku"},{"value":"opus","supportedEffortLevels":["low","high"]},
         null,{}, {"value":"hidden","hidden":true},{"value":"sonnet"},
         {"value":"custom","supportedEffortLevels":["high",null,"high","ultra"],"defaultReasoningEffort":"ultra"}]
        """));
    assertThat(models)
        .extracting(item -> item.get("id"))
        .containsExactly("opus[1m]", "sonnet", "haiku", "opus", "custom");
    assertThat(models.stream().filter(item -> Boolean.TRUE.equals(item.get("isDefault"))))
        .hasSize(1);
    assertThat(models.get(0))
        .containsEntry("isDefault", true)
        .containsEntry("supportsFastMode", true)
        .containsEntry("defaultReasoningEffort", "auto");
    assertThat(
            NativeCliMetadataRegressionTest.<Map<String, Object>>items(
                models.get(0).get("supportedReasoningEfforts")))
        .extracting(item -> item.get("effort"))
        .containsExactly("auto", "low", "medium", "high", "xhigh", "max");
    assertThat(items(models.get(1).get("supportedReasoningEfforts"))).isEmpty();
    assertThat(models.get(1)).containsEntry("supportsFastMode", false);
    assertThat(
            NativeCliMetadataRegressionTest.<Map<String, Object>>items(
                models.get(4).get("supportedReasoningEfforts")))
        .extracting(item -> item.get("effort"))
        .containsExactly("auto", "high", "ultra");
    assertThat(models.get(4)).containsEntry("defaultReasoningEffort", "ultra");
  }

  @Test
  void codexCapabilitiesPaginateAndLoopsOrMissingAppRuntimeRemainPartial() throws Exception {
    var paginated = fixture("codex", "cap-pages");
    var report =
        new CliCapabilityService(paginated.repository, json, environment())
            .discover("codex", directory, false);
    assertThat(report).containsEntry("status", "checked");
    assertThat(
            NativeCliMetadataRegressionTest.<Map<String, Object>>items(report.get("integrations")))
        .extracting(item -> item.get("name"))
        .startsWith("first", "second");
    assertThat(Files.readString(paginated.log)).doesNotContain("turn/start", "tool/call");
    assertStopped(paginated);
    for (String scenario : List.of("cap-loop", "no-apps")) {
      var fixture = fixture("codex", scenario);
      var partial =
          new CliCapabilityService(fixture.repository, json, environment())
              .discover("codex", directory, false);
      assertThat(partial).containsEntry("status", "partial");
      assertThat(json.writeValueAsString(partial)).doesNotContain("synthetic-secret");
      if (scenario.equals("cap-loop"))
        assertThat(
                Files.readString(fixture.log)
                    .lines()
                    .filter(line -> line.contains("\"method\":\"mcpServerStatus/list\""))
                    .count())
            .isEqualTo(2);
      assertStopped(fixture);
    }
  }

  @Test
  void fragmentedClaudeInitializationIgnoresUnrelatedMessagesAndStopsChild() throws Exception {
    var fixture = fixture("claude", "fragmented");
    var catalog =
        new AgentModelCatalogService(fixture.repository, json, environment())
            .discover("claude", false);
    assertThat(catalog).containsEntry("source", "claude-initialize");
    assertThat(items(catalog.get("models"))).hasSize(2);
    var log = Files.readString(fixture.log);
    assertThat(log.lines().filter(line -> line.contains("\"type\":\"control_request\"")).count())
        .isEqualTo(1);
    assertThat(log)
        .contains("--safe-mode", "--strict-mcp-config", "--no-session-persistence")
        .doesNotContain("mcp_status", "turn/start");
    assertStopped(fixture);
  }

  @Test
  void rejectionMalformedPayloadAndPrematureExitAreSafeWithoutGuessedModels() throws Exception {
    for (String provider : List.of("codex", "claude"))
      for (String scenario : List.of("reject", "malformed", "exit")) {
        var fixture = fixture(provider, scenario);
        var report =
            new AgentModelCatalogService(fixture.repository, json, environment())
                .discover(provider, false);
        assertThat(report).containsEntry("source", "unavailable");
        assertThat(items(report.get("models"))).isEmpty();
        assertThat(json.writeValueAsString(report))
            .doesNotContain("private configuration detail", "synthetic-secret");
        assertStopped(fixture);
      }
    var malformed = fixture("claude", "malformed");
    var report =
        new CliCapabilityService(malformed.repository, json, environment())
            .discover("claude", directory, false);
    assertThat(report).containsEntry("status", "unavailable");
    assertThat(items(report.get("integrations"))).isEmpty();
    assertStopped(malformed);
  }

  @Test
  void modelCataloguesAutomaticallyDiscoverNewIdsAndRecoverFromTransientFailures()
      throws Exception {
    for (String provider : List.of("codex", "claude")) {
      var fixture = fixture(provider, "models");
      var clock = new java.util.concurrent.atomic.AtomicLong();
      var service =
          new AgentModelCatalogService(fixture.repository, json, environment(), clock::get);
      var original = service.discover(provider, false);
      assertThat(items(original.get("models"))).hasSize(2);

      // No app/CLI upgrade or manual refresh: the periodic read after expiry
      // must accept previously unknown model and reasoning identifiers.
      Files.writeString(fixture.scenario, "models-next");
      assertThat(service.discover(provider, false)).isEqualTo(original);
      assertStarts(fixture, 1);
      clock.addAndGet(Duration.ofSeconds(61).toNanos());
      var changed = service.discover(provider, false);
      assertThat(items(changed.get("models"))).hasSize(1);
      assertThat(obj(items(changed.get("models")).get(0)))
          .containsEntry("id", provider.equals("codex") ? "future-generation" : "future-family");
      assertThat(json.writeValueAsString(changed)).contains("future-effort");
      assertStarts(fixture, 2);

      // An old/missing disk cache cannot erase a newer list already seen live.
      Files.writeString(fixture.scenario, "exit");
      var cached = service.discover(provider, true);
      assertThat(cached).containsEntry("source", provider + "-cache");
      assertThat(cached.get("models")).isEqualTo(changed.get("models"));

      // Successful empty catalogues are authoritative: removed models must
      // not be silently reintroduced from a previous successful response.
      Files.writeString(fixture.scenario, "models-empty");
      var empty = service.discover(provider, true);
      assertThat(items(empty.get("models"))).isEmpty();
      assertThat(empty)
          .containsEntry(
              "source", provider.equals("codex") ? "codex-app-server" : "claude-initialize");
      assertThat(Files.readString(fixture.log)).doesNotContain("turn/start", "\"type\":\"user\"");
      assertStopped(fixture);
    }
  }

  @Test
  void metadataSessionBoundsSilentAndFloodingChildrenAndRejectsNonMetadataMethods()
      throws Exception {
    for (String scenario : List.of("hang", "flood")) {
      var fixture = fixture("codex", scenario);
      long start = System.nanoTime();
      try (var session =
          new CliMetadataSession(
              fixture.executable.toString(),
              List.of("app-server"),
              directory,
              environment(),
              json,
              Duration.ofSeconds(2))) {
        assertThatThrownBy(() -> session.codex("initialize", Map.of()))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining(scenario.equals("hang") ? "timed out" : "size limit");
      }
      assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(6));
      assertStopped(fixture);
    }
    var fixture = fixture("codex", "controlled");
    try (var session =
        new CliMetadataSession(
            fixture.executable.toString(),
            List.of("app-server"),
            directory,
            environment(),
            json,
            Duration.ofSeconds(2))) {
      assertThatThrownBy(() -> session.codex("turn/start", Map.of()))
          .isInstanceOf(IllegalArgumentException.class);
      assertThatThrownBy(() -> session.claude("tool_call"))
          .isInstanceOf(IllegalArgumentException.class);
    }
    assertThatThrownBy(
            () ->
                new CliMetadataSession(
                    directory.resolve("missing-cli").toString(),
                    List.of(),
                    directory,
                    environment(),
                    json,
                    Duration.ofMillis(100)))
        .isInstanceOf(java.io.IOException.class);
  }

  @Test
  void cacheIsolatesWorkingDirectoryEnvironmentAndReturnsIndependentValues() throws Exception {
    var fixture = fixture("codex", "capabilities");
    var service = new CliCapabilityService(fixture.repository, json, environment());
    var first = service.discover("codex", directory, false);
    items(first.get("integrations")).clear();
    assertThat(items(service.discover("codex", directory, false).get("integrations"))).hasSize(4);
    assertStarts(fixture, 1);
    var other = Files.createDirectory(directory.resolve("other-repository"));
    service.discover("codex", other, false);
    assertStarts(fixture, 2);
    var changed = new LinkedHashMap<>(environment());
    changed.put("ARGUS_FIXTURE_ENV", "different");
    new CliCapabilityService(fixture.repository, json, changed).discover("codex", directory, false);
    assertStarts(fixture, 3);
    Files.writeString(fixture.scenario, "exit");
    assertThat(service.discover("codex", directory, true)).containsEntry("status", "unavailable");
    assertThat(items(service.discover("codex", directory, false).get("integrations"))).isEmpty();
    assertStarts(fixture, 4);
    assertStopped(fixture);
  }

  @Test
  void interruptedWaiterDoesNotCancelProducerOrCorruptModelOrCapabilityCache() throws Exception {
    for (boolean models : List.of(false, true)) {
      var fixture = fixture("codex", "controlled");
      var catalog = new AgentModelCatalogService(fixture.repository, json, environment());
      var capabilities = new CliCapabilityService(fixture.repository, json, environment());
      Supplier<Map<String, Object>> discover =
          () ->
              models
                  ? catalog.discover("codex", false)
                  : capabilities.discover("codex", directory, false);
      var owner = new Call(discover);
      owner.thread.start();
      await(() -> starts(fixture) == 1);
      var waiter = new Call(discover);
      waiter.thread.start();
      await(() -> waiter.thread.getState() == Thread.State.WAITING);
      waiter.thread.interrupt();
      assertThat(waiter.result.get(3, TimeUnit.SECONDS)).isInstanceOf(CancellationException.class);
      assertThat(owner.result.isDone()).isFalse();
      assertStarts(fixture, 1);
      Files.writeString(
          fixture.log.resolveSibling(fixture.log.getFileName() + ".release"), "ready");
      assertThat(owner.result.get(5, TimeUnit.SECONDS)).isInstanceOf(Map.class);
      assertThat(discover.get().get(models ? "source" : "status"))
          .isEqualTo(models ? "codex-app-server" : "checked");
      assertStarts(fixture, 1);
      assertStopped(fixture);
    }
  }

  @Test
  void cancelledProducerDoesNotPoisonCacheAndRemainingCallerCanRetrySafely() throws Exception {
    var fixture = fixture("codex", "controlled");
    var service = new CliCapabilityService(fixture.repository, json, environment());
    Supplier<Map<String, Object>> discover = () -> service.discover("codex", directory, false);
    var owner = new Call(discover);
    owner.thread.start();
    await(() -> starts(fixture) == 1);
    var waiter = new Call(discover);
    waiter.thread.start();
    await(() -> waiter.thread.getState() == Thread.State.WAITING);
    owner.thread.interrupt();
    assertThat(owner.result.get(3, TimeUnit.SECONDS)).isInstanceOf(CancellationException.class);
    await(() -> starts(fixture) == 2);
    Files.writeString(fixture.log.resolveSibling(fixture.log.getFileName() + ".release"), "ready");
    assertThat(obj(waiter.result.get(5, TimeUnit.SECONDS))).containsEntry("status", "checked");
    assertThat(service.discover("codex", directory, false)).containsEntry("status", "checked");
    assertStarts(fixture, 2);
    assertStopped(fixture);
  }

  @Test
  void preCancelledDiscoveryNeverSpawnsAndUnknownAdaptersAreNotProbed() throws Exception {
    var fixture = fixture("codex", "controlled");
    var capabilities = new CliCapabilityService(fixture.repository, json, environment());
    var models = new AgentModelCatalogService(fixture.repository, json, environment());
    try {
      Thread.currentThread().interrupt();
      assertThatThrownBy(() -> capabilities.discover("codex", directory, false))
          .isInstanceOf(CancellationException.class);
      assertThatThrownBy(() -> models.discover("codex", false))
          .isInstanceOf(CancellationException.class);
      assertThatThrownBy(
              () ->
                  new CliMetadataSession(
                      fixture.executable.toString(),
                      List.of(),
                      directory,
                      environment(),
                      json,
                      Duration.ofSeconds(1)))
          .isInstanceOf(CancellationException.class);
    } finally {
      Thread.interrupted();
    }
    assertThat(Files.exists(fixture.log)).isFalse();
    var custom = fixture("custom", "hang");
    assertThat(
            new CliCapabilityService(custom.repository, json, environment())
                .discover("custom", directory, false))
        .containsEntry("status", "unavailable");
    assertThat(Files.exists(custom.log)).isFalse();
  }

  @Test
  void approvalFloodWithoutStdinReadsAndOversizedIdsCannotBlockCleanup() throws Exception {
    for (String provider : List.of("codex", "claude"))
      for (String scenario : List.of("approval-storm", "approval-oversized")) {
        var fixture = approvalFixture(provider, scenario);
        long start = System.nanoTime();
        try (var session =
            new CliMetadataSession(
                fixture.executable.toString(),
                List.of(),
                directory,
                environment(),
                json,
                Duration.ofSeconds(3))) {
          assertThatThrownBy(
                  () -> {
                    if (provider.equals("codex")) session.codex("initialize", Map.of());
                    else session.claude("initialize");
                  })
              .as("%s %s", provider, scenario)
              .isInstanceOf(IllegalStateException.class)
              .hasMessageMatching(
                  scenario.equals("approval-storm")
                      ? "CLI metadata (sent repeated non-metadata requests|response queue exceeded its limit)"
                      : "CLI metadata sent an invalid request identifier");
        }
        assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(5));
        assertStopped(fixture);
      }
  }

  @Test
  void outboundMetadataBudgetRejectsOversizedInputBeforeWritingToChild() throws Exception {
    var fixture = fixture("codex", "controlled");
    try (var session =
        new CliMetadataSession(
            fixture.executable.toString(),
            List.of(),
            directory,
            environment(),
            json,
            Duration.ofSeconds(2))) {
      assertThatThrownBy(() -> session.codex("model/list", Map.of("cursor", "x".repeat(4096))))
          .isInstanceOf(IllegalStateException.class)
          .hasMessageContaining("request exceeded its size limit");
    }
    assertStopped(fixture);
  }

  List<JsonNode> nodes(String encoded) {
    var result = new ArrayList<JsonNode>();
    json.readTree(encoded).forEach(result::add);
    return result;
  }

  @SuppressWarnings("unchecked")
  static <T> List<T> items(Object value) {
    return (List<T>) value;
  }

  Map<String, String> environment() {
    return Map.of("PATH", "/usr/bin:/bin", "CODEX_HOME", directory.toString());
  }

  Fixture approvalFixture(String provider, String scenario) throws Exception {
    var fixture = fixture(provider, scenario);
    String id = scenario.equals("approval-oversized") ? "x".repeat(32_000) : "request";
    var response =
        provider.equals("codex")
            ? Map.of("id", id, "method", "item/permissions/requestApproval", "params", Map.of())
            : Map.of(
                "type",
                "control_request",
                "request_id",
                id,
                "request",
                Map.of("subtype", "can_use_tool"));
    // This security/pipe-budget test needs a prompt protocol producer, not a
    // fresh JVM/Jackson startup inside the same three-second discovery budget.
    // Keep a real owned process, and deliberately never read stdin after the
    // first request. A blocked writer must still fail the bounded cleanup test.
    Files.writeString(
        fixture.executable,
        "#!/bin/sh\n"
            + "printf 'START approval-fixture\\nPID %s\\n' \"$$\" > "
            + quote(fixture.log.toString())
            + "\nIFS= read -r request || exit 1\n"
            + "printf '%s\\n' \"$request\" >> "
            + quote(fixture.log.toString())
            + "\ncount=0\nwhile [ \"$count\" -lt "
            + (scenario.equals("approval-storm") ? 1000 : 1)
            + " ]; do\n  printf '%s\\n' "
            + quote(json.writeValueAsString(response))
            + "\n  count=$((count + 1))\ndone\nexec /bin/sleep 60\n");
    return fixture;
  }

  Fixture fixture(String provider, String scenario) throws Exception {
    var root = Files.createDirectory(directory.resolve("fixture-" + UUID.randomUUID()));
    var log = root.resolve("protocol.log");
    var state = root.resolve("scenario");
    Files.writeString(state, scenario);
    var executable = root.resolve("fake-cli");
    var java = Path.of(System.getProperty("java.home"), "bin", "java");
    Files.writeString(
        executable,
        "#!/bin/sh\nexec "
            + quote(java.toString())
            + " -cp "
            + quote(System.getProperty("java.class.path"))
            + " "
            + CliMetadataFixture.class.getName()
            + " "
            + quote("file:" + state)
            + " "
            + quote(log.toString())
            + " \"$@\"\n");
    assertThat(executable.toFile().setExecutable(true)).isTrue();
    var adapter =
        json.convertValue(
            fields(
                "id",
                provider,
                "name",
                "Fixture",
                "executable",
                executable.toString(),
                "builtin",
                true,
                "promptViaStdin",
                false,
                "toolCapable",
                true),
            CliProviderAdapter.class);
    var repository = mock(CliProviderAdapterRepository.class);
    when(repository.list()).thenReturn(List.of(adapter));
    return new Fixture(repository, log, state, executable);
  }

  String quote(String value) {
    return "'" + value.replace("'", "'\\''") + "'";
  }

  long starts(Fixture fixture) {
    try {
      return Files.exists(fixture.log)
          ? Files.readString(fixture.log).lines().filter(line -> line.startsWith("START ")).count()
          : 0;
    } catch (Exception error) {
      throw new IllegalStateException(error);
    }
  }

  void assertStarts(Fixture fixture, long expected) {
    assertThat(starts(fixture)).isEqualTo(expected);
  }

  void assertStopped(Fixture fixture) throws Exception {
    if (!Files.exists(fixture.log)) return;
    for (String line :
        Files.readString(fixture.log).lines().filter(value -> value.startsWith("PID ")).toList()) {
      long pid = Long.parseLong(line.substring(4));
      await(() -> ProcessHandle.of(pid).map(handle -> !handle.isAlive()).orElse(true));
    }
  }

  static void await(BooleanSupplier predicate) throws Exception {
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
    while (!predicate.getAsBoolean() && System.nanoTime() < deadline) Thread.sleep(10);
    assertThat(predicate.getAsBoolean()).isTrue();
  }

  record Fixture(
      CliProviderAdapterRepository repository, Path log, Path scenario, Path executable) {}

  class Call {
    final CompletableFuture<Object> result = new CompletableFuture<>();
    final Thread thread;

    Call(Supplier<Map<String, Object>> callback) {
      thread =
          new Thread(
              () -> {
                try {
                  result.complete(callback.get());
                } catch (Throwable error) {
                  result.complete(error);
                } finally {
                  Thread.interrupted();
                }
              },
              "metadata-fixture-caller");
      calls.add(this);
    }
  }
}
