package com.argus.ide;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.common.config.ArgusProperties;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.dto.WorkspaceResponse;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

/**
 * Opt-in smoke tests use packaged servers and disposable source fixtures, never user repositories.
 */
class BundledLanguageServerIT {
  @TempDir Path temporary;

  private IdeService service(Path root) {
    var workspace = mock(WorkspaceService.class);
    var preferences = new LinkedHashMap<String, Object>();
    when(workspace.requireRepository("fixture"))
        .thenReturn(new Repository("fixture", "Fixture", root.toString(), ""));
    when(workspace.snapshot())
        .thenAnswer(
            ignored ->
                new WorkspaceResponse(
                    1, "fixture", preferences, List.of(), List.of(), List.of(), Map.of()));
    when(workspace.preferences(anyMap()))
        .thenAnswer(
            invocation -> {
              preferences.putAll(invocation.getArgument(0));
              return preferences;
            });
    return new IdeService(
        workspace,
        new IdeFiles(),
        new IdeLanguageServers(
            workspace, new ArgusProperties(temporary.resolve("state"), null, "test", "")),
        new ObjectMapper());
  }

  @Test
  @EnabledIfEnvironmentVariable(named = "ARGUS_IDE_TYPESCRIPT_SERVER", matches = ".+")
  void bundledTypescriptProvidesCrossFileDefinitionsReferencesAndImplementation() throws Exception {
    Path root = Files.createDirectory(temporary.resolve("typescript"));
    Files.writeString(
        root.resolve("tsconfig.json"),
        "{\"compilerOptions\":{\"target\":\"ES2020\",\"module\":\"Node16\",\"moduleResolution\":\"Node16\",\"strict\":true},\"include\":[\"*.ts\"]}");
    Files.writeString(
        root.resolve("greet.ts"),
        "export interface Greeter { greet(): string; }\nexport class English implements Greeter { greet() { return 'hello'; } }\nexport function welcome() { return new English().greet(); }\n");
    Files.writeString(
        root.resolve("main.ts"), "import { welcome } from './greet';\nconsole.log(welcome());\n");
    Files.writeString(
        root.resolve("settings.ts"),
        "export class Settings { readonly port = 8080; }\nexport const DEFAULTS = new Settings();\n");
    String symbols =
        "import { DEFAULTS, Settings } from './settings';\nconst local: Settings = DEFAULTS;\nconsole.log(local.port, DEFAULTS.port, `${local.port}`);\n";
    Files.writeString(root.resolve("symbols.ts"), symbols);
    var ide = service(root);
    try {
      ide.start("fixture", "typescript", false);
      var definition = waitFor(ide, "main.ts", 2, 15, "definition");
      assertTrue(
          definition.locations().stream()
              .anyMatch(item -> item.path().equals("greet.ts") && item.line() == 3),
          definition.toString());
      assertFalse(waitFor(ide, "greet.ts", 3, 20, "references").locations().isEmpty());
      assertFalse(waitFor(ide, "greet.ts", 1, 19, "implementation").locations().isEmpty());
      assertFalse(ide.symbols("fixture", "greet.ts", "").results().isEmpty());
      assertTrue(
          ide.symbols("fixture", null, "welcome").results().stream()
              .anyMatch(item -> item.name().contains("welcome")));
      String usage = symbols.lines().toList().get(2);
      assertLocation(
          waitFor(ide, "symbols.ts", 3, usage.indexOf("local") + 1, "definition"), "symbols.ts", 2);
      assertLocation(
          waitFor(ide, "symbols.ts", 3, usage.indexOf("DEFAULTS") + 1, "declaration"),
          "settings.ts",
          2);
      assertLocation(
          waitFor(ide, "symbols.ts", 3, usage.indexOf("port") + 1, "definition"), "settings.ts", 1);
      assertLocation(
          waitFor(ide, "symbols.ts", 3, usage.indexOf("local") + 1, "typeDefinition"),
          "settings.ts",
          1);
      // JavaScript interpolation must remain ordinary symbol navigation, not Spring config.
      assertLocation(
          waitFor(ide, "symbols.ts", 3, usage.lastIndexOf("local") + 1, "definition"),
          "symbols.ts",
          2);
      // Simulate an external editor changing an already-open target, then navigate from its
      // importer.
      Files.writeString(
          root.resolve("greet.ts"), "\n\n" + Files.readString(root.resolve("greet.ts")));
      var changed = waitFor(ide, "main.ts", 2, 15, "definition");
      assertTrue(
          changed.locations().stream()
              .anyMatch(item -> item.path().equals("greet.ts") && item.line() == 5),
          changed.toString());
    } finally {
      ide.quiesce();
    }
  }

