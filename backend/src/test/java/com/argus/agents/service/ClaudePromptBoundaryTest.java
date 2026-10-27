package com.argus.agents.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.agents.repository.CliProviderAdapterRepository;
import java.util.*;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

class ClaudePromptBoundaryTest {
  @Test
  void extraDirectoriesCannotConsumeNewOrResumedPrompt() {
    var adapter =
        new CliProviderAdapterRepository(new ObjectMapper())
            .list().stream().filter(item -> item.id().equals("claude")).findFirst().orElseThrow();
    for (String session : List.of("", "saved-session")) {
      var input = new HashMap<String, Object>();
      input.put("sessionId", session);
      input.put("model", "sonnet");
      input.put("effort", "auto");
      input.put("prompt", "--a prompt with spaces\nand instructions".repeat(10000));
      input.put("additionalDirectories", List.of("/tmp/repo one", "/tmp/private-kit"));
      var invocation = new CliInvocationService().invocation(adapter, input, 4173);
      var argv = invocation.arguments();
      assertThat(argv.get(argv.size() - 1)).isEqualTo("--");
      assertThat(invocation.stdin()).isEqualTo(input.get("prompt"));
      assertThat(argv).doesNotContain(input.get("prompt").toString());
      assertThat(argv)
          .containsSubsequence("--add-dir", "/tmp/repo one", "--add-dir", "/tmp/private-kit", "--");
      assertThat(Collections.frequency(argv, "--")).isEqualTo(1);
    }
  }
}
