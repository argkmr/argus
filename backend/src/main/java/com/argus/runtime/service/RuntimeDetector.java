package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;

import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

/** Native metadata-only runtime and runnable Spring module detection. */
@Service
public class RuntimeDetector {
  private final NodeRuntimeService node;
  private static final Set<String> IGNORED =
      Set.of(".git", "node_modules", "build", "bin", "target", ".gradle", "out");

  public RuntimeDetector(NodeRuntimeService node) {
    this.node = node;
  }

  public Map<String, Object> nodeRuntime(Path root) {
    return node.resolve(root);
  }

  public static Integer validPort(Object value) {
    String raw = text(value).trim().replaceAll("^['\"]|['\"]$", "");
    var match = Pattern.compile("^\\$\\{[^:}]+:(\\d+)}$").matcher(raw);
    if (match.matches()) raw = match.group(1);
    try {
      int port = Integer.parseInt(raw);
      return port > 0 && port <= 65535 ? port : null;
    } catch (NumberFormatException ignored) {
      return null;
    }
  }

  public static String yamlValue(String source, String requested) {
    var keys = new ArrayList<String>();
    var indents = new ArrayList<Integer>();
    for (String line : source.split("\\r?\\n")) {
      if (line.trim().isEmpty()
          || line.stripLeading().startsWith("#")
          || line.stripLeading().startsWith("-")) continue;
      var match = Pattern.compile("^(\\s*)([A-Za-z0-9_.-]+)\\s*:\\s*([^#]*)").matcher(line);
      if (!match.find()) continue;
      int indent = match.group(1).length();
      while (!indents.isEmpty() && indents.get(indents.size() - 1) >= indent) {
        keys.remove(keys.size() - 1);
        indents.remove(indents.size() - 1);
      }
      String key = match.group(2),
          value = match.group(3).trim(),
          path =
              key.contains(".") ? key : String.join(".", keys) + (keys.isEmpty() ? "" : ".") + key;
      if (path.equals(requested)) return value;
      if (value.isEmpty()) {
        keys.add(key);
        indents.add(indent);
      }
    }
    return "";
  }

  public static Map<String, Object> applyEnvironmentPorts(
      Map<String, Object> runtime, Map<String, ?> environment) {
    var result = copyMap(runtime);
    boolean node = text(runtime, "executable").matches("(?:.*/)?(?:node|npm|npx|pnpm|yarn|bun)");
    Integer
        port =
            validPort(
                !node && environment.containsKey("SERVER_PORT")
                    ? environment.get("SERVER_PORT")
                    : environment.get("PORT")),
        management =
            validPort(
                environment.containsKey("MANAGEMENT_SERVER_PORT")
                    ? environment.get("MANAGEMENT_SERVER_PORT")
                    : environment.get("MANAGEMENT_PORT"));
    // Framework CLI flags outrank PORT. npm options before its '--' are not
    // application arguments and must never be interpreted as a server port.
    if (node) {
      var args = strings(runtime.get("args"));
      int start = text(runtime, "executable").matches("(?:.*/)?npm") ? args.indexOf("--") + 1 : 0;
      if (!text(runtime, "executable").matches("(?:.*/)?npm") || start > 0) {
        for (int index = start; index < args.size(); index++) {
          String argument = args.get(index);
          Integer explicit = null;
          if ((argument.equals("--port") || argument.equals("-p")) && index + 1 < args.size())
            explicit = validPort(args.get(++index));
          else if (argument.startsWith("--port=") || argument.startsWith("-p="))
            explicit = validPort(argument.substring(argument.indexOf('=') + 1));
          else if (argument.matches("-p[0-9]+")) explicit = validPort(argument.substring(2));
          if (explicit != null) port = explicit;
        }
      }
    }
    if (port != null) result.put("port", port);
    if (management != null) result.put("managementPort", management);
    result.put(
        "portSource",
        port != null
            ? node ? "Node launch arguments / PORT environment" : "local environment"
            : runtime.getOrDefault("portSource", "detected runtime"));
    return result;
  }

  public static String packageManager(Path root, Map<String, Object> definition) {
    String declared = text(definition, "packageManager").split("@", 2)[0];
    if (Set.of("npm", "pnpm", "yarn", "bun").contains(declared)) return declared;
    for (String[] pair :
        new String[][] {
          {"pnpm-lock.yaml", "pnpm"},
          {"yarn.lock", "yarn"},
          {"bun.lock", "bun"},
          {"bun.lockb", "bun"}
        }) if (Files.exists(root.resolve(pair[0]))) return pair[1];
    return "npm";
  }

