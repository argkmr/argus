package com.argus.onboarding.service;

import com.argus.common.process.CommandFailedException;
import java.net.URI;
import java.nio.file.Path;
import java.util.Locale;

/** Clone transport policy. It never reads credentials or changes Git/SSH configuration. */
final class RepositoryCloneAuth {
  private RepositoryCloneAuth() {}

  static String validate(String input) {
    String remote = input == null ? "" : input.trim();
    if (remote.isEmpty()
        || remote.chars().anyMatch(Character::isISOControl)
        || remote.startsWith("-")) throw invalid();
    if (Path.of(remote).isAbsolute()) return remote;
    if (remote.matches("[\\w.+-]+@[\\w.-]+:[^\\s]+")) {
      if (tokenLike(remote.substring(0, remote.indexOf('@')))) throw invalid();
      return remote;
    }
    try {
      URI uri = URI.create(remote);
      String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
      if (!java.util.Set.of("https", "http", "ssh", "git", "file").contains(scheme)
          || uri.getRawQuery() != null
          || uri.getRawFragment() != null
          || (!scheme.equals("file") && uri.getHost() == null)) throw invalid();
      String user = uri.getRawUserInfo();
      // A normal Git username is supported; passwords, percent-encoded credentials, and common
      // token formats must never reach the command line, remote config, or activity log.
      if (user != null && (!user.matches("[A-Za-z0-9._-]{1,64}") || tokenLike(user)))
        throw new IllegalArgumentException(
            "Do not put a password or access token in the Git URL. Use your Git credential helper or an SSH URL instead.");
      return remote;
    } catch (IllegalArgumentException error) {
      if (error.getMessage() != null && error.getMessage().startsWith("Do not put")) throw error;
      throw invalid();
    }
  }

  static String bitbucketSsh(String remote) {
    try {
      validate(remote);
      URI uri = URI.create(remote);
      if (!"https".equalsIgnoreCase(uri.getScheme())
          || !"bitbucket.org".equalsIgnoreCase(uri.getHost())
          || (uri.getPort() != -1 && uri.getPort() != 443)
          || uri.getRawQuery() != null
          || uri.getRawFragment() != null) return "";
      String path = uri.getRawPath();
      if (path == null || !path.matches("/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/?")) return "";
      String[] parts = path.replaceFirst("/$", "").substring(1).split("/");
      String repository = parts[1].replaceFirst("(?i)\\.git$", "");
      if (parts[0].equals(".")
          || parts[0].equals("..")
          || repository.isBlank()
          || repository.equals(".")
          || repository.equals("..")) return "";
      return "git@bitbucket.org:" + parts[0] + "/" + repository + ".git";
    } catch (IllegalArgumentException error) {
      return "";
    }
  }

  static String transport(String remote) {
    if (remote.matches("[\\w.+-]+@[\\w.-]+:[^\\s]+")) return "ssh";
    if (Path.of(remote).isAbsolute() || remote.startsWith("file:")) return "local";
    return URI.create(remote).getScheme().toLowerCase(Locale.ROOT);
  }

  static boolean authenticationFailure(RuntimeException error) {
    if (!(error instanceof CommandFailedException) || Thread.currentThread().isInterrupted())
      return false;
    String detail = detail(error);
    // Do not let incidental authentication wording turn a transport/security failure into a retry.
    if (detail.matches(
        "(?s).*(?:could not resolve|certificate|ssl|tls|timed out|timeout|interrupted|cancelled|canceled|no space left|permission denied|host key|connection refused|failed to connect|couldn't connect|connection reset|whitelist your ip|ip allowlist|ip whitelist).*"))
      return false;
    return detail.matches(
        "(?s).*(?:authentication failed|could not read (?:username|password)|terminal prompts disabled|http basic: access denied|requested url returned error: (?:401|403)).*");
  }

  static String failureMessage(RuntimeException error, String transport, boolean fallbackUsed) {
    if (Thread.currentThread().isInterrupted() || detail(error).contains("interrupted"))
      return "Repository cloning was interrupted. No further attempts were started.";
    String detail = detail(error);
    if (detail.matches(
        "(?s).*(?:host key verification failed|remote host identification has changed).*"))
      return "Git could not verify the SSH host key. Verify the server identity in your SSH setup before retrying. Argus has not changed known hosts.";
    if (detail.matches(
        "(?s).*(?:could not resolve|timed out|timeout|connection refused|failed to connect|couldn't connect|connection reset).*"))
      return "Git could not reach the repository. Check your network or company VPN and try again.";
    if (detail.matches("(?s).*(?:certificate|ssl|tls).*"))
      return "Git could not verify the secure connection. Check your Git certificate configuration; Argus has not disabled certificate verification.";
    if (fallbackUsed)
      return "HTTPS authentication failed, and the SSH retry could not access this Git remote repository. Check that this Mac's SSH key has repository access, or configure HTTPS credentials in your Git credential helper and retry. Argus has not changed your credentials.";
    if (authenticationFailure(error)
        || detail.matches(
            "(?s).*(?:permission denied \\(publickey\\)|could not read from remote repository|repository not found).*"))
      return transport.equals("ssh")
          ? "Git could not authenticate with SSH or access this repository. Check that this Mac's SSH key has repository access, then retry."
          : "Git needs saved HTTPS credentials for this repository. Configure your Git credential helper with a valid credential, or use the repository's SSH clone URL. Argus cannot open a terminal password prompt.";
    return "Git could not clone this repository. Check the repository URL, destination permissions and available disk space, then retry.";
  }

  private static String detail(RuntimeException error) {
    return String.valueOf(error.getMessage()).toLowerCase(Locale.ROOT);
  }

  private static boolean tokenLike(String user) {
    return user.matches("(?i)(?:gh[pousr]_.*|github_pat_.*|glpat-.*|ATATT.*)");
  }

  private static IllegalArgumentException invalid() {
    return new IllegalArgumentException(
        "Use an HTTPS, SSH, Git, file, or absolute local repository URL without embedded credentials, query parameters, or fragments.");
  }
}
