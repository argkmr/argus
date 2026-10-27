package com.argus;

import static org.junit.jupiter.api.Assertions.*;

import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import tools.jackson.databind.ObjectMapper;

/**
 * Starts every real native controller together; no legacy listener, model turns or remote writes.
 */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"ARGUS_MCP_TOKEN=native-http-test-token"})
@DirtiesContext
class NativeBackendHttpTest {
  static final java.nio.file.Path DATA =
      java.nio.file.Path.of("target/test-data/native-http-" + java.util.UUID.randomUUID())
          .toAbsolutePath();

  @DynamicPropertySource
  static void settings(DynamicPropertyRegistry registry) {
    registry.add("argus.data-directory", () -> DATA.toString());
    registry.add(
        "argus.source-root",
        () -> java.nio.file.Path.of("..").toAbsolutePath().normalize().toString());
  }

  @LocalServerPort int port;
  @Autowired ObjectMapper json;
  @Autowired com.argus.workspace.service.WorkspaceService workspace;
  final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

  HttpResponse<String> call(String method, String path, String body, String... headers)
      throws Exception {
    var request =
        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
            .timeout(Duration.ofSeconds(10));
    if (headers.length > 0) request.headers(headers);
    return http.send(
        request
            .method(
                method,
                body == null
                    ? HttpRequest.BodyPublishers.noBody()
                    : HttpRequest.BodyPublishers.ofString(body))
            .build(),
        HttpResponse.BodyHandlers.ofString());
  }

  @Test
  void completeNativeApplicationServesStaticUiAndOwnsWorkspaceWithoutFallback() throws Exception {
    assertEquals(200, call("GET", "/", null).statusCode());
    for (String path :
        java.util.List.of(
            "/global-ai",
            "/global-ai/tasks/saved-chat",
            "/repositories/saved-repo/tasks/saved-chat")) {
      var page = call("GET", path, null);
      assertEquals(200, page.statusCode(), path);
      assertTrue(page.body().contains("<html"), path);
    }
    var health = call("GET", "/internal/health", null);
    assertEquals(200, health.statusCode());
    assertTrue(health.body().contains("spring-boot"));
    assertEquals(200, call("GET", "/api/workspace", null).statusCode());
    assertEquals(200, call("GET", "/api/ai-tasks?scope=global", null).statusCode());
    assertEquals(404, call("GET", "/api/does-not-exist", null).statusCode());
    var preferences =
        call(
            "PATCH",
            "/api/preferences",
            "{\"theme\":\"light\"}",
            "Content-Type",
            "application/json");
    assertEquals(200, preferences.statusCode(), preferences.body());
    assertTrue(call("GET", "/api/workspace", null).body().contains("light"));
  }

  @Test
  void privateApiAndShutdownRemainLocalAndTokenProtected() throws Exception {
    assertEquals(
        403,
        call("GET", "/api/workspace", null, "Origin", "https://untrusted.example").statusCode());
    assertEquals(401, call("POST", "/api/internal/maintenance/shutdown", null).statusCode());
    assertEquals(
        403,
        call(
                "POST",
                "/api/internal/maintenance/shutdown",
                null,
                "Authorization",
                "Bearer native-http-test-token",
                "Origin",
                "http://127.0.0.1:" + port)
            .statusCode());
    assertEquals(
        400,
        call("POST", "/api/repository-offboarding/jobs", "{}", "Content-Type", "application/json")
            .statusCode());
  }

  @Test
  void largeAttachmentJsonCanBeDecodedAndOrdinaryRequestLimitsStayBounded() throws Exception {
    var text = "a".repeat(21_000_000);
    var parsed = json.readValue("{\"text\":\"" + text + "\"}", Map.class);
    assertEquals(text, parsed.get("text"));
    var response =
        call(
            "PATCH",
            "/api/preferences",
            "{\"text\":\"" + "a".repeat(2_000_001) + "\"}",
            "Content-Type",
            "application/json");
    assertEquals(413, response.statusCode(), response.body());
  }

