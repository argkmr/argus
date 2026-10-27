package com.argus.backup.service;

import com.argus.common.process.GitEnvironment;
import com.argus.common.process.OwnedProcess;
import java.nio.file.Path;
import java.time.Duration;
import java.util.*;
import org.springframework.stereotype.Service;

@Service
public class BackupGit {
  private final Map<String, String> environment;

  @org.springframework.beans.factory.annotation.Autowired
  public BackupGit() {
    this(Map.of());
  }

  BackupGit(Map<String, String> environment) {
    this.environment = Map.copyOf(environment);
  }

  public String run(Path directory, List<String> arguments, Duration timeout) {
    var command = new ArrayList<String>();
    command.add("git");
    // The dedicated backup checkout is data, not permission to run Git hooks or signing helpers.
    command.addAll(List.of("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false"));
    if (directory != null) {
      command.add("-C");
      command.add(directory.toString());
    }
    command.addAll(arguments);
    var builder = new ProcessBuilder(command);
    GitEnvironment.sanitize(builder.environment());
    builder.environment().putAll(environment);
    builder.environment().put("GIT_TERMINAL_PROMPT", "0");
    builder
        .environment()
        .put(
            "GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1");
    try (var process = new OwnedProcess(builder, null, 2_000_000)) {
      process.closeInput();
      var result = process.await(timeout);
      if (result.exitCode() != 0) throw remoteFailure(result.stderr());
      return result.stdout();
    } catch (java.io.IOException error) {
      throw new IllegalStateException("Git backup operation could not start", error);
    } catch (RemoteFailure error) {
      throw error;
    } catch (RuntimeException error) {
      if (Thread.currentThread().isInterrupted()) throw error;
      throw remoteFailure(error.getMessage());
    }
  }

  static RemoteFailure remoteFailure(String details) {
    String text = details == null ? "" : details.toLowerCase(Locale.ROOT);
    if (text.matches(
        "(?s).*(?:admin must whitelist your ip|whitelist(?:ed)? your ip|ip (?:allowlist|whitelist)).*"))
      return new RemoteFailure(
          "BITBUCKET_IP_NOT_ALLOWED",
          "Git remote blocked this network. Connect to your company VPN or ask a Git remote admin to allow this IP, then save again.");
    if (text.matches(
        "(?s).*(?:could not read from remote repository|permission denied \\(publickey\\)|authentication failed|repository not found|could not resolve host|connection timed out|connection refused|command timed out).*"))
      return new RemoteFailure(
          "BITBUCKET_UNAVAILABLE",
          "Git remote could not be reached. Check your network, repository access, and SSH credentials, then save again.");
    return new RemoteFailure(
        "BACKUP_GIT_FAILED",
        "The Git backup operation failed. Check the dedicated backup repository, Git configuration, and remote access, then try again.");
  }

  public static final class RemoteFailure extends IllegalStateException {
    public final String code;

    private RemoteFailure(String code, String message) {
      super(message);
      this.code = code;
    }
  }
}
