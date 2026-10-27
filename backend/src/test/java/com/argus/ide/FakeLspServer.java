package com.argus.ide;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** A real child process speaking framed LSP, isolated to test-generated repositories. */
public final class FakeLspServer {
  private static final ObjectMapper JSON = new ObjectMapper();

  public static void main(String[] args) throws Exception {
    Path log = Path.of(args[0]);
    Files.writeString(log.resolveSibling("pid"), Long.toString(ProcessHandle.current().pid()));
    String file = "";
    for (; ; ) {
      StringBuilder header = new StringBuilder();
      while (!header.toString().endsWith("\r\n\r\n")) {
        int value = System.in.read();
        if (value < 0) return;
        header.append((char) value);
      }
      int length = Integer.parseInt(header.toString().split("\r\n")[0].substring(15).trim());
      JsonNode request = JSON.readTree(System.in.readNBytes(length));
      String method = request.path("method").asText("");
      if (args.length > 1 && "startup-error".equals(args[1]) && "initialize".equals(method)) {
        System.err.println("Missing Eclipse config.ini: fixture startup failure");
        System.err.flush();
        System.exit(7);
      }
      Files.writeString(
          log,
          JSON.writeValueAsString(request) + "\n",
          StandardOpenOption.CREATE,
          StandardOpenOption.APPEND);
      if ("exit".equals(method)) return;
      if (!request.has("id")) {
        if ("textDocument/didOpen".equals(method))
          file = request.path("params").path("textDocument").path("uri").asText();
        if ("initialized".equals(method) && args.length > 1 && "java-ready".equals(args[1])) {
          long deadline = System.nanoTime() + java.time.Duration.ofSeconds(10).toNanos();
          while (!Files.exists(log.resolveSibling("release-ready"))) {
            if (System.nanoTime() > deadline)
              throw new IllegalStateException("Test readiness gate timed out");
            Thread.sleep(10);
          }
          send(
              Map.of(
                  "jsonrpc",
                  "2.0",
                  "method",
                  "language/status",
                  "params",
                  Map.of("type", "ServiceReady", "message", "ServiceReady")));
        }
        continue;
      }
      if (args.length > 1 && "hang".equals(args[1])) continue;
      if ("textDocument/definition".equals(method)
          && args.length > 1
          && "navigation-gate".equals(args[1])) {
        long deadline = System.nanoTime() + java.time.Duration.ofSeconds(10).toNanos();
        while (!Files.exists(log.resolveSibling("release-navigation"))) {
          if (System.nanoTime() > deadline)
            throw new IllegalStateException("Test navigation gate timed out");
          Thread.sleep(10);
        }
      }
      Object result =
          switch (method) {
            case "initialize" -> {
              send(
                  Map.of(
                      "jsonrpc",
                      "2.0",
                      "id",
                      "config",
                      "method",
                      "workspace/configuration",
                      "params",
                      Map.of("items", List.of(Map.of("section", "java")))));
              yield Map.of(
                  "capabilities",
                  Map.of(
                      "definitionProvider",
                      true,
                      "declarationProvider",
                      !(args.length > 1 && "definition-only".equals(args[1])),
                      "typeDefinitionProvider",
                      !(args.length > 1 && "definition-only".equals(args[1])),
                      "referencesProvider",
                      true,
                      "implementationProvider",
                      true,
                      "documentSymbolProvider",
                      true,
                      "workspaceSymbolProvider",
                      true,
                      "executeCommandProvider",
                      Map.of(
                          "commands",
                          args.length > 1 && "java-ready".equals(args[1])
                              ? List.of("java.project.getAll")
                              : List.of()),
                      "textDocumentSync",
                      2));
            }
            case "textDocument/definition",
                    "textDocument/declaration",
                    "textDocument/typeDefinition",
                    "textDocument/references",
                    "textDocument/implementation" ->
                args.length > 1
                        && ("empty-navigation".equals(args[1])
                            || ("empty-declaration".equals(args[1])
                                && "textDocument/declaration".equals(method)))
                    ? List.of()
                    : List.of(
                        Map.of("uri", file, "range", range()),
                        Map.of("uri", "file:///tmp/outside-ide.java", "range", range()));
            case "textDocument/documentSymbol" ->
                List.of(
                    Map.of(
                        "name", "café😀", "kind", 12, "range", range(), "selectionRange", range()));
            case "workspace/symbol" ->
                List.of(
                    Map.of(
                        "name",
                        "café😀",
                        "kind",
                        12,
                        "location",
                        Map.of("uri", file, "range", range())));
            default -> null;
          };
      var response = new LinkedHashMap<String, Object>();
      response.put("jsonrpc", "2.0");
      response.put("id", request.get("id"));
      response.put("result", result);
      send(response);
    }
  }

  private static Map<String, Object> range() {
    return Map.of(
        "start", Map.of("line", 0, "character", 13), "end", Map.of("line", 0, "character", 17));
  }

  private static void send(Object value) throws Exception {
    byte[] bytes = JSON.writeValueAsBytes(value);
    System.out.write(
        ("Content-Length: " + bytes.length + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
    // Deliberately fragment multibyte frames to exercise framing across read boundaries.
    for (byte part : bytes) System.out.write(part);
    System.out.flush();
  }
}
