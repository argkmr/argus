package com.argus.platform;

import static org.assertj.core.api.Assertions.assertThat;

import com.argus.common.config.ArgusProperties;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class HealthControllerTest {
  @Test
  void identifiesTheMigratedPlatform() {
    ArgusProperties properties =
        new ArgusProperties(Path.of("data"), Path.of("source"), "test-build", "token");
    assertThat(new HealthController(properties).health())
        .containsEntry("frontend", "nextjs")
        .containsEntry("backend", "spring-boot")
        .containsEntry("build", "test-build");
  }
}
