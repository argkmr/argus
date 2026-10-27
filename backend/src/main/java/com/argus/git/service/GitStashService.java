package com.argus.git.service;

import com.argus.common.error.ConflictException;
import com.argus.common.process.CommandFailedException;
import com.argus.common.process.CommandResult;
import com.argus.common.process.CommandRunner;
import com.argus.common.security.DiagnosticRedaction;
import com.argus.git.dto.GitStashEntry;
import com.argus.git.dto.GitStashPopRequest;
import com.argus.git.dto.GitStashRequest;
import com.argus.git.dto.GitStashResponse;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.springframework.stereotype.Service;

/** Local stash operations only; applying a captured object never substitutes a newer stash. */
@Service
public class GitStashService {
  private static final Duration TIMEOUT = Duration.ofSeconds(30);
  private static final String OBJECT_ID = "(?:[a-f0-9]{40}|[a-f0-9]{64})";
  private static final String STASH_REF = "stash@\\{(?:0|[1-9][0-9]{0,5})\\}";
  private final CommandRunner commands;
  private final GitFileRevertService reverts;

  public GitStashService(CommandRunner commands, GitFileRevertService reverts) {
    this.commands = commands;
    this.reverts = reverts;
  }

  public List<GitStashEntry> list(Path root) {
    Path connected = realRoot(root);
    synchronized (reverts.lock(connected)) {
      requireWorktree(connected);
      return entries(connected);
    }
  }

  public GitStashResponse create(Path root, GitStashRequest request) {
    String message = validMessage(request == null ? null : request.message());
    boolean includeUntracked = request != null && request.includeUntracked();
    Path connected = realRoot(root);
    synchronized (reverts.lock(connected)) {
      requireReady(connected);
      if (!trackedChanges(connected)
          && (!includeUntracked
              || git(connected, "ls-files", "--others", "--exclude-standard", "-z")
                  .stdout()
                  .isEmpty()))
        return response(true, "empty", null, false, false, false, "No eligible changes to stash.");
      List<GitStashEntry> before = entries(connected);
      var args = new ArrayList<>(List.of("stash", "push", "--message", message));
      if (includeUntracked) args.add("--include-untracked");
      args.add("--");
      try {
        git(connected, args);
      } catch (RuntimeException error) {
        // Git may have saved the stash before a later cleanup/timeout failed. Never auto-retry.
        GitStashEntry saved = newTop(connected, before);
        return response(
            false,
            saved == null ? "stash_failed" : "created_retained",
            saved,
            false,
            false,
            saved != null,
            "Stash did not finish cleanly. Check the stash list and working tree before retrying. "
                + diagnostic(error));
      }
      GitStashEntry saved = newTop(connected, before);
      if (saved == null)
        return response(
            false,
            "stash_failed",
            null,
            false,
            false,
            false,
            "Git finished but the new stash could not be identified. Refresh before retrying.");
      try {
        if (trackedChanges(connected)
            || (includeUntracked
                && !git(connected, "ls-files", "--others", "--exclude-standard", "-z")
                    .stdout()
                    .isEmpty()))
          return response(
              false,
              "created_retained",
              saved,
              false,
              false,
              true,
              "The stash was saved, but eligible working-tree changes remain. Inspect the stash and working tree before taking another action; no retry was attempted.");
      } catch (RuntimeException error) {
        return response(
            false,
            "created_retained",
            saved,
            false,
            false,
            true,
            "The stash was saved, but working-tree cleanup could not be verified. Inspect the stash and working tree before retrying. "
                + diagnostic(error));
      }
      return response(
          true,
          "created",
          saved,
          false,
          false,
          true,
          includeUntracked
              ? "Tracked and untracked changes stashed locally. Ignored files were not included."
              : "Tracked changes stashed locally. Untracked and ignored files were left in place.");
    }
  }