  private List<Path> files(Path root, int depth) {
    if (!Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS) || depth < 0) return List.of();
    var result = new ArrayList<Path>();
    try (var entries = Files.list(root)) {
      for (Path child : entries.sorted().toList()) {
        if (Files.isSymbolicLink(child) || IGNORED.contains(child.getFileName().toString()))
          continue;
        if (Files.isDirectory(child, LinkOption.NOFOLLOW_LINKS))
          result.addAll(files(child, depth - 1));
        else if (Files.isRegularFile(child, LinkOption.NOFOLLOW_LINKS)) result.add(child);
      }
    } catch (java.io.IOException error) {
      throw new IllegalStateException("Could not inspect repository runtime metadata", error);
    }
    return result;
  }

  public Map<String, Object> applicationYaml(Path root) {
    return applicationYaml(root, JvmEntryPoints.inspect(root));
  }

  private Map<String, Object> applicationYaml(Path root, List<Map<String, Object>> entries) {
    var springModules =
        entries.stream()
            .filter(entry -> Boolean.TRUE.equals(entry.get("springBoot")))
            .map(entry -> text(entry, "modulePath"))
            .collect(java.util.stream.Collectors.toSet());
    var candidates = new ArrayList<Map<String, Object>>();
    for (Path file : files(root, 8)) {
      String relative = root.relativize(file).toString().replace('\\', '/');
      var match =
          Pattern.compile(
                  "^(?:(.*)/)?src/main/resources/(?:.*/)?application(?:-[^.]+)?\\.ya?ml$",
                  Pattern.CASE_INSENSITIVE)
              .matcher(relative);
      if (!match.matches()) continue;
      String module = match.group(1) == null ? "" : match.group(1);
      long size;
      try {
        size = Files.size(file);
      } catch (java.io.IOException ignored) {
        size = 0;
      }
      int score =
          (springModules.contains(module) ? 1000 : 0)
              + (size > 0 ? 200 : 0)
              + (file.getFileName().toString().matches("(?i)application\\.ya?ml") ? 100 : 0)
              - relative.split("/").length;
      candidates.add(object("file", relative, "modulePath", module, "size", size, "score", score));
    }
    candidates.sort(
        Comparator.comparingLong((Map<String, Object> item) -> number(item.get("score")))
            .reversed()
            .thenComparing(item -> text(item, "file")));
    return candidates.isEmpty() ? object("file", "", "modulePath", "") : candidates.get(0);
  }

  private Map<String, Object> springRuntime(
      Path root, String name, boolean gradle, boolean mavenWrapper) {
    if (gradle && JvmEntryPoints.customGradleLayout(root))
      throw new IllegalArgumentException(
          "This Gradle build maps custom project directories or included builds. Use an explicit saved Services command; Argus will not guess task paths from folders.");
    var entries = JvmEntryPoints.inspect(root);
    var entry = JvmEntryPoints.select(root, entries);
    var config = applicationYaml(root, entries);
    if (!entry.isEmpty()) {
      String modulePath = text(entry, "modulePath");
      String prefix = modulePath.isEmpty() ? "" : modulePath + "/";
      if (!modulePath.equals(text(config, "modulePath"))) {
        String found = "";
        for (String filename : List.of("application.yml", "application.yaml"))
          if (Files.isRegularFile(root.resolve(prefix + "src/main/resources/" + filename))) {
            found = prefix + "src/main/resources/" + filename;
            break;
          }
        config = object("file", found, "modulePath", modulePath);
      }
    }
    String file = text(config, "file"),
        module = text(config, "modulePath").replace('/', ':'),
        source = file.isEmpty() ? "" : read(root.resolve(file)),
        rawPort = yamlValue(source, "server.port");
    Integer port = validPort(rawPort);
    boolean springBoot = entry.isEmpty() || Boolean.TRUE.equals(entry.get("springBoot"));
    if (!springBoot) {
      String modulePath = text(entry, "modulePath");
      String build =
          JvmEntryPoints.commentsRemoved(
              read(root.resolve("build.gradle"))
                  + "\n"
                  + read(root.resolve("build.gradle.kts"))
                  + "\n"
                  + read(root.resolve(modulePath).resolve("build.gradle"))
                  + "\n"
                  + read(root.resolve(modulePath).resolve("build.gradle.kts")));
      if (!gradle || !Pattern.compile("\\bapplication\\b").matcher(build).find())
        throw new IllegalArgumentException(
            "Found Java main class "
                + text(entry, "mainClass")
                + ", but no supported application launch task is declared. Configure a direct java command in Services.");
    }
    var result =
        object(
            "name",
            name,
            "runtimeType",
            "service",
            "executable",
            gradle ? "./gradlew" : mavenWrapper ? "./mvnw" : "mvn",
            "args",
            gradle
                ? List.of(
                    module.isEmpty()
                        ? springBoot ? ":bootRun" : ":run"
                        : ":" + module + (springBoot ? ":bootRun" : ":run"))
                : List.of("spring-boot:run"),
            "cwd",
            ".",
            "configFile",
            file,
            "port",
            port == null ? 8080 : port,
            "managementPort",
            validPort(yamlValue(source, "management.server.port")),
            "portSource",
            rawPort.isEmpty() ? "Spring Boot default" : Path.of(file).getFileName().toString());
    if (!entry.isEmpty()) {
      result.put("mainClass", entry.get("mainClass"));
      result.put("modulePath", entry.get("modulePath"));
      result.put("entryPointFile", entry.get("file"));
      result.put("entryPoints", entries);
    }
    return result;
  }

  public Map<String, Object> detect(Path root, String name) {
    if (Files.exists(root.resolve("gradlew"))) return springRuntime(root, name, true, false);
    boolean maven = Files.exists(root.resolve("mvnw"));
    if (maven || Files.exists(root.resolve("pom.xml")))
      return springRuntime(root, name, false, maven);
    if (Files.exists(root.resolve("package.json"))) {
      var definition = node.packageJson(root);
      var selected = node.resolve(root, definition);
      var scripts = map(definition.get("scripts"));
      String script =
          List.of("dev", "start", "serve").stream()
              .filter(key -> !text(scripts, key).isEmpty())
              .findFirst()
              .orElseThrow(
                  () ->
                      new IllegalArgumentException(
                          "Argus could not find a dev, start, or serve script in package.json"));
      String manager = packageManager(root, definition);
      var packages = new LinkedHashSet<>(map(definition.get("dependencies")).keySet());
      packages.addAll(map(definition.get("devDependencies")).keySet());
      boolean ui =
          List.of(
                      "react",
                      "react-dom",
                      "react-scripts",
                      "next",
                      "vue",
                      "nuxt",
                      "vite",
                      "svelte",
                      "@angular/core")
                  .stream()
                  .anyMatch(packages::contains)
              || Pattern.compile("vite|next|nuxt|react-scripts|ng serve|vue-cli-service|svelte-kit")
                  .matcher(
                      String.join(" ", scripts.values().stream().map(String::valueOf).toList()))
                  .find();
      String command = text(scripts, script);
      var portMatch = Pattern.compile("(?:^|\\s)(?:--port|-p)(?:=|\\s+)(\\d+)").matcher(command);
      Integer port = portMatch.find() ? validPort(portMatch.group(1)) : null;
      if (port == null) {
        portMatch = Pattern.compile("(?:^|\\s)PORT=(\\d+)").matcher(command);
        if (portMatch.find()) port = validPort(portMatch.group(1));
      }
      return object(
          "name",
          name,
          "runtimeType",
          ui ? "ui" : "service",
          "packageManager",
          manager,
          "runtimeLabel",
          "Node " + text(selected, "version") + " · " + text(selected, "source"),
          "runtimeBin",
          Path.of(text(selected, "executable")).getParent().toString(),
          "nodeVersion",
          selected.get("version"),
          "requiredNode",
          selected.get("requirement"),
          "executable",
          manager,
          "args",
          List.of("run", script),
          "installExecutable",
          manager,
          "installArgs",
          List.of("install"),
          "dependencyDirectory",
          "node_modules",
          "cwd",
          ".",
          "configFile",
          "",
          "port",
          port != null
              ? port
              : packages.contains("vite") ? 5173 : packages.contains("@angular/core") ? 4200 : 3000,
          "managementPort",
          null,
          "portSource",
          port != null ? "package script" : "framework default");
    }
    if (List.of(
            "pyproject.toml",
            "requirements.txt",
            "Pipfile",
            "setup.py",
            "main.py",
            "app.py",
            "manage.py",
            "src/main.py")
        .stream()
        .anyMatch(file -> Files.exists(root.resolve(file)))) {
      var launch = PythonProjectRuntime.run(root, 8000);
      return object(
          "name",
          name,
          "runtimeType",
          "service",
          "projectType",
          "python",
          "packageManager",
          PythonProjectRuntime.manager(root),
          "executable",
          launch.get("executable"),
          "args",
          launch.get("args"),
          "cwd",
          ".",
          "configFile",
          "",
          "port",
          PythonProjectRuntime.entry(root).equals("manage.py") ? 8000 : null,
          "managementPort",
          null,
          "portSource",
          PythonProjectRuntime.entry(root).equals("manage.py")
              ? "Django development server default"
              : "Not configured");
    }
    throw new IllegalArgumentException("Argus could not detect how this repository should run");
  }
}
