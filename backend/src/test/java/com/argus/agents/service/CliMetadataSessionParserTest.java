package com.argus.agents.service;

import static org.assertj.core.api.Assertions.assertThat;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

class CliMetadataSessionParserTest {
  @TempDir Path directory;

  @Test
  void fragmentedResponseRetainsItsPrefixUntilANewlineArrives() throws Exception {
    try (var parser = parser()) {
      parser.receive("stdout", "{\"id\":1,\"result\":{\"name\":\"caf");
      parser.receive("stdout", "é\"}}");
      assertThat(parser.messages()).isEmpty();
      parser.receive("stdout", "\n");
      assertThat(parser.messages().remove().path("result").path("name").asText()).isEqualTo("café");
      assertThat(parser.buffer()).isEmpty();
      assertThat(parser.failure().get()).isNull();
    }
  }

  @Test
  void multipleLinesPartialTailsAndMalformedDiagnosticsKeepMessageOrder() throws Exception {
    try (var parser = parser()) {
      parser.receive("stdout", "{\"id\":1}\n{\"id\":2}\n{\"id\":");
      assertThat(parser.messages())
          .extracting(node -> node.path("id").asInt())
          .containsExactly(1, 2);
      assertThat(parser.buffer()).isEqualTo("{\"id\":");
      parser.receive("stderr", "{\"id\":99}\n");
      parser.receive("stdout", "3}\n \nnot-json\n{\"id\":4}\n");
      assertThat(parser.messages())
          .extracting(node -> node.path("id").asInt())
          .containsExactly(1, 2, 3, 4);
      assertThat(parser.buffer()).isEmpty();
      assertThat(parser.failure().get()).isNull();
    }
  }

  @Test
  void fragmentedOversizeResponseRetainsTheExactLimitAndIgnoresFurtherOutput() throws Exception {
    try (var parser = parser()) {
      String chunk = "x".repeat(4096);
      for (int index = 0; index < 2048; index++) parser.receive("stdout", chunk);
      assertThat(parser.failure().get()).isNull();
      assertThat(parser.buffer()).hasSize(8 * 1024 * 1024);
      parser.receive("stdout", "x");
      RuntimeException failure = parser.failure().get();
      assertThat(failure).hasMessage("CLI metadata response exceeded its size limit");
      parser.receive("stdout", "{\"id\":1}\n");
      assertThat(parser.failure().get()).isSameAs(failure);
      assertThat(parser.buffer()).hasSize(8 * 1024 * 1024);
      assertThat(parser.messages()).isEmpty();
    }
  }

  private Parser parser() throws Exception {
    // An owned, idle local pipe supplies lifecycle cleanup; no provider is invoked.
    var session =
        new CliMetadataSession(
            "/bin/cat", List.of(), directory, Map.of(), new ObjectMapper(), Duration.ofSeconds(2));
    Method receive =
        CliMetadataSession.class.getDeclaredMethod("receive", String.class, String.class);
    receive.setAccessible(true);
    return new Parser(session, receive);
  }

  private record Parser(CliMetadataSession session, Method receiver) implements AutoCloseable {
    void receive(String stream, String chunk) throws Exception {
      receiver.invoke(session, stream, chunk);
    }

    @SuppressWarnings("unchecked")
    BlockingQueue<JsonNode> messages() throws Exception {
      return (BlockingQueue<JsonNode>) field("messages");
    }

    @SuppressWarnings("unchecked")
    AtomicReference<RuntimeException> failure() throws Exception {
      return (AtomicReference<RuntimeException>) field("failure");
    }

    String buffer() throws Exception {
      return field("line").toString();
    }

    private Object field(String name) throws Exception {
      Field field = CliMetadataSession.class.getDeclaredField(name);
      field.setAccessible(true);
      return field.get(session);
    }

    @Override
    public void close() {
      session.close();
    }
  }
}
