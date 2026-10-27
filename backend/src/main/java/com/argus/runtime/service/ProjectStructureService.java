package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.common.process.CommandRunner;
import com.argus.workspace.domain.Repository;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

@Service
public class ProjectStructureService {
  private final JavaProjectService javaProjects;
  private final NodeRuntimeService node;
  private final CommandRunner commands;

  public ProjectStructureService(
      JavaProjectService javaProjects, NodeRuntimeService node, CommandRunner commands) {
    this.javaProjects = javaProjects;
    this.node = node;
    this.commands = commands;
  }

  private String first(Path root, List<String> names) {
    return names.stream().filter(name -> Files.exists(root.resolve(name))).findFirst().orElse("");
  }

  private List<String> present(Path root, List<String> names) {
    return names.stream().filter(name -> Files.exists(root.resolve(name))).toList();
  }

  private String version(String executable, List<String> args) {
    try {
      var result = commands.run(executable, args, null, Duration.ofSeconds(5));
      return (result.stdout().isBlank() ? result.stderr() : result.stdout())
          .lines()
          .findFirst()
          .orElse("Not available")
          .trim();
    } catch (RuntimeException ignored) {
      return "Not available";
    }
  }

  private Map<String, Object> repository(Repository repository) {
    return object("id", repository.id(), "name", repository.name(), "path", repository.path());
  }

  public static String shellQuote(String value) {
    return "'" + value.replace("'", "'\"'\"'") + "'";
  }

  private List<Map<String, Object>> roots(Path root, String relative, String[][] definitions) {
    var result = new ArrayList<Map<String, Object>>();
    for (var definition : definitions) {
      String path = relative.equals(".") ? definition[1] : relative + "/" + definition[1];
      if (Files.exists(inside(root, path))) result.add(object("type", definition[0], "path", path));
    }
    return result;
  }

  public Map<String, Object> inspect(Repository repository, Map<String, Object> settings) {
    Path root = Path.of(repository.path());
    Map<String, Object> result;
    String analyzer;
    if (!first(
            root,
            List.of(
                "gradlew",
                "mvnw",
                "pom.xml",
                "build.gradle",
                "build.gradle.kts",
                "settings.gradle",
                "settings.gradle.kts"))
        .isEmpty()) {
      analyzer = "java";
      result = javaProjects.inspect(repository, settings);
      result.put("projectType", "java");
    } else if (Files.exists(root.resolve("package.json"))) {
      analyzer = "node";
      result = node(repository);
    } else if (!first(
            root,
            List.of(
                "pyproject.toml",
                "requirements.txt",
                "Pipfile",
                "setup.py",
                "main.py",
                "app.py",
                "manage.py",
                "src/main.py"))
        .isEmpty()) {
      analyzer = "python";
      result = python(repository);
    } else {
      analyzer = "generic";
      result = generic(repository);
    }
    result.put("analyzer", analyzer);
    return result;
  }

  public static String uiFramework(Map<String, Object> definition) {
    var packages = new LinkedHashSet<>(map(definition.get("dependencies")).keySet());
    packages.addAll(map(definition.get("devDependencies")).keySet());
    String scripts = map(definition.get("scripts")).values().toString();
    if (packages.contains("next")) return "Next.js";
    if (packages.contains("nuxt")) return "Nuxt";
    if (packages.contains("@angular/core")) return "Angular";
    if (packages.contains("svelte") || packages.contains("@sveltejs/kit")) return "Svelte";
    if (packages.contains("vue")) return packages.contains("vite") ? "Vue + Vite" : "Vue";
    if (packages.contains("react") || packages.contains("react-dom")) {
      if (packages.contains("vite") || Pattern.compile("\\bvite\\b").matcher(scripts).find())
        return "React + Vite";
      if (packages.contains("react-scripts")) return "React Scripts";
      if (packages.contains("webpack") || Pattern.compile("\\bwebpack\\b").matcher(scripts).find())
        return "React + Webpack";
      return "React";
    }
    return packages.contains("vite") || Pattern.compile("\\bvite\\b").matcher(scripts).find()
        ? "Vite"
        : "Node.js";
  }

