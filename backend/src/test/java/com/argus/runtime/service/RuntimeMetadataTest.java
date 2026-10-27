package com.argus.runtime.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.common.process.CommandResult;
import com.argus.workspace.domain.Repository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class RuntimeMetadataTest {
  @TempDir Path directory;

  @Test
  void acceptsNpmSemverWithoutCrossLanguageRangeGrammars() {
    for (String range :
        List.of("20", "20.x", ">=18 <21", "^20.2.0", "~20.2", "18 || 20", "18 - 20", "*"))
      assertThat(NodeRuntimeService.validRange(range)).as(range).isTrue();
    for (String range : List.of("[18,21)", "garbage", "20; echo secret", "../../node"))
      assertThat(NodeRuntimeService.validRange(range)).as(range).isFalse();
    assertThat(NodeRuntimeService.satisfies("20.20.0", ">=18 <21")).isTrue();
    assertThat(NodeRuntimeService.satisfies("25.9.0", ">=18 <21")).isFalse();
    assertThat(NodeRuntimeService.satisfies("21.0.0-beta.1", ">=20")).isFalse();
  }

  @Test
  void readsLiteralJavaDeclarationsWithoutGuessingPropertyDigits() {
    assertThat(
            JavaProjectService.parseGradleJavaDeclarations(
                "sourceCompatibility = JavaVersion.VERSION_17\n targetCompatibility = '17'\n java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }"))
        .containsEntry("sourceLevel", "17")
        .containsEntry("toolchainLevel", "21");
    assertThat(
            JavaProjectService.parseGradleJavaDeclarations(
                    "sourceCompatibility = project.java17Version")
                .get("unresolved"))
        .isEqualTo(List.of("project.java17Version"));
    assertThat(
            JavaProjectService.parseMavenJavaDeclarations(
                "<properties><java.version>${compiler.version}</java.version><compiler.version>17</compiler.version></properties>"))
        .containsEntry("sourceLevel", "17");
    assertThat(JavaProjectService.gradleJavaCompatibility("7.6.4"))
        .containsEntry("maximumRuntime", 19);
    assertThat(JavaProjectService.gradleJavaCompatibility("10.0")).isNull();
  }

  @Test
  void detectsRunnableSpringModuleOverEmptyParentConfig() throws Exception {
    Files.writeString(directory.resolve("gradlew"), "fixture");
    Files.createDirectories(directory.resolve("src/main/resources"));
    Files.writeString(directory.resolve("src/main/resources/application.yml"), "");
    Files.createDirectories(directory.resolve("web-service/src/main/resources"));
    Files.writeString(
        directory.resolve("web-service/src/main/resources/application.yml"),
        "server:\n  port: ${SERVER_PORT:8081}\nmanagement:\n  server:\n    port: 10104\n");
    Files.createDirectories(directory.resolve("web-service/src/main/java/example"));
    Files.writeString(
        directory.resolve("web-service/src/main/java/example/App.java"),
        "@SpringBootApplication class App {void main(){SpringApplication.run(App.class);}}");
    var detector = new RuntimeDetector(null);
    assertThat(detector.detect(directory, "service"))
        .containsEntry("args", List.of(":web-service:bootRun"))
        .containsEntry("port", 8081)
        .containsEntry("managementPort", 10104);
  }

  @Test
  void failsClosedForUnavailableDeclaredJavaRuntime() throws Exception {
    Files.writeString(directory.resolve("build.gradle"), "sourceCompatibility = 17\n");
    Files.createDirectories(directory.resolve("gradle/wrapper"));
    Files.writeString(
        directory.resolve("gradle/wrapper/gradle-wrapper.properties"),
        "distributionUrl=https://services.gradle.org/distributions/gradle-7.6-bin.zip");
    var java =
        new JavaProjectService(
            (command, args, cwd, timeout) -> new CommandResult("", "", 0), Map.of());
    var repo = new Repository("fixture", "fixture", directory.toString(), "now", "main");
    assertThatThrownBy(() -> java.resolveRuntimeEnvironment(repo, Map.of()))
        .hasMessageContaining("no compatible installed JDK");
  }
}
