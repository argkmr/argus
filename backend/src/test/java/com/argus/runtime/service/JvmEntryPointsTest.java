package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;

import java.nio.file.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class JvmEntryPointsTest {
  @TempDir Path root;

  private void write(String path, String text) throws Exception {
    Path file = root.resolve(path);
    Files.createDirectories(file.getParent());
    Files.writeString(file, text);
  }

  private String app(String type) {
    return "package example; @SpringBootApplication public class "
        + type
        + " { public static void main(String[] args) { SpringApplication.run("
        + type
        + ".class,args); } }";
  }

  @Test
  void rootApplicationWinsOverACommentedWebModuleAndItsYaml() throws Exception {
    write("gradlew", "fixture");
    write(
        "build.gradle",
        "allprojects { apply plugin: 'application'; mainClassName = 'example.Application' }");
    write("src/main/java/example/Application.java", app("Application"));
    write("web-service/src/main/java/example/Main.java", "/* " + app("Main") + " */");
    write("web-service/src/main/resources/application.yml", "server:\n  port: 9876\n");
    var detected = new RuntimeDetector(null).detect(root, "ticket-fixture");
    assertThat(detected)
        .containsEntry("args", List.of(":bootRun"))
        .containsEntry("modulePath", "")
        .containsEntry("mainClass", "example.Application")
        .containsEntry("entryPointFile", "src/main/java/example/Application.java")
        .containsEntry("configFile", "");
  }

  @Test
  void discoversNestedApplicationWithoutAnyApplicationYamlAndIgnoresTestsAndBuildOutput()
      throws Exception {
    write("gradlew", "fixture");
    write("api/server/src/main/java/example/Server.java", app("Server"));
    write("src/test/java/example/Test.java", app("Test"));
    write("build/generated/src/main/java/example/Generated.java", app("Generated"));
    assertThat(new RuntimeDetector(null).detect(root, "fixture"))
        .containsEntry("args", List.of(":api:server:bootRun"))
        .containsEntry("mainClass", "example.Server");
  }

  @Test
  void multipleRealApplicationsDoNotSilentlyPickTheLargestYaml() throws Exception {
    write("gradlew", "fixture");
    write("one/src/main/java/example/One.java", app("One"));
    write("two/src/main/java/example/Two.java", app("Two"));
    write("two/src/main/resources/application.yml", "server:\n  port: 9876\n");
    assertThatThrownBy(() -> new RuntimeDetector(null).detect(root, "fixture"))
        .hasMessageContaining("Multiple application entry points")
        .hasMessageContaining("example.One")
        .hasMessageContaining("example.Two");
  }

  @Test
  void literalMainClassDeclarationDisambiguatesAndPlainApplicationUsesRun() throws Exception {
    write("gradlew", "fixture");
    write(
        "build.gradle.kts",
        "plugins { application }; application { mainClass.set(\"example.Two\") }");
    write(
        "src/main/java/example/One.java",
        "package example; public class One {public static void main(String... args) {}}");
    write(
        "src/main/java/example/Two.java",
        "package example; public class Two {public static void main(String[] args) {}}");
    assertThat(new RuntimeDetector(null).detect(root, "fixture"))
        .containsEntry("args", List.of(":run"))
        .containsEntry("mainClass", "example.Two");
  }

  @Test
  void stringsAndCommentedCodeAreNotEntryPointsAndExternalSymlinksAreNotRead() throws Exception {
    write(
        "src/main/java/example/Comment.java",
        "// " + app("Comment") + "\n/* " + app("Comment") + " */");
    write(
        "src/main/java/example/Text.java",
        "class Text {String x = \"public static void main(String[] args)\";}");
    Path outside = Files.createTempDirectory("argus-external-entry-test-");
    try {
      Files.writeString(outside.resolve("Outside.java"), app("Outside"));
      Files.createSymbolicLink(
          root.resolve("src/main/java/example/Outside.java"), outside.resolve("Outside.java"));
      assertThat(JvmEntryPoints.inspect(root)).isEmpty();
    } finally {
      Files.deleteIfExists(outside.resolve("Outside.java"));
      Files.deleteIfExists(outside);
    }
  }
}
