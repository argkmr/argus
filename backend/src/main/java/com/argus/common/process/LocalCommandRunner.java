package com.argus.common.process;

import com.argus.common.security.DiagnosticRedaction;
import java.io.IOException;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Component;

@Component
public class LocalCommandRunner implements CommandRunner {

  @Override
  public CommandResult run(
      String executable, List<String> arguments, Path workingDirectory, Duration timeout) {
    List<String> command = new ArrayList<>();
    command.add(executable);
    command.addAll(arguments);
    long startedAt = System.nanoTime();
    String displayCommand = DiagnosticRedaction.redact(String.join(" ", command));
    String operation = operationFor(command);
    ProcessBuilder builder = new ProcessBuilder(command).redirectErrorStream(false);
    if (List.of("codex", "claude").contains(Path.of(executable).getFileName().toString())
        || executable.equals(System.getenv("ARGUS_CODEX_EXECUTABLE"))
        || executable.equals(System.getenv("ARGUS_CLAUDE_EXECUTABLE")))
      ExecutableDiscovery.prepareProvider(builder);
    prepareEnvironment(executable, arguments, builder.environment());
    if (workingDirectory != null) builder.directory(workingDirectory.toFile());
    try (OwnedProcess process = new OwnedProcess(builder, null)) {
      process.closeInput();
      CommandResult result = process.await(timeout);
      String stdout = result.stdout();
      String stderr = result.stderr();
      if (result.exitCode() != 0) {
        String message =
            !stderr.isBlank()
                ? stderr.trim()
                : !stdout.isBlank() ? stdout.trim() : "Command failed";

        throw new CommandFailedException(message, result);
      }

      return result;
    } catch (IOException error) {

      throw new IllegalStateException(
          "Unable to run " + executable + ": " + error.getMessage(), error);
    } catch (IllegalStateException error) {
      if (error instanceof CommandFailedException) throw error;
      String status =
          Thread.currentThread().isInterrupted()
              ? "interrupted"
              : error.getMessage() != null && error.getMessage().contains("timed out")
                  ? "timed-out"
                  : "failed";

      throw new IllegalStateException(error.getMessage() + ": " + executable, error);
    }
  }

  static void prepareEnvironment(
      String executable, List<String> arguments, java.util.Map<String, String> environment) {
    if (!"git".equals(Path.of(executable).getFileName().toString())) return;
    boolean clone = !arguments.isEmpty() && arguments.get(0).equals("clone");
    if (clone || arguments.contains("-C")) GitEnvironment.sanitize(environment);
    if (clone) {
      // Clone has no terminal. Preserve the user's credential helpers, SSH command/variant,
      // identities and host-key policy. Never override core.sshCommand or weaken verification.
      // Closed stdin and the owned-process deadline bound an unavailable interactive auth flow.
      environment.put("GIT_TERMINAL_PROMPT", "0");
      environment.put("GCM_INTERACTIVE", "Never");
    }
  }

  static String safeOutput(String executable, String output) {
    String name = Path.of(executable).getFileName().toString();
    return "security".equals(name) && !output.isBlank() ? "[REDACTED KEYCHAIN OUTPUT]" : output;
  }

  static String operationFor(List<String> command) {
    if (command == null || command.isEmpty()) return "Run local command";
    String executable = Path.of(command.get(0)).getFileName().toString();
    String joined = String.join(" ", command).toLowerCase();
    if ("which".equals(executable)) {
      String provider = command.size() > 1 ? command.get(command.size() - 1) : "AI provider";
      return "Locate " + provider + " CLI";
    }
    if ("codex".equals(executable) || "claude".equals(executable)) {
      String provider = Character.toUpperCase(executable.charAt(0)) + executable.substring(1);
      if (joined.contains(" --version")) return "Check " + provider + " CLI version";
      if (joined.contains(" login status") || joined.contains(" auth status"))
        return "Check " + provider + " authentication";
      return "Run " + provider + " CLI";
    }
    if ("git".equals(executable)) {
      if (joined.contains("rev-parse --show-toplevel")) return "Verify connected repository";
      if (joined.contains("remote get-url")) return "Read repository remote";
      if (joined.contains(" status")) return "Read Git status";
      if (joined.contains(" log")) return "Read Git history";
      if (joined.contains(" diff")) return "Read Git changes";
      return "Run Git operation";
    }
    if ("security".equals(executable)) {
      if (joined.contains("find-generic-password")) return "Read credential from macOS Keychain";
      if (joined.contains("add-generic-password")) return "Save credential to macOS Keychain";
      if (joined.contains("delete-generic-password"))
        return "Remove credential from macOS Keychain";
      return "Access macOS Keychain";
    }
    return "Run " + executable + " command";
  }
}