  @Test
  void repositoryPortRoutesInspectAndSaveRealFixtureYamlWithoutLaunchingAService()
      throws Exception {
    org.junit.jupiter.api.Assumptions.assumeTrue(System.getProperty("os.name", "").contains("Mac"));
    var root = DATA.resolve("port-fixture");
    var yaml = root.resolve("src/main/resources/application.yml");
    java.nio.file.Files.createDirectories(yaml.getParent());
    String original = "# retain this comment\nserver:\n  port: ${SERVER_PORT:8080}\n";
    java.nio.file.Files.writeString(yaml, original);
    java.nio.file.Files.writeString(
        root.resolve("pom.xml"),
        "<project><modelVersion>4.0.0</modelVersion><groupId>fixture</groupId><artifactId>fixture</artifactId><version>1</version></project>");
    var main = root.resolve("src/main/java/fixture/Application.java");
    java.nio.file.Files.createDirectories(main.getParent());
    java.nio.file.Files.writeString(
        main,
        "package fixture; @SpringBootApplication public class Application { public static void main(String[] args) { SpringApplication.run(Application.class, args); } }");
    var init = new ProcessBuilder("git", "init", root.toString()).redirectErrorStream(true).start();
    assertTrue(init.waitFor(10, java.util.concurrent.TimeUnit.SECONDS));
    assertEquals(0, init.exitValue());
    var repository = workspace.addRepository(root.toString());
    var detected = call("GET", "/api/repositories/" + repository.id() + "/ports", null);
    assertEquals(200, detected.statusCode(), detected.body());
    assertEquals(false, json.readValue(detected.body(), Map.class).get("editable"));
    workspace.saveRunConfiguration(
        Map.of(
            "id",
            "port-fixture",
            "repositoryId",
            repository.id(),
            "name",
            "Fixture",
            "executable",
            "mvn",
            "args",
            java.util.List.of("spring-boot:run"),
            "cwd",
            ".",
            "port",
            8080,
            "configFile",
            "src/main/resources/application.yml",
            "env",
            Map.of("SERVER_PORT", "8080")));
    var response = call("GET", "/api/run-configurations/port-fixture/ports", null);
    assertEquals(200, response.statusCode(), response.body());
    var details = json.readValue(response.body(), Map.class);
    assertEquals(true, details.get("editable"), response.body());
    var inventory = call("GET", "/api/runtime-ports", null);
    assertEquals(200, inventory.statusCode(), inventory.body());
    assertEquals(
        true, json.readValue(inventory.body(), Map.class).get("available"), inventory.body());
    int newPort;
    try (var listener =
        new java.net.ServerSocket(0, 1, java.net.InetAddress.getLoopbackAddress())) {
      newPort = listener.getLocalPort();
      var occupied =
          call(
              "POST",
              "/api/run-configurations/port-fixture/ports",
              json.writeValueAsString(
                  Map.of(
                      "applicationPort",
                      newPort,
                      "configFile",
                      details.get("configFile"),
                      "expectedContentHash",
                      details.get("contentHash"))),
              "Content-Type",
              "application/json");
      assertEquals(409, occupied.statusCode(), occupied.body());
      assertEquals(original, java.nio.file.Files.readString(yaml));
    }
    var saved =
        call(
            "POST",
            "/api/run-configurations/port-fixture/ports",
            json.writeValueAsString(
                Map.of(
                    "applicationPort",
                    newPort,
                    "configFile",
                    details.get("configFile"),
                    "expectedContentHash",
                    details.get("contentHash"))),
            "Content-Type",
            "application/json");
    assertEquals(200, saved.statusCode(), saved.body());
    assertEquals(false, json.readValue(saved.body(), Map.class).get("restartRequired"));
    assertEquals(
        original.replace("8080", String.valueOf(newPort)), java.nio.file.Files.readString(yaml));
    assertEquals(newPort, workspace.runConfiguration("port-fixture").get("port"));
    assertEquals("[]", call("GET", "/api/processes", null).body());
  }
}
