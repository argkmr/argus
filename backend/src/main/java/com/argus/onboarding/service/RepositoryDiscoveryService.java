package com.argus.onboarding.service;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.common.process.CommandRunner;
import com.argus.repositorycontext.service.RepositoryContextService;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Duration;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Service;

@Service
public class RepositoryDiscoveryService {
  private final CommandRunner commands;
  private static final Set<String> IGNORED =
      Set.of(
          ".git",
          ".gradle",
          ".idea",
          ".next",
          ".turbo",
          ".vscode",
          "build",
          "coverage",
          "dist",
          "node_modules",
          "out",
          "target",
          "vendor");

  public RepositoryDiscoveryService(CommandRunner commands) {
    this.commands = commands;
  }

  private boolean repositoryRoot(Path path) {
    Path marker = path.resolve(".git");
    // Keep broken worktrees visible as individual diagnostic rows instead of aborting a scan.
    return Files.isRegularFile(marker) || Files.isDirectory(marker);
  }

  private void scan(Path root, int depth, Set<String> repositories) {
    if (depth > 16 || !Files.isDirectory(root)) return;
    if (repositoryRoot(root)) {
      try {
        repositories.add(root.toRealPath().toString());
      } catch (java.io.IOException ignored) {
        repositories.add(root.toAbsolutePath().normalize().toString());
      }
      return;
    }
    try (var entries = Files.list(root)) {
      entries
          .filter(
              path ->
                  Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)
                      && !IGNORED.contains(path.getFileName().toString()))
          .forEach(path -> scan(path, depth + 1, repositories));
    } catch (java.io.IOException ignored) {
    }
  }

  public List<String> discover(List<String> input) {
    var repositories = new LinkedHashSet<String>();
    for (String path : input) scan(Path.of(path).toAbsolutePath().normalize(), 0, repositories);
    return repositories.stream().sorted().toList();
  }

  public Map<String, Object> branchOptions(String path) {
    String root =
        commands
            .run(
                "git",
                List.of("-C", path, "rev-parse", "--show-toplevel"),
                null,
                Duration.ofSeconds(30))
            .stdout()
            .trim();
    Path resolved = Path.of(root).toAbsolutePath().normalize();
    try {
      resolved = resolved.toRealPath();
    } catch (java.io.IOException ignored) {
    }
    String refs =
        commands
            .run(
                "git",
                List.of(
                    "-C",
                    resolved.toString(),
                    "for-each-ref",
                    "--format=%(refname:short)",
                    "refs/heads",
                    "refs/remotes/origin"),
                null,
                Duration.ofSeconds(30))
            .stdout();
    var branches =
        refs.lines()
            .map(String::trim)
            .map(value -> value.replaceFirst("^origin/", ""))
            .filter(
                value -> !value.isEmpty() && !value.equals("HEAD") && !value.equals("origin/HEAD"))
            .distinct()
            .sorted()
            .toList();
    return object(
        "path",
        resolved.toString(),
        "name",
        resolved.getFileName().toString(),
        "branches",
        branches,
        "productionBranch",
        branches.contains("main") ? "main" : branches.contains("master") ? "master" : "");
  }

  public static String validateRemote(String input) {
    return RepositoryCloneAuth.validate(input);
  }

  public Map<String, Object> inspect(String path) {
    try {
      var result = branchOptions(path);
      boolean eligible = !strings(result.get("branches")).isEmpty();
      result.put("eligible", eligible);
      result.put(
          "error",
          eligible
              ? ""
              : "This repository has no committed local or origin branch. Create its first commit (or fetch a branch), then choose the folder again.");
      return result;
    } catch (RuntimeException error) {
      Path root = Path.of(path).toAbsolutePath().normalize();
      return object(
          "path",
          root.toString(),
          "name",
          root.getFileName() == null ? root.toString() : root.getFileName().toString(),
          "branches",
          List.of(),
          "productionBranch",
          "",
          "eligible",
          false,
          "error",
          "This Git repository could not be read. Check its Git/worktree metadata and folder access, then choose it again.");
    }
  }

  public Map<String, Object> prerequisites() {
    try {
      String output =
          commands.run("git", List.of("--version"), null, Duration.ofSeconds(10)).stdout().trim();
      var version =
          java.util.regex.Pattern.compile("git version (\\d+)\\.(\\d+)(?:\\.(\\d+))?")
              .matcher(output);
      boolean known = version.find();
      boolean compatible =
          known
              && (Integer.parseInt(version.group(1)) > 2
                  || Integer.parseInt(version.group(1)) == 2
                      && Integer.parseInt(version.group(2)) >= 31);
      return object(
          "available",
          true,
          "compatible",
          compatible,
          "version",
          output,
          "minimumVersion",
          "2.31.0",
          "message",
          compatible
              ? "Git is ready. Choose a repository with at least one commit, or clone one."
              : "Argus requires Git 2.31 or newer. Update Git, then restart Argus and retry.");
    } catch (RuntimeException error) {
      return object(
          "available",
          false,
          "compatible",
          false,
          "version",
          "",
          "minimumVersion",
          "2.31.0",
          "message",
          "Git is unavailable. Install Git 2.31 or newer (macOS Command Line Tools or Homebrew), then restart Argus and retry.");
    }
  }

  public static String remoteName(String input) {
    String remote = input.trim().replaceFirst("/+$", "");
    String[] pieces = remote.split("[/:]");
    String name = pieces[pieces.length - 1];
    if (Path.of(remote).isAbsolute()) {
      Path filename = Path.of(remote).getFileName();
      name = filename == null ? "" : filename.toString();
    } else if (remote.contains("://") || remote.regionMatches(true, 0, "file:", 0, 5)) {
      String rawPath = java.net.URI.create(remote).getRawPath();
      if (rawPath == null || rawPath.isBlank())
        throw new IllegalArgumentException("Enter a Git URL with a valid repository name");
      name = rawPath.substring(rawPath.lastIndexOf('/') + 1);
      name = java.net.URI.create("file:/" + name).getPath().substring(1);
    }
    name = name.replaceFirst("(?i)\\.git$", "");
    if (name.isBlank()
        || name.equals(".")
        || name.equals("..")
        || name.contains("/")
        || name.contains("\\")
        || name.chars().anyMatch(Character::isISOControl))
      throw new IllegalArgumentException("Enter a Git URL with a valid repository name");
    return name;
  }

  public String cloneRepository(String input, String parentDirectory) {
    return cloneWithDetails(input, parentDirectory).path();
  }

  public record CloneResult(String path, String transport, boolean fallbackUsed) {}

  public CloneResult cloneWithDetails(String input, String parentDirectory) {
    String remote = validateRemote(input);
    Path parent;
    try {
      parent = Path.of(parentDirectory).toRealPath();
      if (!Files.isDirectory(parent)) throw new java.io.IOException();
    } catch (Exception error) {
      throw new IllegalArgumentException("Choose an existing destination folder");
    }
    String name = remoteName(remote);
    Path target = parent.resolve(name);
    if (Files.exists(target, LinkOption.NOFOLLOW_LINKS))
      throw new org.springframework.web.server.ResponseStatusException(
          org.springframework.http.HttpStatus.CONFLICT,
          "A file or folder named " + name + " already exists in the selected destination");
    // Reserve the absent target atomically so cleanup cannot consume a concurrently created folder.
    Object reservation = reserve(target);
    String transport = RepositoryCloneAuth.transport(remote);
    boolean fallbackUsed = false;
    try {
      try {
        runClone(remote, target);
      } catch (RuntimeException first) {
        String ssh = RepositoryCloneAuth.bitbucketSsh(remote);
        if (ssh.isBlank() || !RepositoryCloneAuth.authenticationFailure(first)) throw first;
        cleanReservation(target, reservation);
        if (Thread.currentThread().isInterrupted()) throw first;
        reservation = reserve(target);
        transport = "ssh";
        fallbackUsed = true;
        runClone(ssh, target);
      }
      return new CloneResult(target.toString(), transport, fallbackUsed);
    } catch (RuntimeException error) {
      try {
        cleanReservation(target, reservation);
      } catch (java.io.IOException cleanup) {
        error.addSuppressed(cleanup);
      }
      throw new IllegalArgumentException(
          RepositoryCloneAuth.failureMessage(error, transport, fallbackUsed));
    } catch (java.io.IOException error) {
      // Ownership changed or cleanup failed: do not retry into, or delete, an unowned directory.
      throw new IllegalArgumentException(
          "The clone destination changed or could not be cleaned safely. Check the destination folder before retrying.");
    }
  }

  private void runClone(String remote, Path target) {
    if (Thread.currentThread().isInterrupted())
      throw new IllegalStateException("Repository cloning was interrupted");
    commands.run(
        "git",
        List.of("clone", "--origin", "origin", "--", remote, target.toString()),
        null,
        Duration.ofMinutes(15));
  }

  private static Object reserve(Path target) {
    try {
      Files.createDirectory(target);
      Object key =
          Files.readAttributes(target, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS)
              .fileKey();
      if (key == null) throw new java.io.IOException("Directory identity is unavailable");
      return key;
    } catch (java.io.IOException error) {
      throw new IllegalArgumentException("Could not reserve the clone destination safely");
    }
  }

  private static void cleanReservation(Path target, Object key) throws java.io.IOException {
    if (!Files.exists(target, LinkOption.NOFOLLOW_LINKS)) return;
    var current =
        Files.readAttributes(target, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    if (!current.isDirectory() || !java.util.Objects.equals(key, current.fileKey()))
      throw new java.io.IOException("The clone destination is no longer owned by this request");
    RepositoryContextService.deleteTree(target);
  }
}
