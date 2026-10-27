package com.argus.ide;

import static com.argus.runtime.service.RuntimeData.map;
import static com.argus.runtime.service.RuntimeData.text;

import com.argus.runtime.service.JavaProjectService;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/** Separates JDT's own JVM from the project JVM used by its trusted Gradle importer. */
@Component
public final class IdeJavaProjectSettings {
  private final WorkspaceService workspace;
  private final JavaProjectService projects;

  public IdeJavaProjectSettings(WorkspaceService workspace, JavaProjectService projects) {
    this.workspace = workspace;
    this.projects = projects;
  }

  public static Map<String, Object> defaults(boolean trusted) {
    return Map.of(
        "autobuild", Map.of("enabled", false),
        "import", Map.of("gradle", Map.of("enabled", trusted), "maven", Map.of("enabled", trusted)),
        "configuration", Map.of("updateBuildConfiguration", trusted ? "automatic" : "disabled"));
  }

  public Map<String, Object> settings(String repositoryId, boolean trusted) {
    if (!trusted) return defaults(false);
    var repository = workspace.requireRepository(repositoryId);
    Path root = Path.of(repository.path());
    if (List.of(
            "gradlew", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts")
        .stream()
        .noneMatch(file -> Files.exists(root.resolve(file)))) return defaults(true);

    // This is the same metadata-only SDK resolver used by Services; it never invokes Gradle.
    // Do not silently fall back to JDT's newer JVM when the project's SDK is incompatible.
    var runtime =
        projects.resolveRuntimeEnvironment(repository, workspace.javaSettings(repositoryId));
    String javaHome = text(map(runtime.get("environment")), "JAVA_HOME");
    if (javaHome.isBlank())
      throw new IllegalArgumentException(
          "Choose a compatible project SDK in Services before enabling Gradle Java indexing.");
    var java = new LinkedHashMap<>(defaults(true));
    java.put(
        "import",
        Map.of(
            "gradle", Map.of("enabled", true, "java", Map.of("home", javaHome)),
            "maven", Map.of("enabled", true)));
    return java;
  }
}
