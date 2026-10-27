package com.argus.git.service;

import com.argus.common.error.NotFoundException;
import com.argus.common.process.CommandFailedException;
import com.argus.common.process.CommandResult;
import com.argus.common.process.CommandRunner;
import com.argus.git.dto.*;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

@Service
public class GitService {
  private static final Duration NORMAL = Duration.ofSeconds(30);
  private static final Duration NETWORK = Duration.ofMinutes(2);
  private static final Duration RECENT_BRANCHES = Duration.ofSeconds(5);
  private static final int RECENT_BRANCH_LIMIT = 4;
  private static final int RECENT_REFLOG_LIMIT = 256;
  private static final Pattern CHECKOUT_REFLOG =
      Pattern.compile("^checkout: moving from (\\S+) to (\\S+)$");
  private final CommandRunner commands;
  private final GitFileRevertService reverts;

  public GitService(CommandRunner commands) {
    this(commands, null);
  }

  @org.springframework.beans.factory.annotation.Autowired
  public GitService(CommandRunner commands, GitFileRevertService reverts) {
    this.commands = commands;
    this.reverts = reverts;
  }

  private CommandResult git(Path root, List<String> args, Duration timeout) {
    List<String> command = new ArrayList<>(List.of("-C", root.toString()));
    command.addAll(args);
    if (reverts == null) return commands.run("git", command, null, timeout);
    synchronized (reverts.lock(root)) {
      return commands.run("git", command, null, timeout);
    }
  }

  public GitStatusResponse status(Path root) {
    String output =
        git(root, List.of("status", "--porcelain=v1", "--branch", "--untracked-files=all"), NORMAL)
            .stdout();
    String remote = "";
    try {
      remote = git(root, List.of("remote", "get-url", "origin"), NORMAL).stdout().trim();
    } catch (RuntimeException ignored) {
    }
    List<String> lines =
        new ArrayList<>(
            Arrays.stream(output.split("\\R")).filter(line -> !line.isEmpty()).toList());
    String header = !lines.isEmpty() && lines.get(0).startsWith("##") ? lines.remove(0) : "";
    int ahead = matchNumber(header, "ahead (\\d+)");
    int behind = matchNumber(header, "behind (\\d+)");
    return new GitStatusResponse(
        statusBranch(header),
        remote,
        ahead,
        behind,
        lines.stream().map(this::parseStatus).toList(),
        statusDetached(header));
  }

  static boolean statusDetached(String header) {
    String branch = header.replaceFirst("^##\\s*", "");
    return branch.isBlank() || branch.equals("HEAD (no branch)");
  }

  static String statusBranch(String header) {
    // Porcelain's branch header belongs to the same snapshot as the file changes. A second
    // `git branch` process adds latency and can race a checkout between the two commands.
    String branch =
        header
            .replaceFirst("^##\\s*", "")
            .replaceFirst("^(?:No commits yet on|Initial commit on)\\s+", "");
    int upstream = branch.indexOf("...");
    if (upstream >= 0) branch = branch.substring(0, upstream);
    return branch.isBlank() || branch.equals("HEAD (no branch)") ? "detached" : branch;
  }

  public List<GitHistoryItem> history(Path root, int requestedLimit) {
    int limit = Math.min(Math.max(requestedLimit, 1), 250);
    String format = "%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%D%x1e";
    String output;
    try {
      output = git(root, List.of("log", "-" + limit, "--pretty=format:" + format), NORMAL).stdout();
    } catch (RuntimeException error) {
      return List.of();
    }
    return Arrays.stream(output.split("\\x1e"))
        .filter(item -> !item.isBlank())
        .map(
            item -> {
              String[] values = item.trim().split("\\x1f", -1);
              return new GitHistoryItem(
                  at(values, 0),
                  at(values, 1),
                  at(values, 2),
                  at(values, 3),
                  at(values, 4),
                  at(values, 5));
            })
        .toList();
  }

  public List<GitBranch> branches(Path root) {
    String output =
        git(
                root,
                List.of(
                    "branch",
                    "--all",
                    "--format=%(refname)|%(refname:short)|%(HEAD)|%(upstream:short)"),
                NORMAL)
            .stdout();
    return Arrays.stream(output.split("\\R"))
        .filter(line -> !line.isBlank())
        .map(
            line -> {
              String[] values = line.split("\\|", -1);
              String ref = at(values, 0);
              String name = at(values, 1);
              return new GitBranch(
                  name,
                  ref,
                  ref.startsWith("refs/heads/") ? "local" : "remote",
                  "*".equals(at(values, 2)),
                  at(values, 3),
                  !ref.endsWith("/HEAD"));
            })
        .toList();
  }