  @Test
  @EnabledIfEnvironmentVariable(named = "ARGUS_IDE_JDTLS_HOME", matches = ".+")
  void bundledJavaProvidesDefinitionsReferencesAndImplementationWithoutBuildExecution()
      throws Exception {
    Path root = Files.createDirectory(temporary.resolve("java"));
    Files.createDirectory(root.resolve("src"));
    Files.writeString(
        root.resolve(".project"),
        "<projectDescription><name>argus-smoke</name><comment></comment><projects></projects><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments></arguments></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>");
    Files.writeString(
        root.resolve(".classpath"),
        "<classpath><classpathentry kind=\"src\" path=\"src\"/><classpathentry kind=\"con\" path=\"org.eclipse.jdt.launching.JRE_CONTAINER\"/><classpathentry kind=\"output\" path=\"bin\"/></classpath>");
    Files.writeString(
        root.resolve("src/Example.java"),
        "interface Greeter { String greet(); }\nclass English implements Greeter { public String greet() { return \"hello\"; } }\npublic class Example {\n  static String welcome() { return new English().greet(); }\n  public static void main(String[] args) { System.out.println(welcome()); }\n}\n");
    Path servicePackage = Files.createDirectories(root.resolve("src/example/service"));
    Path apiPackage = Files.createDirectories(root.resolve("src/example/api"));
    Files.writeString(
        servicePackage.resolve("InvoiceService.java"),
        """
        package example.service;
        public interface InvoiceService {
          String generate();
        }
        """);
    Files.writeString(
        servicePackage.resolve("DefaultInvoiceService.java"),
        """
        package example.service;
        public class DefaultInvoiceService implements InvoiceService {
          @Override public String generate() { return "invoice"; }
        }
        """);
    String controller =
        """
        package example.api;
        import example.service.InvoiceService;
        import example.service.DefaultInvoiceService;
        public class InvoiceController {
          private final InvoiceService service;
          public InvoiceController(InvoiceService service) { this.service = service; }
          public String invoice() { return service.generate(); }
          public String directInvoice() { return new DefaultInvoiceService().generate(); }
        }
        """;
    Files.writeString(apiPackage.resolve("InvoiceController.java"), controller);
    String symbolSource =
        "class Settings {\n  static final int DEFAULT_PORT = 8080;\n  int port = DEFAULT_PORT;\n}\nclass SymbolUse {\n  void run() {\n    Settings local = new Settings();\n    System.out.println(local.port + Settings.DEFAULT_PORT);\n  }\n}\n";
    Files.writeString(root.resolve("src/SymbolUse.java"), symbolSource);
    var ide = service(root);
    try {
      // Reproduce the real settings flow: saving the prefilled bundled Java command must
      // still prepare config.ini in Argus's private Eclipse configuration directory.
      var language =
          ((List<Map<String, Object>>) ide.status("fixture").get("languages"))
              .stream()
                  .filter(item -> "java".equals(item.get("language")))
                  .findFirst()
                  .orElseThrow();
      ide.configure(
          "fixture",
          "java",
          (String) language.get("executable"),
          (List<String>) language.get("args"));
      ide.start("fixture", "java", false);
      var definition = waitFor(ide, "src/Example.java", 5, 63, "definition");
      assertTrue(
          definition.locations().stream().anyMatch(item -> item.line() == 4),
          definition.toString());
      var references = waitFor(ide, "src/Example.java", 4, 18, "references");
      assertTrue(
          references.locations().stream()
              .anyMatch(item -> item.path().equals("src/Example.java") && item.line() == 5),
          references.toString());
      var implementation = waitFor(ide, "src/Example.java", 1, 12, "implementation");
      assertTrue(
          implementation.locations().stream()
              .anyMatch(item -> item.path().equals("src/Example.java") && item.line() == 2),
          implementation.toString());
      assertFalse(ide.symbols("fixture", "src/Example.java", "").results().isEmpty());
      String usage = symbolSource.lines().toList().get(7);
      assertLocation(
          waitFor(ide, "src/SymbolUse.java", 8, usage.indexOf("local") + 1, "definition"),
          "src/SymbolUse.java",
          7);
      assertLocation(
          waitFor(ide, "src/SymbolUse.java", 8, usage.indexOf("port") + 1, "definition"),
          "src/SymbolUse.java",
          3);
      assertLocation(
          waitFor(ide, "src/SymbolUse.java", 8, usage.indexOf("DEFAULT_PORT") + 1, "declaration"),
          "src/SymbolUse.java",
          2);
      assertLocation(
          waitFor(ide, "src/SymbolUse.java", 8, usage.indexOf("local") + 1, "typeDefinition"),
          "src/SymbolUse.java",
          1);
      // A controller using an injected interface is the common service-navigation case.
      // Definition must reach its declaration; implementations must reach the concrete service,
      // even when neither target has been opened and they live in a different package/file.
      String controllerPath = "src/example/api/InvoiceController.java";
      int interfaceCallColumn = controller.lines().toList().get(6).indexOf("generate") + 1;
      var serviceDefinition = waitFor(ide, controllerPath, 7, interfaceCallColumn, "definition");
      assertTrue(
          serviceDefinition.locations().stream()
              .anyMatch(
                  item ->
                      item.path().equals("src/example/service/InvoiceService.java")
                          && item.line() == 3),
          serviceDefinition.toString());
      var serviceImplementation =
          waitFor(ide, controllerPath, 7, interfaceCallColumn, "implementation");
      assertTrue(
          serviceImplementation.locations().stream()
              .anyMatch(
                  item ->
                      item.path().equals("src/example/service/DefaultInvoiceService.java")
                          && item.line() == 3),
          serviceImplementation.toString());
      int concreteCallColumn = controller.lines().toList().get(7).indexOf("generate") + 1;
      var concreteDefinition = waitFor(ide, controllerPath, 8, concreteCallColumn, "definition");
      assertTrue(
          concreteDefinition.locations().stream()
              .anyMatch(
                  item ->
                      item.path().equals("src/example/service/DefaultInvoiceService.java")
                          && item.line() == 3),
          concreteDefinition.toString());
      var serviceReferences =
          waitFor(ide, "src/example/service/InvoiceService.java", 3, 10, "references");
      assertTrue(
          serviceReferences.locations().stream()
              .anyMatch(item -> item.path().equals(controllerPath) && item.line() == 7),
          serviceReferences.toString());
      assertFalse(
          Files.exists(root.resolve("bin/Example.class")), "IDE must not compile the project");
      assertFalse(
          Files.exists(root.resolve("bin/example/api/InvoiceController.class")),
          "Cross-class indexing must not compile the project");
    } finally {
      ide.quiesce();
    }
  }

