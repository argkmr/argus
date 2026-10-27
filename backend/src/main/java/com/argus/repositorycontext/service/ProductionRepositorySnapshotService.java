package com.argus.repositorycontext.service;

import com.argus.common.config.ArgusProperties;
import com.argus.common.process.CommandRunner;
import com.argus.workspace.domain.Repository;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.function.Function;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

@Service
public class ProductionRepositorySnapshotService {
  private static final Duration GIT_TIMEOUT = Duration.ofMinutes(3);
  private final CommandRunner commands;
  private final Path snapshotRoot;

  public ProductionRepositorySnapshotService(CommandRunner commands) {
    this.commands = commands;
    this.snapshotRoot = Path.of(System.getProperty("java.io.tmpdir"), "argus-production-snapshots");
  }

  @Autowired
  public ProductionRepositorySnapshotService(CommandRunner commands, ArgusProperties properties) {
    this.commands = commands;
    this.snapshotRoot = properties.dataDirectory().resolve("production-snapshots");
  }

  public final class SnapshotLease implements AutoCloseable {
    private final Repository original;
    private final Repository snapshot;
    private final Path temporaryRoot;
    private boolean closed;

    SnapshotLease(Repository original, Repository snapshot, Path temporaryRoot) {
      this.original = original;
      this.snapshot = snapshot;
      this.temporaryRoot = temporaryRoot;
    }

    public Repository repository() {
      return snapshot;
    }

    @Override
    public synchronized void close() {
      if (closed) return;
      commands.run(
          "git",
          List.of("-C", original.path(), "worktree", "remove", "--force", snapshot.path()),
          null,
          Duration.ofMinutes(1));
      try {
        Files.deleteIfExists(temporaryRoot);
      } catch (java.io.IOException error) {
        throw new IllegalStateException(
            "Could not remove the completed production snapshot directory", error);
      }
      closed = true;
    }
  }

  /** The caller retains this lease until the asynchronous CLI has actually completed. */
  public SnapshotLease open(Repository repository) {
    String branch = productionBranch(repository);
    String warning = "";
    try {
      commands.run(
          "git",
          List.of(
              "-C",
              repository.path(),
              "fetch",
              "origin",
              "+refs/heads/" + branch + ":refs/remotes/origin/" + branch),
          null,
          GIT_TIMEOUT);
    } catch (RuntimeException error) {
      warning = error.getMessage();
    }
    String selected = "";
    for (String ref : List.of("refs/remotes/origin/" + branch, "refs/heads/" + branch))
      try {
        commands.run(
            "git",
            List.of("-C", repository.path(), "rev-parse", "--verify", ref + "^{commit}"),
            null,
            Duration.ofSeconds(10));
        selected = ref;
        break;
      } catch (RuntimeException ignored) {
      }
    if (selected.isEmpty())
      throw new IllegalStateException(
          warning.isBlank()
              ? "Production branch " + branch + " is not available locally for " + repository.name()
              : warning);
    Path temporary = null;
    try {
      Files.createDirectories(snapshotRoot);
      temporary = Files.createTempDirectory(snapshotRoot, "snapshot-");
      Path worktree = temporary.resolve("repository");
      commands.run(
          "git",
          List.of(
              "-C",
              repository.path(),
              "worktree",
              "add",
              "--detach",
              worktree.toString(),
              selected),
          null,
          GIT_TIMEOUT);
      var snapshot =
          new Repository(
              repository.id(),
              repository.name(),
              worktree.toString(),
              repository.addedAt(),
              branch);
      snapshot.additionalProperties().putAll(repository.additionalProperties());
      snapshot.additionalProperties().put("developerPath", repository.path());
      snapshot.additionalProperties().put("sourcePath", worktree.toString());
      snapshot.additionalProperties().put("snapshotRef", selected);
      snapshot.additionalProperties().put("snapshotRefreshWarning", warning);
      return new SnapshotLease(repository, snapshot, temporary);
    } catch (Exception error) {
      if (temporary != null) {
        // Only this invocation's freshly reserved snapshot tree is eligible for rollback.
        Path ownedWorktree = temporary.resolve("repository");
        if (Files.exists(ownedWorktree))
          try {
            commands.run(
                "git",
                List.of(
                    "-C",
                    repository.path(),
                    "worktree",
                    "remove",
                    "--force",
                    ownedWorktree.toString()),
                null,
                Duration.ofMinutes(1));
          } catch (RuntimeException cleanup) {
            error.addSuppressed(cleanup);
          }
        try {
          com.argus.repositorycontext.service.RepositoryContextService.deleteTree(temporary);
        } catch (Exception cleanup) {
          error.addSuppressed(cleanup);
        }
      }
      throw new IllegalStateException(
          "Could not prepare production branch "
              + branch
              + " for "
              + repository.name()
              + ": "
              + error.getMessage(),
          error);
    }
  }

  public java.util.Map<String, Object> remoteRevision(Repository repository) {
    String branch = productionBranch(repository);
    String output =
        commands
            .run(
                "git",
                List.of(
                    "-C",
                    repository.path(),
                    "ls-remote",
                    "--heads",
                    "origin",
                    "refs/heads/" + branch),
                null,
                Duration.ofSeconds(30))
            .stdout()
            .trim();
    String revision = output.split("\\s+")[0];
    if (!revision.matches("(?i)[a-f0-9]{40,64}"))
      throw new IllegalStateException(
          "Production branch " + branch + " was not found on origin for " + repository.name());
    return java.util.Map.of("branch", branch, "revision", revision);
  }

  public <T> T withSnapshot(Repository repository, Function<Path, T> operation) {
    try (SnapshotLease lease = open(repository)) {
      return operation.apply(Path.of(lease.repository().path()));
    }
  }

  public String productionBranch(Repository repository) {
    return productionBranch(repository, Path.of(repository.path()));
  }

  private String productionBranch(Repository repository, Path root) {
    if (!repository.productionBranch().isBlank()) return repository.productionBranch();
    String refs =
        commands
            .run(
                "git",
                List.of(
                    "-C",
                    root.toString(),
                    "for-each-ref",
                    "--format=%(refname:short)",
                    "refs/heads",
                    "refs/remotes/origin"),
                null,
                Duration.ofSeconds(30))
            .stdout();
    List<String> branches = refs.lines().map(value -> value.replaceFirst("^origin/", "")).toList();
    if (branches.contains("main")) return "main";
    if (branches.contains("master")) return "master";
    throw new IllegalStateException(
        "Select a production branch for " + repository.name() + " before preparing an AI kit");
  }
}
