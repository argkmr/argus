package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Shared Python command selection; inspecting a project never creates or activates an environment.
 */
final class PythonProjectRuntime {
  private PythonProjectRuntime() {}

  static String manager(Path root) {
    if (Files.exists(root.resolve("uv.lock"))) return "uv";
    if (Files.exists(root.resolve("poetry.lock"))) return "poetry";
    if (Files.exists(root.resolve("Pipfile"))) return "pipenv";
    return "pip";
  }

  static String entry(Path root) {
    return List.of("main.py", "app.py", "manage.py", "src/main.py").stream()
        .filter(name -> Files.isRegularFile(root.resolve(name)))
        .findFirst()
        .orElse("");
  }

  static String virtualEnvironment(Path root) {
    for (String name : List.of(".venv", "venv")) {
      Path directory = inside(root, name);
      for (String executable : List.of("python3", "python"))
        if (Files.isRegularFile(directory.resolve("bin").resolve(executable))
            && Files.isExecutable(directory.resolve("bin").resolve(executable))) return name;
    }
    return "";
  }

  static Map<String, Object> python(Path root, List<String> arguments) {
    String manager = manager(root);
    if (!manager.equals("pip")) {
      var args = new ArrayList<>(List.of("run", "python"));
      args.addAll(arguments);
      return object("executable", manager, "args", args);
    }
    return object("executable", interpreter(root), "args", arguments);
  }

  static String interpreter(Path root) {
    String environment = virtualEnvironment(root);
    if (!environment.isEmpty())
      for (String name : List.of("python3", "python")) {
        Path candidate = root.toAbsolutePath().resolve(environment).resolve("bin").resolve(name);
        if (Files.isRegularFile(candidate) && Files.isExecutable(candidate))
          return candidate.toString();
      }
    return "python3";
  }

  static Map<String, Object> run(Path root, int port) {
    String entry = entry(root);
    if (entry.isEmpty())
      throw new IllegalArgumentException(
          "Argus detected Python metadata but could not find an entry point. Configure the repository's command in Services.");
    return python(
        root,
        entry.equals("manage.py")
            ? List.of(entry, "runserver", "127.0.0.1:" + port)
            : List.of(entry));
  }

  static Map<String, Object> sync(Path root) {
    String manager = manager(root);
    if (!manager.equals("pip"))
      return object(
          "executable", manager, "args", List.of(manager.equals("uv") ? "sync" : "install"));
    List<String> arguments =
        Files.exists(root.resolve("requirements.txt"))
            ? List.of("-m", "pip", "install", "-r", "requirements.txt")
            : List.of("-m", "pip", "install", "-e", ".");
    if (!virtualEnvironment(root).isEmpty()) return python(root, arguments);
    // This product-owned bootstrap runs only after an explicit dependency-sync action.
    // exec preserves the owned process identity while pip runs inside the new local environment.
    inside(root, ".venv");
    var args =
        new ArrayList<>(
            List.of(
                "-c",
                "import os, pathlib, sys, venv; "
                    + "directory = pathlib.Path('.venv'); "
                    + "venv.EnvBuilder(with_pip=True).create(directory); "
                    + "python = str(directory.resolve() / 'bin' / 'python'); "
                    + "os.execv(python, [python, *sys.argv[1:]])"));
    args.addAll(arguments);
    return object("executable", "python3", "args", args);
  }

  static String shellCommand(Map<String, Object> command) {
    String executable = text(command, "executable");
    return (executable.matches("[A-Za-z0-9_./-]+")
            ? executable
            : ProjectStructureService.shellQuote(executable))
        + strings(command.get("args")).stream()
            .map(ProjectStructureService::shellQuote)
            .collect(java.util.stream.Collectors.joining(" ", " ", ""));
  }
}
