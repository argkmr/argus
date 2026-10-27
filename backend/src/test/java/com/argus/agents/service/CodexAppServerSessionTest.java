package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;
import static org.assertj.core.api.Assertions.*;

import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class CodexAppServerSessionTest {
  @TempDir Path root;
  final ObjectMapper json = new ObjectMapper();
  final List<Map<String, Object>> events = new CopyOnWriteArrayList<>();
  CodexAppServerSession session;

  @AfterEach
  void close() {
    if (session != null) session.close();
  }

  static ProcessBuilder fixture(String scenario, Path log) {
    return new ProcessBuilder(
        Path.of(System.getProperty("java.home"), "bin", "java").toString(),
        "-cp",
        System.getProperty("java.class.path"),
        CodexAppServerFixture.class.getName(),
        scenario,
        log.toString());
  }

  CodexAppServerSession start(String scenario) throws Exception {
    session =
        new CodexAppServerSession(
            fixture(scenario, root.resolve("protocol.log")),
            json,
            events::add,
            (stream, text) -> {},
            Duration.ofSeconds(2));
    session.initialize();
    session.openThread(Map.of(), "");
    session.startTurn(Map.of(), "Original prompt");
    return session;
  }

  String log() throws Exception {
    return Files.readString(root.resolve("protocol.log"));
  }

  @Test
  void steersSameTurnWithoutInterruptOrSecondStart() throws Exception {
    start("finish-on-steer");
    assertThat(session.available()).isTrue();
    assertThat(session.steer("turn-fixture", "Also inspect the retry path"))
        .containsEntry("accepted", true)
        .containsEntry("turnId", "turn-fixture")
        .containsEntry("threadId", "thread-fixture")
        .containsKey("acceptedAt");
    assertThat(session.completion().get(2, TimeUnit.SECONDS)).isZero();
    assertThat(log())
        .contains("\"expectedTurnId\":\"turn-fixture\"", "Also inspect the retry path")
        .doesNotContain("turn/interrupt");
    assertThat(log().lines().filter(line -> line.contains("\"method\":\"turn/start\"")).count())
        .isEqualTo(1);
    assertThat(log().lines().filter(line -> line.startsWith("START")).count()).isEqualTo(1);
    assertThat(session.available()).isFalse();
  }

  @Test
  void wrongExpectedTurnAndOversizedPromptAreDefinitiveBeforeWriting() throws Exception {
    start("ack");
    assertThatThrownBy(() -> session.steer("stale-turn", "Do not deliver"))
        .isInstanceOfSatisfying(
            SteerDeliveryException.class, error -> assertThat(error.outcomeUnknown()).isFalse());
    assertThatThrownBy(() -> session.steer("turn-fixture", "x".repeat(2_000_001)))
        .isInstanceOfSatisfying(
            SteerDeliveryException.class, error -> assertThat(error.outcomeUnknown()).isFalse());
    assertThat(log()).doesNotContain("turn/steer");
    assertThat(session.available()).isTrue();
  }

  @Test
  void nativeRejectionIsDefinitiveAndDoesNotStopTheTurn() throws Exception {
    start("reject");
    assertThatThrownBy(() -> session.steer("turn-fixture", "Rejected input"))
        .isInstanceOfSatisfying(
            SteerDeliveryException.class, error -> assertThat(error.outcomeUnknown()).isFalse());
    assertThat(session.available()).isTrue();
    assertThat(session.completion().isDone()).isFalse();
  }

  @Test
  void lostAcknowledgmentIsUnknownAndDisablesFurtherSteeringWithoutReplay() throws Exception {
    start("timeout");
    assertThatThrownBy(() -> session.steer("turn-fixture", "Only send once"))
        .isInstanceOfSatisfying(
            SteerDeliveryException.class, error -> assertThat(error.outcomeUnknown()).isTrue());
    assertThat(session.available()).isFalse();
    assertThat(session.unavailableReason()).contains("not confirmed");
    assertThatThrownBy(() -> session.steer("turn-fixture", "Do not send again"))
        .isInstanceOfSatisfying(
            SteerDeliveryException.class, error -> assertThat(error.outcomeUnknown()).isFalse());
    assertThat(log().lines().filter(line -> line.contains("\"method\":\"turn/steer\"")).count())
        .isEqualTo(1);
    assertThat(session.completion().isDone()).isFalse();
  }

  @Test
  void unsupportedSteeringAndWrongAcknowledgmentFailClosed() throws Exception {
    start("steer-unsupported");
    assertThatThrownBy(() -> session.steer("turn-fixture", "Input"))
        .isInstanceOfSatisfying(
            SteerDeliveryException.class, error -> assertThat(error.outcomeUnknown()).isFalse());
    assertThat(session.supported()).isFalse();
    session.close();
    start("wrong-id");
    assertThatThrownBy(() -> session.steer("turn-fixture", "Input"))
        .isInstanceOfSatisfying(
            SteerDeliveryException.class, error -> assertThat(error.outcomeUnknown()).isTrue());
    assertThat(session.available()).isFalse();
  }

  @Test
  void serverApprovalsAreRejectedNeverGranted() throws Exception {
    start("server-request");
    long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
    while (!log().contains("no approval was granted") && System.nanoTime() < deadline)
      Thread.sleep(10);
    assertThat(log())
        .contains("approval-fixture", "no approval was granted")
        .doesNotContain("\"decision\":\"accept\"");
    assertThat(session.available()).isTrue();
  }

  @Test
  void normalizedEventsKeepAnswerAndToolAuditButExcludePrivateReasoningAndUsageTotals()
      throws Exception {
    var output = new ArrayList<Map<String, Object>>();
    var adapter = new CodexAppServerEvents(output::add);
    var projection = new AgentOutputStream(json, true);
    start("done");
    session.completion().get(2, TimeUnit.SECONDS);
    events.forEach(adapter::accept);
    output.forEach(event -> projection.append(json.writeValueAsString(event) + "\n"));
    assertThat(projection.display()).isEqualTo("Native answer");
    assertThat(json.writeValueAsString(output))
        .contains("command_execution", "aggregated_output", "exit_code")
        .doesNotContain("private-reasoning", "999999", "tokenUsage");
  }
}
