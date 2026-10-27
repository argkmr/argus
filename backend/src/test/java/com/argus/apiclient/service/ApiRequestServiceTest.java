package com.argus.apiclient.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.apiclient.dto.SendApiRequest;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

class ApiRequestServiceTest {
  @Test
  void resolvesEnvironmentPathAndRepeatedQueryParametersWithoutChangingScope() {
    var service = new ApiRequestService();
    var request =
        new SendApiRequest(
            "standalone-api-client",
            "env",
            "GET",
            "https://{{base}}/orders/:id?old=1",
            Map.of("X-Token", "{{token}}"),
            "",
            Map.of("base", "example.invalid"),
            List.of(Map.of("key", "id", "value", "a/b")),
            List.of(
                Map.of("key", "tag", "value", "one"),
                Map.of("key", "tag", "value", "two"),
                Map.of("key", "disabled", "value", "never", "enabled", false)),
            null);
    var resolved =
        service.resolve(request, Map.of("base", "http://localhost:8181", "token", "local"));
    assertThat(resolved.url()).isEqualTo("http://localhost:8181/orders/a%2Fb?tag=one&tag=two");
    assertThat(resolved.headers()).containsEntry("X-Token", "local");
    assertThatThrownBy(
            () ->
                service.resolve(
                    new SendApiRequest(
                        "", "", "GET", "https://example.test/orders/:id", Map.of(), "", Map.of()),
                    Map.of()))
        .hasMessageContaining("path variables");
    assertThatThrownBy(
            () ->
                service.resolve(
                    new SendApiRequest("", "", "GET", "file:///etc/passwd", Map.of(), "", Map.of()),
                    Map.of()))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void sendsTextMultipartButNeverReadsImportedFilePaths() throws Exception {
    var service = new ApiRequestService();
    var captured = new AtomicReference<String>();
    var contentType = new AtomicReference<String>();
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext(
        "/",
        exchange -> {
          captured.set(
              new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
          contentType.set(exchange.getRequestHeaders().getFirst("Content-Type"));
          byte[] response = "okay".getBytes(StandardCharsets.UTF_8);
          exchange.sendResponseHeaders(200, response.length);
          exchange.getResponseBody().write(response);
          exchange.close();
        });
    server.start();
    try {
      String url = "http://127.0.0.1:" + server.getAddress().getPort() + "/";
      var text =
          new SendApiRequest(
              "",
              "",
              "POST",
              url,
              Map.of(),
              "",
              Map.of(),
              List.of(),
              null,
              Map.of(
                  "body",
                  Map.of(
                      "mode",
                      "formdata",
                      "formdata",
                      List.of(Map.of("key", "name", "value", "{{name}}", "type", "text")))));
      assertThat(service.send(text, Map.of("name", "Anurag")).status()).isEqualTo(200);
      assertThat(captured.get()).contains("name=\"name\"", "Anurag");
      assertThat(contentType.get()).startsWith("multipart/form-data; boundary=");
      var file =
          new SendApiRequest(
              "",
              "",
              "POST",
              url,
              Map.of(),
              "",
              Map.of(),
              List.of(),
              null,
              Map.of(
                  "body",
                  Map.of(
                      "mode",
                      "formdata",
                      "formdata",
                      List.of(
                          Map.of("key", "file", "src", "/private/local-secret", "type", "file")))));
      assertThatThrownBy(() -> service.send(file, Map.of()))
          .hasMessageContaining("File paths from another Postman installation are not used");
    } finally {
      server.stop(0);
    }
  }

  @Test
  void stripsSensitiveHeadersOnCrossOriginRedirectAndBoundsResponseBytes() throws Exception {
    var service = new ApiRequestService();
    var received = new AtomicReference<String>();
    HttpServer destination = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0),
        origin = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    destination.createContext(
        "/",
        exchange -> {
          received.set(exchange.getRequestHeaders().getFirst("Authorization"));
          exchange.sendResponseHeaders(204, -1);
          exchange.close();
        });
    destination.start();
    origin.createContext(
        "/redirect",
        exchange -> {
          exchange
              .getResponseHeaders()
              .set("Location", "http://127.0.0.1:" + destination.getAddress().getPort() + "/");
          exchange.sendResponseHeaders(302, -1);
          exchange.close();
        });
    origin.createContext(
        "/large",
        exchange -> {
          byte[] response = new byte[5_000_001];
          exchange.sendResponseHeaders(200, response.length);
          try {
            exchange.getResponseBody().write(response);
          } finally {
            exchange.close();
          }
        });
    origin.start();
    try {
      String url = "http://127.0.0.1:" + origin.getAddress().getPort();
      assertThat(
              service
                  .send(
                      new SendApiRequest(
                          "",
                          "",
                          "GET",
                          url + "/redirect",
                          Map.of("Authorization", "secret"),
                          "",
                          Map.of()),
                      Map.of())
                  .status())
          .isEqualTo(204);
      assertThat(received.get()).isNull();
      assertThatThrownBy(
              () ->
                  service.send(
                      new SendApiRequest("", "", "GET", url + "/large", Map.of(), "", Map.of()),
                      Map.of()))
          .hasMessageContaining("larger than 5 MB");
    } finally {
      origin.stop(0);
      destination.stop(0);
    }
  }
}