  private static void assertLocation(IdeService.Navigation result, String path, int line) {
    assertTrue(
        result.locations().stream()
            .anyMatch(item -> item.path().equals(path) && item.line() == line),
        result.toString());
  }

  @Test
  @EnabledIfEnvironmentVariable(named = "ARGUS_IDE_JDTLS_HOME", matches = ".+")
  void trustedMavenImportResolvesUnopenedClassesAndKeepsMetadataPrivateAfterReopen()
      throws Exception {
    Path root = Files.createDirectory(temporary.resolve("maven"));
    Files.writeString(
        root.resolve("pom.xml"),
        """
        <project xmlns="http://maven.apache.org/POM/4.0.0">
          <modelVersion>4.0.0</modelVersion>
          <groupId>com.argus.fixture</groupId><artifactId>navigation</artifactId><version>1.0</version>
          <properties><maven.compiler.source>17</maven.compiler.source><maven.compiler.target>17</maven.compiler.target></properties>
        </project>
        """);
    Path source = Files.createDirectories(root.resolve("src/main/java/example"));
    Files.writeString(
        source.resolve("Handler.java"),
        """
        package example;
        public class Handler {
          public String createReview() { return "review"; }
        }
        """);
    Files.writeString(
        source.resolve("Controller.java"),
        """
        package example;
        public class Controller {
          private final Handler handler = new Handler();
          public String create() { return handler.createReview(); }
        }
        """);
    var ide = service(root);
    try {
      ide.start("fixture", "java", true);
      var definition = waitFor(ide, "src/main/java/example/Controller.java", 4, 44, "definition");
      assertTrue(
          definition.locations().stream()
              .anyMatch(
                  location ->
                      location.path().equals("src/main/java/example/Handler.java")
                          && location.line() == 3),
          definition.toString());
      ide.closeRepository("fixture");
      var stopped = (Map<?, ?>) ((List<?>) ide.status("fixture").get("languages")).get(0);
      assertEquals(true, stopped.get("trustedProject"));
      assertEquals(false, stopped.get("running"));
      var reopened = waitFor(ide, "src/main/java/example/Controller.java", 4, 44, "definition");
      assertEquals(definition.locations(), reopened.locations());
    } finally {
      ide.quiesce();
    }
    for (String metadata : List.of(".project", ".classpath", ".factorypath", ".settings"))
      assertFalse(
          Files.exists(root.resolve(metadata)), "JDT metadata must stay private: " + metadata);
    assertFalse(
        Files.exists(root.resolve("target/classes/example/Controller.class")),
        "Indexing must not compile source");
  }

  private IdeService.Navigation waitFor(
      IdeService ide, String path, int line, int column, String kind) throws InterruptedException {
    IdeService.Navigation result = null;
    long deadline = System.nanoTime() + java.time.Duration.ofSeconds(45).toNanos();
    do {
      result = ide.navigate("fixture", path, line, column, kind);
      if (!result.locations().isEmpty()) return result;
      Thread.sleep(500);
    } while (System.nanoTime() < deadline);
    return result;
  }
}
