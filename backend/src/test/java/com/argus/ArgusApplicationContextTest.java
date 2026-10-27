package com.argus;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.NONE,
    properties = {
      "argus.data-directory=target/test-data/application-context",
      "argus.source-root=..",
      "ARGUS_MCP_TOKEN=context-test-token"
    })
class ArgusApplicationContextTest {
  @Test
  void contextLoads() {}
}