  public GitStashResponse pop(Path root, GitStashPopRequest request) {
    validateSelection(request);
    Path connected = realRoot(root);
    synchronized (reverts.lock(connected)) {
      requireReady(connected);
      GitStashEntry selected = selected(connected, request);
      if (trackedChanges(connected))
        throw new ConflictException(
            "Commit or stash current tracked and staged changes before popping a stash.");
      refusePathCollisions(connected, selected.id());
      // Recheck after preflight; never use `pop` or a moving ref for the apply itself.
      List<GitStashEntry> beforeApply = entries(connected);
      selected(connected, request);
      try {
        // Directory-rename inference can redirect a checked stash path to an unchecked ignored
        // local file and overwrite it even on conflict. Keep new files at their checked paths.
        git(
            connected,
            "-c",
            "merge.directoryRenames=false",
            "stash",
            "apply",
            "--index",
            selected.id());
      } catch (RuntimeException error) {
        boolean conflicts = hasUnmerged(connected);
        return response(
            false,
            conflicts ? "conflicts" : "apply_failed",
            selected,
            false,
            false,
            true,
            "The stash was kept. The working tree may contain partially applied changes; inspect it"
                + (conflicts ? " and resolve conflicts" : "")
                + " before retrying. "
                + diagnostic(error));
      }
      // Successful apply can still be followed by a failed check/drop. Report applied progress.
      try {
        if (hasUnmergedStrict(connected))
          return retained(
              selected, "Git reported success but unresolved paths remain; resolve them first.");
        if (!entries(connected).equals(beforeApply))
          return retained(
              selected,
              "Changes were applied, but the stash list changed during the operation. The selected stash was not removed; refresh before taking another action.");
        requireSameSelection(connected, request);
        // The shared Argus lock serializes its own callers, not unrelated external Git clients.
        // Recheck immediately before dropping and never fall back to a different ref or latest.
        git(connected, "stash", "drop", request.ref());
      } catch (RuntimeException error) {
        return retained(
            selected,
            "Changes were applied. The stash was not confirmed removed; inspect the list before"
                + " applying again. "
                + diagnostic(error));
      }
      return response(
          true,
          "popped",
          selected,
          true,
          true,
          false,
          "Stash applied with its staged state and removed locally.");
    }
  }

  private GitStashResponse retained(GitStashEntry selected, String message) {
    return response(false, "applied_retained", selected, true, false, true, message);
  }

  private GitStashResponse response(
      boolean ok,
      String status,
      GitStashEntry stash,
      boolean applied,
      boolean dropped,
      boolean retained,
      String message) {
    return new GitStashResponse(ok, status, stash, applied, dropped, retained, message);
  }

  private GitStashEntry newTop(Path root, List<GitStashEntry> before) {
    try {
      List<GitStashEntry> after = entries(root);
      if (!after.isEmpty() && (before.isEmpty() || !after.get(0).id().equals(before.get(0).id())))
        return after.get(0);
    } catch (RuntimeException ignored) {
      // A post-operation refresh must never invite an automatic second mutation.
    }
    return null;
  }

  private GitStashEntry selected(Path root, GitStashPopRequest request) {
    GitStashEntry entry =
        entries(root).stream()
            .filter(item -> item.ref().equals(request.ref()) && item.id().equals(request.id()))
            .findFirst()
            .orElseThrow(GitStashService::stale);
    requireSameSelection(root, request);
    return entry;
  }

  private void requireSameSelection(Path root, GitStashPopRequest request) {
    try {
      if (!git(root, "rev-parse", "--verify", "--end-of-options", "refs/" + request.ref())
          .stdout()
          .trim()
          .equals(request.id())) throw stale();
    } catch (CommandFailedException error) {
      throw stale();
    }
  }

  private static ConflictException stale() {
    return new ConflictException(
        "The selected stash changed or disappeared. Refresh the stash list; no different stash will be used.");
  }

  private List<GitStashEntry> entries(Path root) {
    String output =
        git(root, "stash", "list", "--max-count=200", "-z", "--format=%H%x00%gd%x00%cI%x00%gs")
            .stdout();
    if (output.isEmpty()) return List.of();
    String[] fields = output.split("\u0000", -1);
    if ((fields.length - 1) % 4 != 0 || !fields[fields.length - 1].isEmpty())
      throw new IllegalStateException(
          "Git returned an unreadable stash list; no changes were made.");
    var result = new ArrayList<GitStashEntry>();
    for (int index = 0; index < fields.length - 1; index += 4) {
      if (!fields[index].matches(OBJECT_ID) || !fields[index + 1].matches(STASH_REF))
        throw new IllegalStateException(
            "Git returned an invalid stash identity; no changes were made.");
      result.add(
          new GitStashEntry(
              fields[index],
              fields[index + 1],
              fields[index + 3],
              OffsetDateTime.parse(fields[index + 2]).toInstant().toString()));
    }
    return List.copyOf(result);
  }

  private void requireWorktree(Path root) {
    if (!git(root, "rev-parse", "--is-inside-work-tree").stdout().trim().equals("true"))
      throw new ConflictException("Stash requires a non-bare working repository.");
    Path actual = realRoot(Path.of(git(root, "rev-parse", "--show-toplevel").stdout().strip()));
    if (!root.equals(actual))
      throw new ConflictException("The connected directory is not the Git working-tree root.");
  }

  private void requireReady(Path root) {
    requireWorktree(root);
    try {
      git(root, "rev-parse", "--verify", "HEAD^{commit}");
    } catch (CommandFailedException error) {
      throw new ConflictException("Create an initial commit before using stash.");
    }
    Path metadata = Path.of(git(root, "rev-parse", "--absolute-git-dir").stdout().strip());
    for (String marker :
        List.of(
            "MERGE_HEAD",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "REBASE_HEAD",
            "BISECT_LOG",
            "rebase-merge",
            "rebase-apply",
            "sequencer",
            "index.lock"))
      if (Files.exists(metadata.resolve(marker), LinkOption.NOFOLLOW_LINKS))
        throw new ConflictException(
            "Finish the current Git operation before using stash (" + marker + ").");
    if (hasUnmergedStrict(root))
      throw new ConflictException("Resolve unmerged paths before using stash.");
  }