  public List<GitBranch> recentBranches(Path root) {
    // Keep this optional lookup out of status/branch polling. Local refs validate historical names:
    // a deleted branch, detached commit, remote ref or symbolic alias must never become a shortcut.
    String refs =
        git(
                root,
                List.of(
                    "for-each-ref",
                    "--format=%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(symref)",
                    "refs/heads/"),
                RECENT_BRANCHES)
            .stdout();
    Map<String, GitBranch> local = new LinkedHashMap<>();
    for (String line : refs.split("\\R")) {
      String[] values = line.split("\\x00", -1);
      String ref = at(values, 0);
      if (values.length != 5
          || !ref.startsWith("refs/heads/")
          || at(values, 1).isBlank()
          || "*".equals(at(values, 2))
          || !at(values, 4).isBlank()) continue;
      local.put(
          ref.substring("refs/heads/".length()),
          new GitBranch(at(values, 1), ref, "local", false, at(values, 3), true));
    }
    if (local.isEmpty()) return List.of();
    String reflog;
    try {
      reflog =
          git(
                  root,
                  List.of(
                      "reflog",
                      "show",
                      "--max-count=" + RECENT_REFLOG_LIMIT,
                      "--format=%gs",
                      "HEAD",
                      "--"),
                  RECENT_BRANCHES)
              .stdout();
    } catch (CommandFailedException unavailable) {
      // HEAD's reflog is optional (unborn, expired, missing or disabled). Ref enumeration above
      // still surfaces actual repository/access errors; process timeouts are not hidden here.
      return List.of();
    }
    Map<String, GitBranch> recent = new LinkedHashMap<>();
    for (String line : reflog.split("\\R")) {
      Matcher checkout = CHECKOUT_REFLOG.matcher(line);
      if (!checkout.matches()) continue;
      // The source is also recent: the very first switch away from main should offer main back.
      for (String name : List.of(checkout.group(2), checkout.group(1))) {
        GitBranch branch = local.get(name);
        if (branch != null) recent.putIfAbsent(branch.ref(), branch);
        if (recent.size() == RECENT_BRANCH_LIMIT) return List.copyOf(recent.values());
      }
    }
    return List.copyOf(recent.values());
  }

  public GitDiffResponse diff(Path root, String file, boolean staged) {
    if (reverts != null) return reverts.diff(root, file, staged);
    String relative = safeRelative(root, file);
    List<String> args = new ArrayList<>(List.of("diff", "--no-ext-diff", "--no-color"));
    if (staged) args.add("--cached");
    args.addAll(List.of("--", relative));
    String diff = git(root, args, NORMAL).stdout();
    String before = revision(root, relative, staged ? "HEAD" : "INDEX");
    String after = staged ? revision(root, relative, "INDEX") : read(root, relative);
    if (diff.isBlank()
        && !staged
        && status(root).files().stream()
            .anyMatch(item -> item.file().equals(relative) && item.untracked())) {
      try {
        diff =
            git(root, List.of("diff", "--no-index", "--no-color", "/dev/null", relative), NORMAL)
                .stdout();
      } catch (CommandFailedException error) {
        if (error.result().exitCode() == 1) diff = error.result().stdout();
        else throw error;
      }
    }
    boolean binary = before.indexOf('\0') >= 0 || after.indexOf('\0') >= 0;
    return new GitDiffResponse(diff, binary ? null : before, binary ? null : after, binary);
  }

  public GitRevertResponse revert(Path root, String repositoryId, GitRevertRequest request) {
    if (reverts == null) throw new IllegalStateException("File revert service is unavailable");
    return reverts.revert(root, repositoryId, request);
  }

  public GitBulkRevertPreview bulkRevertPreview(Path root, GitBulkRevertRequest request) {
    if (reverts == null) throw new IllegalStateException("File revert service is unavailable");
    return reverts.bulkRevertPreview(root, request);
  }

  public GitBulkRevertResponse bulkRevert(
      Path root, String repositoryId, GitBulkRevertRequest request) {
    if (reverts == null) throw new IllegalStateException("File revert service is unavailable");
    return reverts.bulkRevert(root, repositoryId, request);
  }

  public GitFileActionPreview fileActionPreview(Path root, String file, String action) {
    if (reverts == null) throw new IllegalStateException("Safe file actions are unavailable");
    return reverts.fileActionPreview(root, file, action);
  }

  public GitFileActionResponse fileAction(
      Path root, String repositoryId, String action, GitFileActionRequest request) {
    if (reverts == null) throw new IllegalStateException("Safe file actions are unavailable");
    return reverts.fileAction(root, repositoryId, action, request);
  }

  public CommandResult stage(Path root, List<String> files) {
    return fileAction(root, "add", files, false);
  }

  public CommandResult unstage(Path root, List<String> files) {
    return fileAction(root, "restore", files, true);
  }

  public CommandResult discard(Path root, List<String> files) {
    List<String> args = new ArrayList<>(List.of("restore", "--worktree", "--"));
    args.addAll(normalizeFiles(root, files));
    return git(root, args, NORMAL);
  }

  public CommandResult commit(Path root, String message) {
    if (message == null || message.isBlank())
      throw new IllegalArgumentException("Commit message is required");
    return git(root, List.of("commit", "-m", message.trim()), NETWORK);
  }

  public CommandResult fetch(Path root) {
    return git(root, List.of("fetch", "--prune"), NETWORK);
  }

