package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ConflictException;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.dto.WorkspaceResponse;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class RuntimePortServiceTest {
  @TempDir Path directory;
  private final WorkspaceService workspace = mock(WorkspaceService.class);
  private final RuntimeConfigurationService runtime = mock(RuntimeConfigurationService.class);
  private final ProcessManager processes = mock(ProcessManager.class);
  private final PortInventoryService inventory = mock(PortInventoryService.class);
  private final ApplicationConfigService application = new ApplicationConfigService();
  private LocalEnvironmentService local;
  private RuntimePortService service;
  private Repository repository;
  private Map<String, Object> saved;
  private Path yaml;
  private final List<Map<String, Object>> configurations = new ArrayList<>();

  @BeforeEach
  void setup() throws Exception {
    repository = new Repository("repo", "Fixture", directory.toString(), "now");
    yaml = directory.resolve("web/src/main/resources/application.yml");
    Files.createDirectories(yaml.getParent());
    Files.writeString(
        yaml,
        "# 🚀 local only\r\nserver:\r\n    port : '${SERVER_PORT:8080}' # keep\r\nmanagement:\r\n  server:\r\n    port: 9100\r\nsecret: keep-it-private\r\n");
    saved =
        object(
            "id",
            "cfg",
            "repositoryId",
            "repo",
            "name",
            "Fixture",
            "port",
            8080,
            "managementPort",
            9100,
            "executable",
            "./gradlew",
            "args",
            List.of(":web:bootRun"),
            "cwd",
            ".",
            "configFile",
            "web/src/main/resources/application.yml",
            "env",
            Map.of());
    configurations.add(saved);
    when(workspace.requireRepository("repo")).thenReturn(repository);
    when(workspace.runConfiguration("cfg")).thenAnswer(call -> saved);
    when(workspace.snapshot())
        .thenAnswer(
            call ->
                new WorkspaceResponse(
                    1, "repo", Map.of(), List.of(repository), configurations, List.of(), Map.of()));
    when(workspace.updateRunConfiguration(eq("cfg"), anyMap()))
        .thenAnswer(
            call -> {
              saved.putAll(call.getArgument(1));
              return copyMap(saved);
            });
    when(runtime.resolve(eq(repository), anyMap()))
        .thenAnswer(call -> copyMap(call.getArgument(1)));
    when(runtime.secretEnvironment(anyMap()))
        .thenAnswer(
            call -> {
              var env = new java.util.LinkedHashMap<String, String>();
              map(map(call.getArgument(0)).get("env"))
                  .forEach((key, value) -> env.put(key, text(value)));
              return env;
            });
    when(runtime.protectedEnvironmentKeys(anyMap())).thenReturn(Set.of());
    when(inventory.snapshot(true))
        .thenReturn(object("available", true, "listeners", List.of(), "configurations", List.of()));
    local =
        new LocalEnvironmentService(
            new ArgusProperties(directory.resolve("private-data"), directory, "test", "token"));
    service = new RuntimePortService(workspace, runtime, application, local, processes, inventory);
  }

  private Map<String, Object> update(int port) {
    var metadata = service.inspect("cfg");
    assertThat(metadata).containsEntry("editable", true);
    return service.update(
        "cfg",
        object(
            "applicationPort",
            port,
            "configFile",
            metadata.get("configFile"),
            "expectedContentHash",
            metadata.get("contentHash")));
  }

  @Test
  void nodeHeaderEditsTheActualLaunchAndLocalEnvironmentWithoutTouchingPackageJson()
      throws Exception {
    String source = "{\"scripts\":{\"dev\":\"next dev\"}}";
    Files.writeString(directory.resolve("package.json"), source);
    saved.putAll(
        object(
            "executable",
            "npm",
            "args",
            List.of("run", "dev", "--", "--port", "3000"),
            "configFile",
            "",
            "port",
            3000));
    local.write("cfg", "PORT=3000\nSERVER_PORT=8080\nKEEP=private", "dotenv");
    when(runtime.resolve(eq(repository), anyMap()))
        .thenAnswer(
            call ->
                RuntimeDetector.applyEnvironmentPorts(
                    copyMap(call.getArgument(1)), local.resolve("cfg")));
    when(processes.getByConfiguration("cfg")).thenReturn(object("id", "running", "running", true));
    var metadata = service.inspect("cfg");
    assertThat(metadata).containsEntry("editable", true).containsEntry("editMode", "launch");
    assertThat(update(3400)).containsEntry("restartRequired", true);
    assertThat(service.inspect("cfg")).containsEntry("applicationPort", 3400);
    assertThat(saved.get("args")).isEqualTo(List.of("run", "dev", "--", "--port", "3400"));
    assertThat(saved).containsEntry("port", 3400);
    assertThat(local.resolve("cfg")).containsEntry("PORT", "3400").containsEntry("KEEP", "private");
    assertThat(Files.readString(directory.resolve("package.json"))).isEqualTo(source);
    assertNoLaunch();
  }

  @Test
  void launchEditsRejectConcurrentConfigPackageOrEnvironmentChanges() throws Exception {
    Files.writeString(directory.resolve("package.json"), "{\"scripts\":{\"dev\":\"vite\"}}");
    saved.putAll(object("executable", "pnpm", "args", List.of("run", "dev"), "configFile", ""));
    for (String change : List.of("command", "package", "environment")) {
      var before = service.inspect("cfg");
      assertThat(before).containsEntry("editable", true);
      if (change.equals("command")) saved.put("args", List.of("run", "dev", "--host"));
      else if (change.equals("package"))
        Files.writeString(
            directory.resolve("package.json"), "{\"scripts\":{\"dev\":\"vite --host\"}}");
      else local.write("cfg", "PORT=5000", "dotenv");
      assertThatThrownBy(
              () ->
                  service.update(
                      "cfg",
                      object(
                          "applicationPort",
                          3401,
                          "configFile",
                          "",
                          "expectedContentHash",
                          before.get("contentHash"))))
          .isInstanceOf(ConflictException.class);
    }
    assertNoLaunch();
  }

  @Test
  void unknownShellScriptsCannotBeMisrepresentedAsEditableLaunches() throws Exception {
    saved.putAll(object("executable", "npm", "args", List.of("run", "dev"), "configFile", ""));
    for (String script :
        List.of(
            "next dev --port 3000",
            "next dev -p3000",
            "next dev --port",
            "PORT=3000 next dev",
            "node server.js",
            "vite && another-command")) {
      Files.writeString(
          directory.resolve("package.json"), "{\"scripts\":{\"dev\":\"" + script + "\"}}");
      assertThat(service.inspect("cfg")).containsEntry("editable", false);
    }
    Files.writeString(directory.resolve("package.json"), "{\"scripts\":{\"dev\":\"next dev\"}}");
    saved.put("args", List.of("run", "dev", "--workspace=web"));
    assertThat(service.inspect("cfg")).containsEntry("editable", false);
    saved.put("args", List.of("run", "dev", "--", "-p3000"));
    update(3500);
    assertThat(saved.get("args")).isEqualTo(List.of("run", "dev", "--", "--port", "3500"));
  }

  @Test
  void editsActualModuleYamlPreservingEveryOtherByteAndManagement() throws Exception {
    String original = Files.readString(yaml);
    var inspected = service.inspect("cfg");
    assertThat(inspected)
        .containsEntry("applicationPort", 8080)
        .containsEntry("managementPort", 9100)
        .containsEntry("editable", true)
        .doesNotContainKeys("source", "content", "environment");
    assertThat(inspected.toString()).doesNotContain("keep-it-private", "SERVER_PORT");
    assertThat(update(8088))
        .containsEntry("applicationPort", 8088)
        .containsEntry("managementPort", 9100)
        .containsEntry("restartRequired", false);
    assertThat(Files.readString(yaml))
        .isEqualTo(original.replace("SERVER_PORT:8080", "SERVER_PORT:8088"));
    assertThat(saved).containsEntry("port", 8088).containsEntry("managementPort", 9100);
    assertNoLaunch();
  }

  // Verifying specific mutations avoids flagging the legitimate running-state read.
  private void assertNoLaunch() {
    verify(processes, never()).start(anyMap(), any(), anyMap());
    verify(processes, never()).stop(anyString());
  }

  @Test
  void localPortOverrideUpdatesWithYamlAndSavedServiceButOtherEnvironmentIsUntouched()
      throws Exception {
    local.write("cfg", "SERVER_PORT=8111\nTOKEN=private-token\nTEXT=\"a;b\\nc\"", "dotenv");
    var before = local.resolve("cfg");
    when(processes.getByConfiguration("cfg")).thenReturn(object("id", "process", "running", true));
    assertThat(service.inspect("cfg")).containsEntry("applicationPort", 8111);
    assertThat(update(8112))
        .containsEntry("restartRequired", true)
        .containsEntry("environmentUpdated", true);
    assertThat(local.resolve("cfg"))
        .containsEntry("SERVER_PORT", "8112")
        .containsEntry("TOKEN", before.get("TOKEN"))
        .containsEntry("TEXT", before.get("TEXT"));
    assertThat(Files.readString(yaml)).contains("${SERVER_PORT:8112}");
    assertNoLaunch();
  }

  @Test
  void supportsCustomPlaceholderPortAndInlineStandardOverride() throws Exception {
    Files.writeString(yaml, "server:\n  port: ${PORT:8080}\n");
    local.write("cfg", "PORT=8211\nMANAGEMENT_SERVER_PORT=9010", "dotenv");
    saved.put("env", Map.of("SERVER_PORT", "8212", "OTHER", "retained"));
    assertThat(service.inspect("cfg")).containsEntry("applicationPort", 8212);
    update(8213);
    assertThat(local.resolve("cfg"))
        .containsEntry("PORT", "8213")
        .containsEntry("MANAGEMENT_SERVER_PORT", "9010");
    assertThat(map(saved.get("env")))
        .containsEntry("SERVER_PORT", "8213")
        .containsEntry("OTHER", "retained");
    assertThat(Files.readString(yaml)).isEqualTo("server:\n  port: ${PORT:8213}\n");
  }

  @Test
  void explicitManagementEditIsOptionalAndCanNeverCollideWithApplication() throws Exception {
    var metadata = service.inspect("cfg");
    assertThatThrownBy(() -> update(9100)).hasMessageContaining("must be different");
    service.update(
        "cfg",
        object(
            "applicationPort",
            8300,
            "managementPort",
            9300,
            "configFile",
            metadata.get("configFile"),
            "expectedContentHash",
            metadata.get("contentHash")));
    assertThat(saved).containsEntry("managementPort", 9300);
    assertThat(Files.readString(yaml)).contains("port: 9300");
  }

  @Test
  void concurrentYamlChangeAndWrongFileAreRejectedWithoutAnyWrite() throws Exception {
    var metadata = service.inspect("cfg");
    String current = Files.readString(yaml) + "new: user-edit\r\n";
    Files.writeString(yaml, current);
    assertThatThrownBy(
            () ->
                service.update(
                    "cfg",
                    object(
                        "applicationPort",
                        8089,
                        "configFile",
                        metadata.get("configFile"),
                        "expectedContentHash",
                        metadata.get("contentHash"))))
        .isInstanceOf(ConflictException.class);
    assertThatThrownBy(
            () ->
                service.update(
                    "cfg",
                    object(
                        "applicationPort",
                        8089,
                        "configFile",
                        "src/main/resources/application.yml",
                        "expectedContentHash",
                        ApplicationConfigService.contentHash(current))))
        .isInstanceOf(ConflictException.class);
    assertThat(Files.readString(yaml)).isEqualTo(current);
    verify(workspace, never()).updateRunConfiguration(anyString(), anyMap());
  }

  @Test
  void unavailableListenersExternalListenersAndOtherConfiguredPortsFailClosed() throws Exception {
    String before = Files.readString(yaml);
    for (var snapshot :
        List.of(
            object("available", false),
            object("available", true, "listeners", List.of(object("port", 8089))),
            object(
                "available",
                true,
                "configurations",
                List.of(object("id", "another", "managementPort", 8089))))) {
      when(inventory.snapshot(true)).thenReturn(snapshot);
      assertThatThrownBy(() -> update(8089)).isInstanceOf(ConflictException.class);
      assertThat(Files.readString(yaml)).isEqualTo(before);
    }
  }

  @Test
  void rollbackRestoresYamlAndLocalEnvironmentWhenServicesSaveFails() throws Exception {
    local.write("cfg", "SERVER_PORT=8111\nTOKEN=retained", "dotenv");
    String yamlBefore = Files.readString(yaml), envBefore = local.editable("cfg", "dotenv");
    when(workspace.updateRunConfiguration(eq("cfg"), anyMap()))
        .thenThrow(new IllegalStateException("fixture write failure"))
        .thenAnswer(
            call -> {
              saved.putAll(call.getArgument(1));
              return copyMap(saved);
            });
    assertThatThrownBy(() -> update(8112)).hasMessageContaining("fixture write failure");
    assertThat(Files.readString(yaml)).isEqualTo(yamlBefore);
    assertThat(local.editable("cfg", "dotenv")).isEqualTo(envBefore);
    assertThat(saved).containsEntry("port", 8080);
  }

  @Test
  void commandSecretAndSharedConfigurationAmbiguityIsReadOnly() {
    saved.put("args", List.of(":web:bootRun", "--args=--server.port=8888"));
    assertThat(service.inspect("cfg"))
        .containsEntry("editable", false)
        .hasEntrySatisfying(
            "reason", reason -> assertThat(reason.toString()).contains("Custom command"));
    saved.put("args", List.of(":web:bootRun"));
    saved.put("env", Map.of("SERVER_PORT", "8080"));
    when(runtime.protectedEnvironmentKeys(anyMap())).thenReturn(Set.of("SERVER_PORT"));
    assertThat(service.inspect("cfg"))
        .containsEntry("editable", false)
        .hasEntrySatisfying(
            "reason", reason -> assertThat(reason.toString()).contains("protected"));
    when(runtime.protectedEnvironmentKeys(anyMap())).thenReturn(Set.of());
    configurations.add(
        object("id", "other", "repositoryId", "repo", "configFile", saved.get("configFile")));
    assertThat(service.inspect("cfg"))
        .containsEntry("editable", false)
        .hasEntrySatisfying("reason", reason -> assertThat(reason.toString()).contains("share"));
  }

  @Test
  void failedPersistenceRemovesNewKeysFromLegacyConfiguration() throws Exception {
    saved.remove("managementPort");
    var before = copyMap(saved);
    String yamlBefore = Files.readString(yaml);
    var metadata = service.inspect("cfg");
    when(workspace.updateRunConfiguration(eq("cfg"), anyMap()))
        .thenAnswer(
            call -> {
              saved.putAll(call.getArgument(1));
              throw new IllegalStateException("fixture write failure");
            })
        .thenAnswer(
            call -> {
              saved.putAll(call.getArgument(1));
              return copyMap(saved);
            });
    assertThatThrownBy(
            () ->
                service.update(
                    "cfg",
                    object(
                        "applicationPort",
                        8200,
                        "managementPort",
                        9200,
                        "configFile",
                        metadata.get("configFile"),
                        "expectedContentHash",
                        metadata.get("contentHash"))))
        .hasMessageContaining("fixture write failure");
    assertThat(saved).isEqualTo(before).doesNotContainKey("managementPort");
    assertThat(Files.readString(yaml)).isEqualTo(yamlBefore);
  }

  @Test
  void rejectsUnsafeYamlWithoutExposingItsContent() throws Exception {
    for (String source :
        List.of(
            "server:\n  port: 8080\n---\nsecret: private-secret\n",
            "server:\n  port: 8080\nserver.port: 9090\n",
            "server:\n  port: 8080\n  port: 9090\n",
            "server: &server\n  port: 8080\nalias: *server\n",
            "{logging: {level: INFO}}\n",
            "logging: INFO\n...\n",
            "server.port: |\n  8080\n",
            "server.port: !private-tag 8080\n",
            "server.port: !!str 8080\n",
            "server:\n  port: private-secret\n")) {
      Files.writeString(yaml, source);
      assertThat(service.inspect("cfg")).containsEntry("editable", false);
      assertThat(service.inspect("cfg").toString()).doesNotContain("private-secret");
      assertThat(Files.readString(yaml)).isEqualTo(source);
    }
  }

  @Test
  void defaultPortCanBeAddedAndProfileSiblingsRequireAnAuthoritativeLocalOverride()
      throws Exception {
    Files.writeString(yaml, "logging:\n  level: INFO\n");
    update(8123);
    assertThat(Files.readString(yaml)).isEqualTo("logging:\n  level: INFO\nserver.port: 8123\n");
    Path profile = yaml.resolveSibling("application-local.yml");
    Files.writeString(profile, "server.port: 9999\n");
    assertThat(service.inspect("cfg"))
        .containsEntry("editable", true)
        .containsEntry("environmentOverrideRequired", true)
        .containsEntry("applicationPort", null);
    assertThatThrownBy(() -> application.inspectPorts(directory, text(saved, "configFile")))
        .hasMessageContaining("Multiple application or profile");
    update(8124);
    assertThat(local.resolve("cfg")).containsEntry("SERVER_PORT", "8124");
    assertThat(Files.readString(profile)).isEqualTo("server.port: 9999\n");
  }

  @Test
  void profilesAndImportsPreserveYamlWhileInstallingAnAuthoritativeLocalPort() throws Exception {
    String original =
        "# preserve configuration selection\n"
            + "spring:\n  profiles:\n    active: ${APP_PROFILE:local}\n"
            + "  config:\n    import: optional:file:./private-settings.yml\n"
            + "server:\n  port: '${PORT:8080}' # keep\n"
            + "management:\n  server:\n    port: 9100\n";
    Files.writeString(yaml, original);
    local.write("cfg", "PORT=8200\nTOKEN=private-token", "dotenv");
    assertThatThrownBy(() -> application.inspectPorts(directory, text(saved, "configFile")))
        .hasMessageContaining("selects profiles or imports");
    var metadata = service.inspect("cfg");
    assertThat(metadata)
        .containsEntry("editable", true)
        .containsEntry("environmentOverrideRequired", true)
        .containsEntry("applicationPort", null)
        .containsEntry("managementPort", null)
        .containsEntry("savedApplicationPort", 8080)
        .containsEntry("environmentFile", ".argus-data/environments/cfg.env")
        .hasEntrySatisfying("contentHash", value -> assertThat(value.toString()).hasSize(64))
        .hasEntrySatisfying(
            "editNotice", value -> assertThat(value.toString()).contains("SERVER_PORT"));
    assertThat(metadata.toString()).doesNotContain("private-token", "private-settings");
    assertThat(update(8201)).containsEntry("environmentUpdated", true);
    assertThat(Files.readString(yaml)).isEqualTo(original.replace("PORT:8080", "PORT:8201"));
    assertThat(local.resolve("cfg"))
        .containsEntry("SERVER_PORT", "8201")
        .containsEntry("PORT", "8201")
        .containsEntry("TOKEN", "private-token")
        .doesNotContainKey("MANAGEMENT_SERVER_PORT");
    assertThat(saved)
        .containsEntry("port", 8201)
        .containsEntry("managementPort", 9100)
        .containsEntry("environmentKeys", List.of("PORT", "SERVER_PORT", "TOKEN"))
        .containsEntry("environmentFile", ".argus-data/environments/cfg.env")
        .containsEntry("environmentFormat", "dotenv");
    assertThat(service.inspect("cfg"))
        .containsEntry("applicationPort", 8201)
        .containsEntry("managementPort", null);
    assertNoLaunch();
  }

  @Test
  void profilesAndImportsRespectExistingStandardOverridesAndOptionalManagementEdits()
      throws Exception {
    Files.writeString(
        yaml, "spring.profiles.active: local\nserver.port: 8080\nmanagement.server.port: 9100\n");
    local.write("cfg", "SERVER_PORT=8210\nMANAGEMENT_SERVER_PORT=9210\nTOKEN=retained", "dotenv");
    var metadata = service.inspect("cfg");
    assertThat(metadata)
        .containsEntry("editable", true)
        .containsEntry("applicationPort", 8210)
        .containsEntry("managementPort", 9210);
    service.update(
        "cfg",
        object(
            "applicationPort",
            8211,
            "managementPort",
            9211,
            "configFile",
            metadata.get("configFile"),
            "expectedContentHash",
            metadata.get("contentHash")));
    assertThat(local.resolve("cfg"))
        .containsEntry("SERVER_PORT", "8211")
        .containsEntry("MANAGEMENT_SERVER_PORT", "9211")
        .containsEntry("TOKEN", "retained");
    assertThat(Files.readString(yaml))
        .isEqualTo(
            "spring.profiles.active: local\nserver.port: 8211\nmanagement.server.port: 9211\n");
  }

  @Test
  void localOverrideModeStillRejectsHigherPrecedenceAndProtectedPortSources() throws Exception {
    String original = "spring.profiles.active: local\nserver.port: 8080\n";
    Files.writeString(yaml, original);
    for (String key :
        List.of(
            "SPRING_APPLICATION_JSON",
            "JAVA_TOOL_OPTIONS",
            "JDK_JAVA_OPTIONS",
            "_JAVA_OPTIONS",
            "JAVA_OPTS",
            "GRADLE_OPTS",
            "MAVEN_OPTS")) {
      saved.put("env", Map.of(key, "private-override"));
      var metadata = service.inspect("cfg");
      assertThat(metadata).containsEntry("editable", false);
      assertThat(metadata.toString()).doesNotContain("private-override");
      assertThatThrownBy(() -> service.update("cfg", object("applicationPort", 8089)))
          .hasMessageContaining("JVM environment overrides");
    }
    saved.put("env", Map.of());
    when(runtime.protectedEnvironmentKeys(anyMap())).thenReturn(Set.of("SERVER_PORT"));
    assertThat(service.inspect("cfg")).containsEntry("editable", false);
    when(runtime.protectedEnvironmentKeys(anyMap())).thenReturn(Set.of());
    saved.put("args", List.of(":web:bootRun", "--args=--server.port=8888"));
    assertThat(service.inspect("cfg")).containsEntry("editable", false);
    assertThat(Files.readString(yaml)).isEqualTo(original);
    assertThat(local.resolve("cfg")).isEmpty();
    verify(workspace, never()).updateRunConfiguration(anyString(), anyMap());
  }

  @Test
  void localOverrideCannotAliasApplicationAndManagementPortVariables() throws Exception {
    for (String ports :
        List.of(
            "server.port: 8080\nmanagement.server.port: ${SERVER_PORT:9100}\n",
            "server.port: ${MANAGEMENT_SERVER_PORT:8080}\nmanagement.server.port: 9100\n",
            "server.port: ${SHARED_PORT:8080}\nmanagement.server.port: ${SHARED_PORT:9100}\n")) {
      String original = "spring.profiles.active: local\n" + ports;
      Files.writeString(yaml, original);
      assertThat(service.inspect("cfg"))
          .containsEntry("editable", false)
          .hasEntrySatisfying(
              "reason", reason -> assertThat(reason.toString()).contains("share one environment"));
      assertThatThrownBy(() -> service.update("cfg", object("applicationPort", 8200)))
          .hasMessageContaining("share one environment");
      assertThat(Files.readString(yaml)).isEqualTo(original);
      assertThat(local.resolve("cfg")).isEmpty();
    }
    verify(workspace, never()).updateRunConfiguration(anyString(), anyMap());
  }

  @Test
  void localOverrideModeRetainsConcurrentFileGuardAndRollsBackNewEnvironmentKey() throws Exception {
    String original = "spring.config.import: optional:file:./settings.yml\nserver.port: 8080\n";
    Files.writeString(yaml, original);
    local.write("cfg", "TOKEN=retained", "dotenv");
    String environmentBefore = local.editable("cfg", "dotenv");
    var metadata = service.inspect("cfg");
    Files.writeString(yaml, original + "user.edit: retained\n");
    assertThatThrownBy(
            () ->
                service.update(
                    "cfg",
                    object(
                        "applicationPort", 8200,
                        "configFile", metadata.get("configFile"),
                        "expectedContentHash", metadata.get("contentHash"))))
        .isInstanceOf(ConflictException.class);
    assertThat(local.editable("cfg", "dotenv")).isEqualTo(environmentBefore);
    verify(workspace, never()).updateRunConfiguration(anyString(), anyMap());
    Files.writeString(yaml, original);
    when(workspace.updateRunConfiguration(eq("cfg"), anyMap()))
        .thenThrow(new IllegalStateException("fixture write failure"))
        .thenAnswer(
            call -> {
              saved.putAll(call.getArgument(1));
              return copyMap(saved);
            });
    assertThatThrownBy(() -> update(8200)).hasMessageContaining("fixture write failure");
    assertThat(Files.readString(yaml)).isEqualTo(original);
    assertThat(local.editable("cfg", "dotenv")).isEqualTo(environmentBefore);
    assertThat(local.resolve("cfg")).doesNotContainKey("SERVER_PORT");
    assertThat(saved)
        .containsEntry("port", 8080)
        .doesNotContainKeys("environmentKeys", "environmentFile", "environmentUpdatedAt");
  }

  @Test
  void detectionDoesNotCreateOrChangeServicesConfiguration() {
    when(runtime.resolve(repository, null))
        .thenReturn(object("port", 8123, "configFile", "web/src/main/resources/application.yml"));
    assertThat(service.repositoryPorts("repo"))
        .containsEntry("applicationPort", 8123)
        .containsEntry("editable", false);
    verify(workspace, never()).saveRunConfiguration(anyMap());
    verify(workspace, never()).updateRunConfiguration(anyString(), anyMap());
  }

  @Test
  void customSavedYamlOutsideTheLaunchedModuleIsReadOnly() throws Exception {
    Path custom = directory.resolve("unrelated/application.yml");
    Files.createDirectories(custom.getParent());
    Files.writeString(custom, "server.port: 8777\n");
    saved.put("configFile", "unrelated/application.yml");
    assertThat(service.inspect("cfg"))
        .containsEntry("editable", false)
        .hasEntrySatisfying(
            "reason",
            reason -> assertThat(reason.toString()).contains("outside the launched module"));
    assertThatThrownBy(
            () ->
                service.update(
                    "cfg",
                    object(
                        "applicationPort",
                        8778,
                        "configFile",
                        "unrelated/application.yml",
                        "expectedContentHash",
                        ApplicationConfigService.contentHash(Files.readString(custom)))))
        .hasMessageContaining("outside the launched module");
    assertThat(Files.readString(custom)).isEqualTo("server.port: 8777\n");
  }

  @Test
  void usesResolvedModuleAfterAutoRepairInsteadOfTheStaleSavedRootYaml() throws Exception {
    Path stale = directory.resolve("src/main/resources/application.yml");
    Files.createDirectories(stale.getParent());
    Files.writeString(stale, "server.port: 8777\n");
    saved.put("configFile", "src/main/resources/application.yml");
    saved.put("args", List.of(":bootRun"));
    when(runtime.resolve(eq(repository), anyMap()))
        .thenAnswer(
            call -> {
              var resolved = copyMap(map(call.getArgument(1)));
              resolved.put("args", List.of(":web:bootRun"));
              resolved.put("configFile", "web/src/main/resources/application.yml");
              return resolved;
            });
    assertThat(update(8089)).containsEntry("configFile", "web/src/main/resources/application.yml");
    assertThat(Files.readString(yaml)).contains("${SERVER_PORT:8089}");
    assertThat(Files.readString(stale)).isEqualTo("server.port: 8777\n");
  }

  @Test
  void rechecksParentSymlinksBeforeWriteAndRollback() throws Exception {
    var document = application.inspectPorts(directory, text(saved, "configFile"));
    String updated = application.updatedPorts(document, 8444, null);
    Path outside = Files.createDirectory(directory.resolve("outside"));
    Path outsideYaml = outside.resolve("application.yml");
    Files.writeString(outsideYaml, document.source());
    Path parent = yaml.getParent();
    Files.move(parent, parent.resolveSibling("original-resources"));
    Files.createSymbolicLink(parent, outside);
    assertThatThrownBy(() -> application.writePorts(document, document.hash(), updated))
        .isInstanceOf(ConflictException.class);
    assertThatThrownBy(() -> application.restorePorts(document, document.source()))
        .isInstanceOf(ConflictException.class);
    assertThat(Files.readString(outsideYaml)).isEqualTo(document.source());
  }

  @Test
  void rechecksRepositoryRootIdentityBeforeWriting() throws Exception {
    Path root = Files.createDirectory(directory.resolve("root"));
    Files.writeString(root.resolve("application.yml"), "server.port: 8080\n");
    var document = application.inspectPorts(root, "application.yml");
    Path replacement = Files.createDirectory(directory.resolve("replacement"));
    Files.writeString(replacement.resolve("application.yml"), document.source());
    Files.move(root, directory.resolve("original-root"));
    Files.createSymbolicLink(root, replacement);
    assertThatThrownBy(
            () ->
                application.writePorts(
                    document, document.hash(), application.updatedPorts(document, 8090, null)))
        .isInstanceOf(ConflictException.class);
    assertThat(Files.readString(replacement.resolve("application.yml")))
        .isEqualTo(document.source());
  }
}