  private boolean trackedChanges(Path root) {
    return different(root, false) || different(root, true);
  }

  private boolean different(Path root, boolean staged) {
    var args =
        new ArrayList<>(
            List.of(
                "diff", "--quiet", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none"));
    if (staged) args.add("--cached");
    try {
      git(root, args);
      return false;
    } catch (CommandFailedException error) {
      if (error.result().exitCode() == 1) return true;
      throw error;
    }
  }

  private boolean hasUnmergedStrict(Path root) {
    return !git(root, "ls-files", "--unmerged", "-z").stdout().isEmpty();
  }

  private boolean hasUnmerged(Path root) {
    try {
      return hasUnmergedStrict(root);
    } catch (RuntimeException ignored) {
      return false;
    }
  }

  private void refusePathCollisions(Path root, String id) {
    String[] parents =
        git(root, "rev-list", "--parents", "-n", "1", id).stdout().strip().split(" ");
    if (parents.length < 3 || parents.length > 4)
      throw new ConflictException("The selected object is not a supported Git stash.");
    Set<String> tracked = new HashSet<>(nulPaths(git(root, "ls-files", "-z").stdout()));
    // A modification in the stash can become an addition on a branch that deleted that path.
    // Git's merge may overwrite ignored files even when it returns a conflict. Check every
    // changed worktree AND index path, not only additions relative to the original stash base.
    var restoredPaths = new HashSet<>(changedPaths(root, id + "^1", id));
    restoredPaths.addAll(changedPaths(root, id + "^1", id + "^2"));
    if (parents.length == 4)
      restoredPaths.addAll(
          nulPaths(git(root, "ls-tree", "-r", "--name-only", "-z", id + "^3").stdout()));
    for (String name : restoredPaths) {
      Path file = root.resolve(name).normalize();
      if (!file.startsWith(root) || file.equals(root))
        throw new ConflictException("The stash contains an unsupported path.");
      Path current = root;
      for (Path part : root.relativize(file)) {
        current = current.resolve(part);
        if (!current.equals(file)
            && Files.exists(current, LinkOption.NOFOLLOW_LINKS)
            && (!Files.isDirectory(current, LinkOption.NOFOLLOW_LINKS)
                || Files.isSymbolicLink(current)))
          throw new ConflictException(
              "A local path blocks this stash. Move it aside before popping.");
      }
      if (!tracked.contains(name) && Files.exists(file, LinkOption.NOFOLLOW_LINKS))
        throw new ConflictException(
            "An untracked or ignored local file would be overwritten. Move it aside before popping.");
    }
  }

  private List<String> changedPaths(Path root, String before, String after) {
    return nulPaths(
        git(
                root,
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "--name-only",
                "-z",
                before,
                after,
                "--")
            .stdout());
  }

  private List<String> nulPaths(String value) {
    return Arrays.stream(value.split("\u0000", -1)).filter(item -> !item.isEmpty()).toList();
  }

  private static String validMessage(String input) {
    if (input != null && (input.length() > 240 || input.chars().anyMatch(Character::isISOControl)))
      throw new IllegalArgumentException(
          "Stash message must be one line of at most 240 characters without control characters.");
    return input == null || input.isBlank() ? "Argus stash" : input.trim();
  }

  private static void validateSelection(GitStashPopRequest request) {
    if (request == null
        || request.id() == null
        || !request.id().matches(OBJECT_ID)
        || request.ref() == null
        || !request.ref().matches(STASH_REF))
      throw new IllegalArgumentException(
          "Select the exact stash ID and reference from the stash list.");
  }

  private Path realRoot(Path root) {
    if (root == null) throw new IllegalArgumentException("A connected repository is required.");
    try {
      return root.toRealPath();
    } catch (IOException error) {
      throw new IllegalArgumentException("Repository directory is unavailable.", error);
    }
  }

  private CommandResult git(Path root, String... arguments) {
    return git(root, List.of(arguments));
  }

  private CommandResult git(Path root, List<String> arguments) {
    var args =
        new ArrayList<>(
            List.of(
                "--no-optional-locks",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.hooksPath=/dev/null",
                "-C",
                root.toString()));
    args.addAll(arguments);
    // LocalCommandRunner sanitizes inherited Git overrides for every explicit -C invocation.
    return commands.run("git", args, root, TIMEOUT);
  }

  private String diagnostic(Throwable error) {
    String text =
        DiagnosticRedaction.redact(
            error.getMessage() == null ? "Git operation failed" : error.getMessage());
    return text.length() > 1000 ? text.substring(0, 1000) + "…" : text;
  }
}
