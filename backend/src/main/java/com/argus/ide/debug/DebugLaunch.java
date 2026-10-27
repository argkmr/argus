package com.argus.ide.debug;

import static com.argus.runtime.service.RuntimeData.*;

import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Adds debugger flags only to the application invocation, never installation or test jobs. */
public final class DebugLaunch {
  private DebugLaunch() {}

  public static Map<String, Object> prepare(
      Map<String, Object> configuration, Object requestedPort) {
    var result = copyMap(configuration);
    String executable = Path.of(text(result, "executable")).getFileName().toString();
    var args = new ArrayList<>(strings(result.get("args")));
    if (args.stream().anyMatch(arg -> arg.contains("jdwp") || arg.startsWith("--inspect")))
      throw new IllegalArgumentException(
          "Remove existing debugger flags before using Debug service");
    String runtime;
    boolean gradle = executable.equals("gradle") || executable.equals("gradlew");
    String gradleTask = gradle ? gradleTask(args, text(result, "cwd")) : "";
    if (executable.equals("java") || executable.equals("mvn") || executable.equals("mvnw")) {
      if (!executable.equals("java") && !args.contains("spring-boot:run"))
        throw new IllegalArgumentException("Maven debug requires the spring-boot:run goal");
      runtime = "java";
    } else if (gradle) runtime = "java";
    else if (executable.equals("node")) runtime = "node";
    else
      throw new IllegalArgumentException(
          "Debug service supports direct java, Gradle bootRun/run, Maven spring-boot:run, and direct node commands. "
              + "For other wrappers, configure a direct application command first.");
    int port = availablePort(requestedPort);
    if (runtime.equals("java")) {
      String option =
          "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:" + port;
      if (gradle) {
        result.put("gradleDebugTask", gradleTask);
        for (int index = 0; index < args.size(); index++)
          if (args.get(index).matches(":?(?:[A-Za-z0-9_.-]+:)*(?:bootRun|run)"))
            args.set(index, gradleTask);
      } else if (executable.equals("java")) args.add(0, option);
      else {
        if (args.stream().anyMatch(arg -> arg.startsWith("-Dspring-boot.run.jvmArguments")))
          throw new IllegalArgumentException(
              "Existing spring-boot.run.jvmArguments must be removed before debug launch");
        args.add("-Dspring-boot.run.jvmArguments=" + option);
      }
    } else args.add(0, "--inspect=127.0.0.1:" + port);
    result.put("args", args);
    result.put(
        "debug",
        object("runtime", runtime, "host", "127.0.0.1", "port", port, "state", "starting"));
    return result;
  }

  private static String gradleTask(List<String> args, String cwd) {
    var targets =
        args.stream().filter(arg -> arg.matches(":?(?:[A-Za-z0-9_.-]+:)*(?:bootRun|run)")).toList();
    if (targets.size() != 1)
      throw new IllegalArgumentException(
          "Gradle debug requires one explicit bootRun or :module:bootRun/run task. Select the application's saved run configuration.");
    if (args.stream()
        .anyMatch(
            arg ->
                arg.startsWith("--debug-jvm")
                    || arg.startsWith("--no-debug-jvm")
                    || arg.startsWith("-Dorg.gradle.debug")))
      throw new IllegalArgumentException(
          "Remove existing Gradle debugger flags before using Debug service");
    String task = targets.get(0);
    if (!task.startsWith(":") && !cwd.isBlank() && !List.of(".", "./").contains(cwd))
      throw new IllegalArgumentException(
          "For a custom Gradle working directory, use a fully qualified :module:bootRun/run task (or :bootRun/:run for a nested independent build). Argus will not guess project paths from folders.");
    return task.startsWith(":") ? task : ":" + task;
  }

  /** Product-owned init script targets only the application JavaExec, never Gradle's JVM/tests. */
  public static String gradleScript(String task, int port) {
    if (!task.matches("(?::[A-Za-z0-9_.-]+)*:(?:bootRun|run)") || port < 1024 || port > 65535)
      throw new IllegalArgumentException("Invalid Gradle debug target");
    return """
        import org.gradle.api.tasks.JavaExec
        gradle.projectsEvaluated {
          allprojects { project ->
            project.tasks.withType(JavaExec).configureEach { app ->
              if (app.path == '%s') {
                app.doFirst {
                  if (app.jvmArgs.any { it.toString().contains('jdwp') }) {
                    throw new GradleException('Remove existing application JDWP flags before Argus Debug')
                  }
                }
                app.debugOptions {
                  enabled = true
                  host = '127.0.0.1'
                  port = %d
                  server = true
                  suspend = false
                }
              }
            }
          }
        }
        """
        .formatted(task, port);
  }

  private static int availablePort(Object requested) {
    long value = requested == null ? 0 : number(requested);
    if (requested != null
        && (!text(requested).matches("[0-9]{4,5}") || value < 1024 || value > 65535))
      throw new IllegalArgumentException("Debug port must be an integer between 1024 and 65535");
    try (var socket = new ServerSocket((int) value, 1, InetAddress.getByName("127.0.0.1"))) {
      return socket.getLocalPort();
    } catch (IOException error) {
      throw new IllegalArgumentException("The requested loopback debug port is unavailable", error);
    }
  }
}
