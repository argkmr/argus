package com.argus.runtime.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.common.config.ArgusProperties;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class RuntimeConfigurationTest {
  @TempDir Path directory;

  @Test
  void yamlPortsPreserveCommentsPlaceholdersAndUnrelatedValues() {
    String source = "server:\r\n  port: ${SERVER_PORT:8080} # app\r\nlogging:\r\n  level: INFO\r\n";
    String updated = ApplicationConfigService.setYamlPath(source, List.of("server", "port"), 8081);
    updated =
        ApplicationConfigService.setYamlPath(
            updated, List.of("management", "server", "port"), 10104);
    assertThat(updated)
        .contains(
            "port: ${SERVER_PORT:8081} # app\r\n",
            "logging:\r\n  level: INFO",
            "management:\r\n  server:\r\n    port: 10104");
  }

  @Test
  void environmentRoundTripsLiteralVaultAndBlocksTraversal() throws Exception {
    var properties = new ArgusProperties(directory.resolve("data"), directory, "test", "token");
    var local = new LocalEnvironmentService(properties);
    local.write("config", "{\"KEY\":{\"nested\":true},\"TEXT\":\"a;b\\nc\"}", "vault");
    assertThat(local.resolve("config"))
        .containsEntry("KEY", "{\"nested\":true}")
        .containsEntry("TEXT", "a;b\nc");
    assertThat(local.editable("config", "vault")).contains("\"nested\" : true");
    assertThatThrownBy(() -> local.resolve("../../outside"))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(Files.exists(directory.resolve("data/environments/config.env"))).isTrue();
  }

  @Test
  void applicationConfigRejectsExternalSymlink() throws Exception {
    Path repository = Files.createDirectory(directory.resolve("repo")),
        outside = Files.createDirectory(directory.resolve("outside"));
    Files.createSymbolicLink(repository.resolve("config"), outside);
    var config = new ApplicationConfigService();
    assertThatThrownBy(() -> config.saveContents(repository, "config/application.yml", "secret"))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(Files.exists(outside.resolve("application.yml"))).isFalse();
  }
}
