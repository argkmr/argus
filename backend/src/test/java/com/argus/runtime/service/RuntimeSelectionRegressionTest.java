package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.common.process.CommandRunner;
import com.argus.workspace.domain.Repository;
import java.nio.file.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class RuntimeSelectionRegressionTest {
  @TempDir Path root;

  @Test
  void savedRuntimeBinCannotBypassChangedNodeRequirement() throws Exception {
    Files.writeString(root.resolve("package.json"), "{}");
    var node = mock(NodeRuntimeService.class);
    when(node.resolve(root))
        .thenReturn(
            object(
                "version",
                "22.12.0",
                "requirement",
                "22.x",
                "executable",
                "/fixture/node22/bin/node",
                "environment",
                Map.of("PATH", "/fixture/node22/bin:/fixture/base")));
    var service =
        new RuntimeConfigurationService(
            null, new RuntimeDetector(node), null, null, null, null, null, null);
    var original =
        object(
            "executable",
            "npm",
            "runtimeBin",
            "/fixture/node20/bin",
            "runtimeLabel",
            "Node 20.1.0",
            "nodeVersion",
            "20.1.0");
    var result = service.projectRuntime(repository(), original);
    assertThat(map(result.get("environment")))
        .containsEntry("PATH", "/fixture/node22/bin:/fixture/base");
    assertThat(map(result.get("configuration")))
        .containsEntry("runtimeBin", "/fixture/node22/bin")
        .containsEntry("nodeVersion", "22.12.0")
        .containsEntry("requiredNode", "22.x");
    assertThat(original).containsEntry("runtimeBin", "/fixture/node20/bin");
    when(node.resolve(root))
        .thenThrow(new RuntimeCompatibilityException("Declared Node 24 is unavailable"));
    assertThatThrownBy(() -> service.projectRuntime(repository(), original))
        .hasMessageContaining("unavailable");
  }

  @Test
  void nvmCommentsAndReservedLinesAreAcceptedWithoutEvaluatingAnything() throws Exception {
    var node = node("22.12.0", "20.19.0");
    Files.writeString(
        root.resolve(".nvmrc"), "# team runtime\n\n  v20.19.0 # pinned\n reserved=value\n");
    var result = node.resolve(root, object("engines", object("node", ">=18 <21")));
    assertThat(result).containsEntry("version", "20.19.0").containsEntry("requirement", "v20.19.0");
    Files.writeString(root.resolve(".nvmrc"), "20\n22\n");
    assertThatThrownBy(() -> node.resolve(root, Map.of())).hasMessageContaining("exactly one");
  }

  @Test
  void conflictingPinAndPackageEngineFailInsteadOfLaunchingAnIncompatibleVersion()
      throws Exception {
    Files.writeString(root.resolve(".nvmrc"), "20\n");
    assertThatThrownBy(
            () ->
                node("22.12.0", "20.19.0").resolve(root, object("engines", object("node", ">=22"))))
        .isInstanceOf(RuntimeCompatibilityException.class)
        .hasMessageContaining("engines.node >=22");
    assertThatThrownBy(
            () -> node("20.19.0").resolve(root, object("engines", object("node", "[18,22)"))))
        .hasMessageContaining("not a valid semver range");
  }

  @Test
  void implicitLatestNeverSelectsPrereleasesButExplicitPrereleaseCan() throws Exception {
    assertThat(node("26.0.0-rc.1", "24.1.0").resolve(root, Map.of()))
        .containsEntry("version", "24.1.0");
    for (String declaration : List.of("node", "latest", "current")) {
      Files.writeString(root.resolve(".nvmrc"), declaration + "\n");
      assertThat(node("26.0.0-rc.1", "24.1.0").resolve(root, Map.of()))
          .containsEntry("version", "24.1.0");
    }
    Files.writeString(root.resolve(".nvmrc"), "26.0.0-rc.1\n");
    assertThat(node("26.0.0-rc.1", "24.1.0").resolve(root, Map.of()))
        .containsEntry("version", "26.0.0-rc.1");
  }

  @Test
  void nestedLocalDefaultAliasIsHonoredOnlyWhenActuallySelected() throws Exception {
    Files.createDirectories(root.resolve("home/.nvm/alias"));
    Files.writeString(root.resolve("home/.nvm/alias/default"), "team\n");
    Files.writeString(root.resolve("home/.nvm/alias/team"), "20\n");
    assertThat(node("24.1.0", "20.19.0").resolve(root, Map.of()))
        .containsEntry("version", "20.19.0")
        .containsEntry("source", "local default");
    Files.writeString(root.resolve("home/.nvm/alias/team"), "18\n");
    assertThat(node("24.1.0", "20.19.0").resolve(root, Map.of()))
        .containsEntry("version", "24.1.0")
        .containsEntry("source", "latest installed stable release");
  }

  @Test
  void localLtsDefaultUsesVerifiedReleaseMetadataRatherThanEvenMajorGuess() throws Exception {
    Files.createDirectories(root.resolve("home/.nvm/alias"));
    Files.writeString(root.resolve("home/.nvm/alias/default"), "lts/*\n");
    var commands = mock(CommandRunner.class);
    when(commands.run(anyString(), eq(List.of("-p", "process.release.lts || ''")), isNull(), any()))
        .thenAnswer(
            invocation ->
                new com.argus.common.process.CommandResult(
                    invocation.getArgument(0, String.class).contains("22.12.0") ? "Jod\n" : "\n",
                    "",
                    0));
    var node =
        spy(
            new NodeRuntimeService(
                commands,
                new ObjectMapper(),
                root.resolve("home"),
                Map.of("PATH", "/fixture/base")));
    doReturn(
            List.of(
                object(
                    "version",
                    "24.0.0",
                    "bin",
                    "/fixture/24/bin",
                    "executable",
                    "/fixture/24.0.0/bin/node"),
                object(
                    "version",
                    "22.12.0",
                    "bin",
                    "/fixture/22/bin",
                    "executable",
                    "/fixture/22.12.0/bin/node")))
        .when(node)
        .installed();
    assertThat(node.resolve(root, Map.of()))
        .containsEntry("version", "22.12.0")
        .containsEntry("source", "local default");
    verify(commands, times(2)).run(anyString(), anyList(), isNull(), any());
  }

  @Test
  void mavenCompilerPluginReleaseAndPropertiesChooseCorrectJdkWithoutRunningBuild()
      throws Exception {
    String pom =
        "<project><properties><java.version>17</java.version><target.java>21</target.java></properties><build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><configuration><release>${target.java}</release></configuration></plugin></plugins></build></project>";
    assertThat(JavaProjectService.parseMavenJavaDeclarations(pom))
        .containsEntry("sourceLevel", "21");
    Files.writeString(root.resolve("pom.xml"), pom);
    var java = javaService("25.0.1", "21.0.5", "17.0.12");
    assertThat(map(java.resolveRuntimeEnvironment(repository(), Map.of()).get("environment")))
        .containsEntry("JAVA_HOME", root.resolve("jdk21.0.5").toString());
    Files.writeString(
        root.resolve("pom.xml"),
        "<project><properties><java.version>17</java.version></properties></project>");
    assertThat(map(java.resolveRuntimeEnvironment(repository(), Map.of()).get("environment")))
        .containsEntry("JAVA_HOME", root.resolve("jdk17.0.12").toString());
  }

  @Test
  void unrelatedPluginSourceAndConditionalProfilesDoNotInventJavaLevel() {
    String pom =
        "<project><properties><java.version>17</java.version></properties><build><plugins><plugin><artifactId>other-plugin</artifactId><configuration><source>generated/files</source><release>26</release></configuration></plugin></plugins></build><profiles><profile><id>optional</id><properties><maven.compiler.release>25</maven.compiler.release></properties></profile></profiles></project>";
    assertThat(JavaProjectService.parseMavenJavaDeclarations(pom))
        .containsEntry("sourceLevel", "17");
    assertThat(strings(JavaProjectService.parseMavenJavaDeclarations(pom).get("unresolved")))
        .singleElement()
        .asString()
        .contains("Maven profiles");
    assertThat(
            JavaProjectService.parseMavenJavaDeclarations(
                pom.replaceAll("(?s)<profiles>.*?</profiles>", "")))
        .containsEntry("unresolved", List.of());
    assertThat(
            JavaProjectService.parseMavenJavaDeclarations(
                "<project><build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><configuration><release>${unknown}</release></configuration></plugin></plugins></build></project>"))
        .containsEntry("unresolved", List.of("${unknown}"));
  }

  @Test
  void mavenFourRuntimeMinimumIsSeparateFromJavaEightCompilationTarget() throws Exception {
    Files.writeString(
        root.resolve("pom.xml"),
        "<project><properties><maven.compiler.release>8</maven.compiler.release></properties></project>");
    Files.createDirectories(root.resolve(".mvn/wrapper"));
    Files.writeString(
        root.resolve(".mvn/wrapper/maven-wrapper.properties"),
        "distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/4.0.0-rc-6/apache-maven-4.0.0-rc-6-bin.zip\n");
    var java = javaService("21.0.5", "17.0.12", "1.8.0_442");
    assertThat(map(java.inspect(repository()).get("build"))).containsEntry("version", "4.0.0-rc-6");
    assertThat(map(java.resolveRuntimeEnvironment(repository(), Map.of()).get("environment")))
        .containsEntry("JAVA_HOME", root.resolve("jdk17.0.12").toString());
    assertThat(JavaProjectService.mavenMinimumRuntime("4.0.0-alpha-12")).isEqualTo(8);
    assertThat(JavaProjectService.mavenMinimumRuntime("4.0.0-alpha-13")).isEqualTo(17);
    assertThat(JavaProjectService.mavenMinimumRuntime("3.9.16")).isEqualTo(8);
    assertThat(JavaProjectService.mavenMinimumRuntime("3.10.0-rc-1")).isEqualTo(8);
    for (String version : List.of("", "3.2.5", "3.8.8", "custom-wrapper", "5.0.0"))
      assertThat(JavaProjectService.mavenMinimumRuntime(version)).as(version).isZero();
  }

  @Test
  void interruptedRuntimeDiscoveryStopsBeforeAnyFurtherProbe() throws Exception {
    Path home = Files.createDirectories(root.resolve("home/.nvm/versions/node"));
    for (String version : List.of("v20.19.0", "v22.12.0")) {
      Path executable =
          Files.createDirectories(home.resolve(version).resolve("bin")).resolve("node");
      Files.writeString(executable, "fixture");
      assertThat(executable.toFile().setExecutable(true)).isTrue();
    }
    var commands = mock(CommandRunner.class);
    when(commands.run(anyString(), anyList(), any(), any()))
        .thenAnswer(
            invocation -> {
              Thread.currentThread().interrupt();
              throw new IllegalStateException("interrupted fixture");
            });
    var node = new NodeRuntimeService(commands, new ObjectMapper(), root.resolve("home"), Map.of());
    try {
      assertThatThrownBy(node::installed)
          .isInstanceOf(java.util.concurrent.CancellationException.class);
      verify(commands, times(1)).run(anyString(), anyList(), any(), any());
      var java = new JavaProjectService(commands, Map.of());
      assertThatThrownBy(java::installedJdks)
          .isInstanceOf(java.util.concurrent.CancellationException.class);
      verifyNoMoreInteractions(commands);
    } finally {
      Thread.interrupted();
    }
  }

  private NodeRuntimeService node(String... versions) {
    var service =
        spy(
            new NodeRuntimeService(
                mock(CommandRunner.class),
                new ObjectMapper(),
                root.resolve("home"),
                Map.of("PATH", "/fixture/base")));
    doReturn(
            Arrays.stream(versions)
                .map(
                    version ->
                        object(
                            "version",
                            version,
                            "bin",
                            "/fixture/node" + version + "/bin",
                            "executable",
                            "/fixture/node" + version + "/bin/node"))
                .toList())
        .when(service)
        .installed();
    return service;
  }

  private JavaProjectService javaService(String... versions) {
    var service =
        spy(new JavaProjectService(mock(CommandRunner.class), Map.of("PATH", "/fixture/base")));
    doReturn(
            Arrays.stream(versions)
                .map(
                    version ->
                        object(
                            "version", version, "path", root.resolve("jdk" + version).toString()))
                .toList())
        .when(service)
        .installedJdks();
    return service;
  }

  private Repository repository() {
    return new Repository("fixture", "fixture", root.toString(), "now", "main");
  }
}