  public CommandResult pull(Path root) {
    return git(root, List.of("pull", "--ff-only"), NETWORK);
  }

  public GitActionResponse push(Path root) {
    GitStatusResponse status = status(root);
    boolean upstream = true;
    try {
      git(root, List.of("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"), NORMAL);
    } catch (RuntimeException ignored) {
      upstream = false;
    }
    CommandResult result =
        upstream
            ? git(root, List.of("push"), NETWORK)
            : git(root, List.of("push", "--set-upstream", "origin", status.branch()), NETWORK);
    return new GitActionResponse(
        true,
        result.stdout(),
        result.stderr(),
        bitbucketPullRequestUrl(status.remote(), status.branch()));
  }

  public CommandResult switchBranch(Path root, String name) {
    GitBranch target =
        branches(root).stream()
            .filter(item -> item.selectable() && item.name().equals(name))
            .findFirst()
            .orElseThrow(() -> new NotFoundException("Branch not found"));
    if (target.current()) return new CommandResult("Already on " + target.name(), "", 0);
    if (target.type().equals("local")) return git(root, List.of("switch", target.name()), NETWORK);
    String local =
        String.join(
            "/",
            Arrays.asList(target.name().split("/")).subList(1, target.name().split("/").length));
    boolean exists =
        branches(root).stream()
            .anyMatch(item -> item.type().equals("local") && item.name().equals(local));
    return exists
        ? git(root, List.of("switch", local), NETWORK)
        : git(root, List.of("switch", "--track", target.name()), NETWORK);
  }

  public CommandResult createBranch(Path root, String name, String startPoint) {
    if (name == null || name.isBlank() || name.startsWith("-"))
      throw new IllegalArgumentException("Enter a valid new branch name");
    git(root, List.of("check-ref-format", "--branch", name.trim()), NORMAL);
    GitBranch base =
        branches(root).stream()
            .filter(item -> item.selectable() && item.name().equals(startPoint))
            .findFirst()
            .orElseThrow(() -> new NotFoundException("Choose the branch to create from"));
    return git(root, List.of("switch", "-c", name.trim(), base.name()), NETWORK);
  }

  public static String bitbucketPullRequestUrl(String remote, String branch) {
    if (remote == null || branch == null || branch.isBlank()) return "";
    Matcher matcher =
        Pattern.compile(
                "(?:git@bitbucket\\.org:|https?://bitbucket\\.org/)([^/]+/[^/]+?)(?:\\.git)?$")
            .matcher(remote.trim().replaceAll("/+$", ""));
    return matcher.find()
        ? "https://bitbucket.org/"
            + matcher.group(1)
            + "/pull-requests/new?source="
            + java.net.URLEncoder.encode(branch, StandardCharsets.UTF_8)
        : "";
  }

  private CommandResult fileAction(Path root, String action, List<String> files, boolean staged) {
    List<String> args = new ArrayList<>(List.of(action));
    if (staged) args.add("--staged");
    args.add("--");
    args.addAll(normalizeFiles(root, files));
    return git(root, args, NORMAL);
  }

  private List<String> normalizeFiles(Path root, List<String> files) {
    return (files == null ? List.<String>of() : files)
        .stream().map(file -> safeRelative(root, file)).toList();
  }

  private String revision(Path root, String file, String revision) {
    try {
      return git(
              root,
              List.of("show", revision.equals("INDEX") ? ":" + file : revision + ":" + file),
              NORMAL)
          .stdout();
    } catch (RuntimeException error) {
      return "";
    }
  }

  private String read(Path root, String relative) {
    try {
      return Files.readString(root.resolve(relative));
    } catch (IOException error) {
      return "";
    }
  }

  private String safeRelative(Path root, String file) {
    if (file == null || file.indexOf('\0') >= 0)
      throw new IllegalArgumentException("A file path is required");
    Path resolved = root.resolve(file).normalize();
    if (!resolved.startsWith(root.normalize()))
      throw new IllegalArgumentException("File must be inside the repository");
    return root.normalize().relativize(resolved).toString();
  }

  private GitFileStatus parseStatus(String line) {
    String code = line.substring(0, 2);
    String file = line.substring(3);
    if (file.contains(" -> ")) file = file.substring(file.indexOf(" -> ") + 4);
    boolean untracked = code.equals("??");
    String status =
        untracked
            ? "untracked"
            : code.contains("D")
                ? "deleted"
                : code.contains("A") ? "added" : code.contains("R") ? "renamed" : "modified";
    return new GitFileStatus(
        file,
        code.substring(0, 1),
        code.substring(1),
        !untracked && code.charAt(0) != ' ',
        untracked || code.charAt(1) != ' ',
        untracked,
        status);
  }

  private static int matchNumber(String text, String pattern) {
    Matcher matcher = Pattern.compile(pattern).matcher(text);
    return matcher.find() ? Integer.parseInt(matcher.group(1)) : 0;
  }

  private static String at(String[] values, int index) {
    return index < values.length ? values[index] : "";
  }
}