  private Map<String, Object> node(Repository repository) {
    Path root = Path.of(repository.path());
    var definition = node.packageJson(root);
    var files =
        present(
            root,
            List.of("package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"));
    String manager = RuntimeDetector.packageManager(root, definition),
        configured = read(root.resolve(".nvmrc")).trim();
    if (configured.isEmpty()) configured = read(root.resolve(".node-version")).trim();
    if (configured.isEmpty()) configured = text(map(definition.get("engines")), "node");
    var paths = new LinkedHashSet<String>();
    paths.add(".");
    Object workspaces = definition.get("workspaces");
    var patterns =
        workspaces instanceof List<?>
            ? strings(workspaces)
            : strings(map(workspaces).get("packages"));
    for (String raw : patterns) {
      String pattern = raw.replace('\\', '/').replaceFirst("^\\./", "");
      if (pattern.isEmpty() || pattern.startsWith("../") || pattern.contains("**")) continue;
      try {
        if (pattern.endsWith("/*")) {
          String parent = pattern.substring(0, pattern.length() - 2);
          Path directory = inside(root, parent);
          if (Files.isDirectory(directory))
            try (var entries = Files.list(directory)) {
              entries
                  .filter(
                      path ->
                          Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)
                              && Files.isRegularFile(path.resolve("package.json")))
                  .sorted()
                  .forEach(path -> paths.add(root.relativize(path).toString()));
            }
        } else if (!pattern.contains("*")
            && Files.isRegularFile(inside(root, pattern + "/package.json"))) paths.add(pattern);
      } catch (java.io.IOException | IllegalArgumentException ignored) {
      }
    }
    var modules = new ArrayList<Map<String, Object>>();
    for (String relative : paths) {
      var child = relative.equals(".") ? definition : node.packageJson(inside(root, relative));
      modules.add(
          object(
              "name",
              text(child, "name").isEmpty()
                  ? relative.equals(".")
                      ? repository.name()
                      : Path.of(relative).getFileName().toString()
                  : child.get("name"),
              "path",
              relative,
              "roots",
              roots(
                  root,
                  relative,
                  new String[][] {
                    {"Sources", "src"},
                    {"Public assets", "public"},
                    {"Tests", "test"},
                    {"Tests", "tests"},
                    {"Tests", "__tests__"},
                    {"Build config", "webpack"},
                    {"Config", "config"}
                  }),
              "private",
              Boolean.TRUE.equals(child.get("private"))));
    }
    var selected = node.resolve(root, definition);
    String managerVersion = version(manager, List.of("--version"));
    var buildFiles = new ArrayList<>(List.of("package.json"));
    buildFiles.addAll(files);
    return object(
        "projectType",
        "node",
        "repository",
        repository(repository),
        "isNodeProject",
        true,
        "isJavaProject",
        false,
        "framework",
        uiFramework(definition),
        "build",
        object("tool", manager, "version", managerVersion, "files", buildFiles),
        "runtime",
        object(
            "nodeVersion",
            selected.get("version"),
            "requiredNode",
            text(map(definition.get("engines")), "node"),
            "configuredNode",
            configured,
            "runtimeSource",
            selected.get("source"),
            "packageManager",
            manager,
            "packageManagerVersion",
            managerVersion,
            "declaredPackageManager",
            text(definition, "packageManager"),
            "dependenciesInstalled",
            Files.exists(root.resolve("node_modules")),
            "dependencyDirectory",
            "node_modules"),
        "modules",
        modules,
        "scripts",
        map(definition.get("scripts")).entrySet().stream()
            .map(item -> object("name", item.getKey(), "command", text(item.getValue())))
            .toList(),
        "dependencies",
        object(
            "production",
            map(definition.get("dependencies")).size(),
            "development",
            map(definition.get("devDependencies")).size()),
        "settings",
        Map.of());
  }

  private Map<String, Object> python(Repository repository) {
    Path root = Path.of(repository.path());
    var files =
        present(
            root,
            List.of(
                "pyproject.toml",
                "requirements.txt",
                "Pipfile",
                "poetry.lock",
                "uv.lock",
                "setup.py",
                "Dockerfile",
                ".python-version"));
    String requirements = read(root.resolve("requirements.txt")),
        pyproject = read(root.resolve("pyproject.toml"));
    var dependencies =
        requirements
            .lines()
            .map(String::trim)
            .filter(line -> !line.isEmpty() && !line.startsWith("#") && !line.startsWith("-"))
            .map(line -> line.split("[\\s<>=!~;\\[]", 2)[0].toLowerCase())
            .filter(value -> !value.isEmpty())
            .toList();
    String entry = PythonProjectRuntime.entry(root),
        source = (entry.isEmpty() ? "" : read(root.resolve(entry))) + "\n" + pyproject,
        manager = PythonProjectRuntime.manager(root),
        configured = read(root.resolve(".python-version")).trim();
    if (configured.isEmpty()) {
      var match = Pattern.compile("requires-python\\s*=\\s*[\"']([^\"']+)").matcher(pyproject);
      if (match.find()) configured = match.group(1);
    }
    String virtual = PythonProjectRuntime.virtualEnvironment(root);
    var roots =
        roots(
            root,
            ".",
            new String[][] {
              {"Sources", "src"}, {"Tests", "tests"}, {"Tools", "tools"}, {"Config", "config"}
            });
    try (var entries = Files.list(root)) {
      var pythonFiles =
          entries
              .filter(
                  path ->
                      Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)
                          && path.toString().endsWith(".py"))
              .map(path -> path.getFileName().toString())
              .toList();
      if (!pythonFiles.isEmpty())
        roots.add(0, object("type", "Python files", "path", String.join(", ", pythonFiles)));
    } catch (java.io.IOException ignored) {
    }
    String install =
        manager.equals("pip") && virtual.isEmpty()
            ? "Create a local .venv and install project dependencies"
            : PythonProjectRuntime.shellCommand(PythonProjectRuntime.sync(root));
    var scripts = new ArrayList<Map<String, Object>>();
    if (!entry.isEmpty())
      scripts.add(
          object(
              "name",
              "run",
              "command",
              PythonProjectRuntime.shellCommand(PythonProjectRuntime.run(root, 8000))));
    if (dependencies.contains("pytest") || Files.exists(root.resolve("tests")))
      scripts.add(
          object(
              "name",
              "test",
              "command",
              PythonProjectRuntime.shellCommand(
                  PythonProjectRuntime.python(root, List.of("-m", "pytest")))));
    if (files.contains("Dockerfile"))
      scripts.add(
          object(
              "name",
              "docker build",
              "command",
              "docker build -t " + shellQuote(repository.name()) + " ."));
    String pythonVersion = version(PythonProjectRuntime.interpreter(root), List.of("--version")),
        managerVersion =
            manager.equals("pip")
                ? version(PythonProjectRuntime.interpreter(root), List.of("-m", "pip", "--version"))
                : version(manager, List.of("--version"));
    if (manager.equals("pip")) {
      var match = Pattern.compile("^pip\\s+([^\\s]+)").matcher(managerVersion);
      if (match.find()) managerVersion = match.group(1);
    }
    String framework =
        dependencies.contains("fastmcp")
                || Pattern.compile("\\bFastMCP\\b|\\.run\\(\\s*transport\\s*=")
                    .matcher(source)
                    .find()
            ? "FastMCP"
            : dependencies.contains("fastapi")
                    || Pattern.compile("\\bFastAPI\\s*\\(").matcher(source).find()
                ? "FastAPI"
                : dependencies.contains("django")
                    ? "Django"
                    : dependencies.contains("flask")
                            || Pattern.compile("\\bFlask\\s*\\(").matcher(source).find()
                        ? "Flask"
                        : "Python";
    return object(
        "projectType",
        "python",
        "repository",
        repository(repository),
        "isPythonProject",
        true,
        "isJavaProject",
        false,
        "framework",
        framework,
        "build",
        object("tool", manager, "version", managerVersion, "files", files),
        "runtime",
        object(
            "pythonVersion",
            pythonVersion,
            "configuredPython",
            configured,
            "packageManager",
            manager,
            "packageManagerVersion",
            managerVersion,
            "virtualEnvironment",
            virtual,
            "dependenciesInstalled",
            !virtual.isEmpty(),
            "dependencyDirectory",
            virtual.isEmpty() ? ".venv" : virtual,
            "entryPoint",
            entry,
            "installCommand",
            install),
        "modules",
        List.of(object("name", repository.name(), "path", ".", "roots", roots)),
        "scripts",
        scripts,
        "dependencies",
        object("production", dependencies.size(), "development", 0),
        "settings",
        Map.of());
  }

  private void languages(Path directory, int depth, Map<String, Integer> counts) {
    if (depth > 4) return;
    var languages =
        Map.ofEntries(
            Map.entry("go", "Go"),
            Map.entry("rs", "Rust"),
            Map.entry("rb", "Ruby"),
            Map.entry("php", "PHP"),
            Map.entry("swift", "Swift"),
            Map.entry("kt", "Kotlin"),
            Map.entry("cs", "C#"),
            Map.entry("c", "C"),
            Map.entry("cpp", "C++"),
            Map.entry("ts", "TypeScript"),
            Map.entry("js", "JavaScript"),
            Map.entry("py", "Python"),
            Map.entry("java", "Java"));
    try (var entries = Files.list(directory)) {
      for (Path file : entries.toList()) {
        String name = file.getFileName().toString();
        if (name.startsWith(".")
            || Set.of("node_modules", "build", "dist", "target", "vendor", "venv").contains(name)
            || Files.isSymbolicLink(file)) continue;
        if (Files.isDirectory(file, LinkOption.NOFOLLOW_LINKS)) languages(file, depth + 1, counts);
        else {
          String extension = name.substring(name.lastIndexOf('.') + 1).toLowerCase();
          if (languages.containsKey(extension))
            counts.merge(languages.get(extension), 1, Integer::sum);
        }
      }
    } catch (java.io.IOException ignored) {
    }
  }

  private Map<String, Object> generic(Repository repository) {
    Path root = Path.of(repository.path());
    var files =
        present(
            root,
            List.of(
                "Makefile",
                "CMakeLists.txt",
                "go.mod",
                "Cargo.toml",
                "Gemfile",
                "composer.json",
                "Dockerfile"));
    var roots =
        roots(
            root,
            ".",
            new String[][] {
              {"Sources", "src"},
              {"Applications", "cmd"},
              {"Libraries", "lib"},
              {"Tests", "test"},
              {"Tests", "tests"},
              {"Config", "config"},
              {"Documentation", "docs"}
            });
    var counts = new LinkedHashMap<String, Integer>();
    languages(root, 0, counts);
    var languages =
        counts.entrySet().stream()
            .sorted(Map.Entry.<String, Integer>comparingByValue().reversed())
            .map(item -> object("name", item.getKey(), "count", item.getValue()))
            .toList();
    return object(
        "projectType",
        "generic",
        "repository",
        repository(repository),
        "isJavaProject",
        false,
        "framework",
        languages.isEmpty() ? "General repository" : text(languages.get(0), "name") + " repository",
        "build",
        object(
            "tool",
            files.isEmpty() ? "No build tool detected" : files.get(0),
            "version",
            "",
            "files",
            files),
        "runtime",
        object("languages", languages),
        "modules",
        List.of(object("name", repository.name(), "path", ".", "roots", roots)),
        "scripts",
        List.of(),
        "dependencies",
        object("production", 0, "development", 0),
        "settings",
        Map.of());
  }

  public String command(Repository repository, String action, String script) {
    var project = inspect(repository, Map.of());
    String type = text(project, "projectType");
    var runtime = map(project.get("runtime"));
    if (type.equals("java"))
      throw new IllegalArgumentException(
          "Java build commands are managed through Services run configurations");
    if (type.equals("generic"))
      throw new IllegalArgumentException("No runnable command was detected for this repository");
    if (action.equals("install"))
      return type.equals("node")
          ? text(runtime, "packageManager") + " install"
          : PythonProjectRuntime.shellCommand(
              PythonProjectRuntime.sync(Path.of(repository.path())));
    var selected =
        list(project.get("scripts")).stream()
            .map(RuntimeData::map)
            .filter(item -> script.equals(item.get("name")))
            .findFirst()
            .orElse(null);
    if (!action.equals("script") || selected == null)
      throw new IllegalArgumentException(
          type.equals("node")
              ? "Choose a script detected in package.json"
              : "Choose a command detected for this Python project");
    return type.equals("node")
        ? text(runtime, "packageManager") + " run " + shellQuote(script)
        : text(selected, "command");
  }

  public Map<String, Object> maintenance(Repository repository, String action) {
    if (!Set.of("sync", "test").contains(action))
      throw new IllegalArgumentException("Choose dependency sync or tests");
    boolean sync = action.equals("sync");
    var project = inspect(repository, Map.of());
    String type = text(project, "projectType"),
        manager = text(map(project.get("runtime")), "packageManager"),
        tool = text(map(project.get("build")), "tool");
    if (type.equals("node")) {
      if (!sync
          && list(project.get("scripts")).stream()
              .noneMatch(item -> "test".equals(map(item).get("name"))))
        throw new IllegalArgumentException("No test script is defined in package.json");
      return object(
          "executable",
          manager,
          "args",
          sync ? List.of("install") : List.of("run", "test"),
          "label",
          sync ? "Refreshing node_modules" : "Running Node tests");
    }
    if (type.equals("python")) {
      if (!sync
          && list(project.get("scripts")).stream()
              .noneMatch(item -> "test".equals(map(item).get("name"))))
        throw new IllegalArgumentException("No Python tests or pytest configuration were detected");
      Path root = Path.of(repository.path());
      var command =
          sync
              ? PythonProjectRuntime.sync(root)
              : PythonProjectRuntime.python(root, List.of("-m", "pytest"));
      command.put("label", sync ? "Refreshing Python dependencies" : "Running Python tests");
      return command;
    }
    if (type.equals("java")) {
      if (tool.equals("Gradle"))
        return object(
            "executable",
            Files.exists(Path.of(repository.path(), "gradlew")) ? "./gradlew" : "gradle",
            "args",
            sync ? List.of("--refresh-dependencies", ":argusResolveDependencies") : List.of("test"),
            "label",
            sync ? "Syncing Gradle dependencies" : "Running Gradle tests");
      if (tool.equals("Maven"))
        return object(
            "executable",
            Files.exists(Path.of(repository.path(), "mvnw")) ? "./mvnw" : "mvn",
            "args",
            sync ? List.of("-U", "dependency:go-offline") : List.of("test"),
            "label",
            sync ? "Syncing Maven dependencies" : "Running Maven tests");
    }
    throw new IllegalArgumentException(
        "Dependency sync and tests are not available for this "
            + text(project, "framework")
            + " project");
  }

  /** Product-owned init script, installed outside the repository only for an explicit sync. */
  public String gradleSyncScript() {
    return """
        gradle.projectsEvaluated {
          def root = gradle.rootProject
          if (root.tasks.findByName('argusResolveDependencies') != null) {
            throw new GradleException('Task name argusResolveDependencies is reserved for this Argus sync')
          }
          root.tasks.register('argusResolveDependencies') {
            group = 'argus'
            description = 'Resolve downloadable dependencies for all project modules'
            doLast {
              root.allprojects.each { project ->
                project.configurations.findAll { it.canBeResolved }.each { configuration ->
                  logger.lifecycle('Argus sync: ' + project.path + ' / ' + configuration.name)
                  def artifacts = configuration.incoming.artifactView { view ->
                    view.componentFilter { id -> id instanceof org.gradle.api.artifacts.component.ModuleComponentIdentifier }
                  }.files.files
                  logger.lifecycle('Argus sync resolved ' + artifacts.size() + ' external artifact(s): ' + project.path + ' / ' + configuration.name)
                }
              }
            }
          }
        }
        """;
  }
}
