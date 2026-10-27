package com.argus.ide;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.common.process.CommandResult;
import com.argus.runtime.service.JavaProjectService;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class IdeJavaProjectSettingsTest {
  @TempDir Path root;

  @Test
  void untrustedSettingsDoNotInspectOrResolveAnything() {
    var workspace = mock(WorkspaceService.class);
    var projects = mock(JavaProjectService.class);
    var settings = new IdeJavaProjectSettings(workspace, projects).settings("untrusted", false);
    assertThat(map(map(settings.get("import")).get("gradle"))).containsEntry("enabled", false);
    assertThat(map(map(settings.get("import")).get("maven"))).containsEntry("enabled", false);
    assertThat(map(settings.get("configuration")))
        .containsEntry("updateBuildConfiguration", "disabled");
    verifyNoInteractions(workspace, projects);
  }

  @Test
  void trustedGradleImporterUsesSameSelectedSdkAsServicesWithoutChangingServerJvm()
      throws Exception {
    Files.writeString(
        root.resolve("build.gradle"), "plugins { id 'java' }\nsourceCompatibility = 17\n");
    var repository = new Repository("r", "Fixture", root.toString(), "now");
    var saved = Map.<String, Object>of("javaHome", "/fixture/jdk-17", "languageLevel", "project");
    var workspace = mock(WorkspaceService.class);
    when(workspace.requireRepository("r")).thenReturn(repository);
    when(workspace.javaSettings("r")).thenReturn(saved);
    var projects = mock(JavaProjectService.class);
    when(projects.resolveRuntimeEnvironment(repository, saved))
        .thenReturn(
            object(
                "environment",
                Map.of("JAVA_HOME", "/fixture/jdk-17", "PATH", "/fixture/jdk-17/bin"),
                "label",
                "Java 17"));
    var settings = new IdeJavaProjectSettings(workspace, projects).settings("r", true);
    var gradle = map(map(settings.get("import")).get("gradle"));
    assertThat(map(gradle.get("java"))).containsEntry("home", "/fixture/jdk-17");
    assertThat(gradle).containsEntry("enabled", true);
    assertThat(map(settings.get("autobuild"))).containsEntry("enabled", false);
    assertThat(settings).doesNotContainKeys("home", "jdt");
    verify(projects).resolveRuntimeEnvironment(repository, saved);
  }

  @Test
  void sdkCompatibilityErrorsAreNotHiddenByFallingBackToLanguageServerJava() throws Exception {
    Files.writeString(root.resolve("settings.gradle"), "rootProject.name='fixture'");
    var workspace = mock(WorkspaceService.class);
    var repository = new Repository("r", "Fixture", root.toString(), "now");
    when(workspace.requireRepository("r")).thenReturn(repository);
    when(workspace.javaSettings("r")).thenReturn(Map.of());
    var projects = mock(JavaProjectService.class);
    when(projects.resolveRuntimeEnvironment(repository, Map.of()))
        .thenThrow(new IllegalArgumentException("Selected JDK 25 cannot run Gradle 8.8"));
    assertThatThrownBy(() -> new IdeJavaProjectSettings(workspace, projects).settings("r", true))
        .hasMessageContaining("JDK 25")
        .hasMessageContaining("Gradle 8.8");
  }

  @Test
  void mavenAndPlainJavaDoNotAcquireAnUnrelatedGradleRuntime() throws Exception {
    Files.writeString(root.resolve("pom.xml"), "<project/>");
    var workspace = mock(WorkspaceService.class);
    when(workspace.requireRepository("r"))
        .thenReturn(new Repository("r", "Fixture", root.toString(), "now"));
    var projects = mock(JavaProjectService.class);
    assertThat(new IdeJavaProjectSettings(workspace, projects).settings("r", true))
        .isEqualTo(IdeJavaProjectSettings.defaults(true));
    verifyNoInteractions(projects);
  }

  @Test
  void realMetadataResolverChoosesJava17ForGradle88WithoutExecutingAnyBuild() throws Exception {
    Files.writeString(
        root.resolve("build.gradle"), "plugins { id 'java' }; sourceCompatibility = 17\n");
    Path wrapper = Files.createDirectories(root.resolve("gradle/wrapper"));
    Files.writeString(
        wrapper.resolve("gradle-wrapper.properties"),
        "distributionUrl=https://services.gradle.org/distributions/gradle-8.8-bin.zip\n");
    Path jdk = Files.createDirectories(root.resolve("fixture-jdk-17"));
    Files.createDirectories(jdk.resolve("bin"));
    Files.writeString(jdk.resolve("bin/java"), "not executable fixture; only metadata may be read");
    Files.writeString(jdk.resolve("release"), "JAVA_VERSION=\"17.0.18\"\n");
    var called = new ArrayList<String>();
    var projects =
        new JavaProjectService(
            (command, args, cwd, timeout) -> {
              called.add(command);
              assertThat(command).isEqualTo("/usr/libexec/java_home");
              return new CommandResult("", "", 0);
            },
            Map.of("JAVA_HOME", jdk.toString()));
    var workspace = mock(WorkspaceService.class);
    when(workspace.requireRepository("r"))
        .thenReturn(new Repository("r", "Fixture", root.toString(), "now"));
    when(workspace.javaSettings("r")).thenReturn(Map.of());
    var settings = new IdeJavaProjectSettings(workspace, projects).settings("r", true);
    assertThat(map(map(map(settings.get("import")).get("gradle")).get("java")))
        .containsEntry("home", jdk.toString());
    assertThat(called)
        .allSatisfy(command -> assertThat(command).isEqualTo("/usr/libexec/java_home"));
  }
}
