package com.argus.git.service;

import com.argus.common.error.ConflictException;
import com.argus.common.process.CommandFailedException;
import com.argus.common.process.CommandResult;
import com.argus.common.process.CommandRunner;
import com.argus.common.process.OwnedProcess;
import com.argus.git.dto.*;
import com.argus.git.repository.GitRecoveryRepository;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.*;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermission;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/** Changes exactly the inspected file/view; never a branch, commit, or whole worktree. */
@Service
public class GitFileRevertService {
  private static final Duration TIMEOUT = Duration.ofSeconds(30);
  private static final int MAX_TEXT = 2 * 1024 * 1024;
  private static final int MAX_INDEX = 64 * 1024 * 1024;
  private static final int MAX_DELETE = 32 * 1024 * 1024;
  private static final int MAX_BULK_FILES = 25;
  private static final int MAX_BULK_CONTENT = 32 * 1024 * 1024;
  private final CommandRunner commands;
  private final GitRecoveryRepository recovery;
  private final Map<Path, Object> locks = new ConcurrentHashMap<>();
  private final Object admission = new Object();
  private final Set<String> retired = ConcurrentHashMap.newKeySet();
  private final Set<Operation> active = ConcurrentHashMap.newKeySet();
  private com.argus.workspace.service.WorkspaceService workspace;

  public GitFileRevertService(CommandRunner commands, GitRecoveryRepository recovery) {
    this.commands = commands;
    this.recovery = recovery;
  }

  @org.springframework.beans.factory.annotation.Autowired
  public void setWorkspace(com.argus.workspace.service.WorkspaceService workspace) {
    this.workspace = workspace;
  }

  Object lock(Path root) {
    return locks.computeIfAbsent(realRoot(root), ignored -> new Object());
  }

  public GitDiffResponse diff(Path root, String requested, boolean staged) {
    synchronized (lock(root)) {
      Snapshot snapshot = capture(root, requested, staged);
      String diff = patch(snapshot);
      Snapshot verified = capture(root, requested, staged);
      if (!snapshot.revision.equals(verified.revision)) throw stale();
      return new GitDiffResponse(
          diff,
          snapshot.binary ? null : text(snapshot.before),
          snapshot.binary ? null : text(snapshot.after),
          snapshot.binary,
          new GitRevertAvailability(
              snapshot.reason.isEmpty(),
              snapshot.reason,
              snapshot.revision,
              staged ? "HEAD" : "index",
              staged ? "index" : "worktree"),
          snapshot.reason.isEmpty()
              ? GitDiffBlocks.changes(snapshot.revision, diff, snapshot.before, snapshot.after)
              : List.of());
    }
  }

  private String patch(Snapshot snapshot) {
    var args =
        new ArrayList<>(
            List.of(
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--diff-algorithm=myers",
                "--no-indent-heuristic",
                "--inter-hunk-context=0"));
    if (snapshot.staged) args.add("--cached");
    args.addAll(List.of("--", snapshot.file));
    String diff = git(snapshot.root, args).stdout();
    if (diff.isBlank()
        && !snapshot.staged
        && snapshot.index == null
        && Files.isRegularFile(snapshot.path, LinkOption.NOFOLLOW_LINKS)) {
      try {
        diff =
            git(
                    snapshot.root,
                    List.of(
                        "diff",
                        "--no-index",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--no-color",
                        "--",
                        "/dev/null",
                        snapshot.file))
                .stdout();
      } catch (CommandFailedException error) {
        if (error.result().exitCode() == 1) diff = error.result().stdout();
        else throw error;
      }
    }
    return diff;
  }

  public GitRevertResponse revert(Path root, String repositoryId, GitRevertRequest request) {
    if (request == null
        || request.expectedRevision() == null
        || !request.expectedRevision().matches("[a-f0-9]{64}"))
      throw new IllegalArgumentException("A valid viewed diff revision is required");
    if (repositoryId == null || repositoryId.isBlank())
      throw new IllegalArgumentException("A repository identity is required");
    if (request.changeId() != null && !request.changeId().matches("[a-f0-9]{64}"))
      throw new IllegalArgumentException("A valid server-issued change identifier is required");
    var operation = new Operation(repositoryId, Thread.currentThread());
    synchronized (admission) {
      if (retired.contains(repositoryId))
        throw new ConflictException("This repository is being removed");
      if (workspace != null
          && !realRoot(Path.of(workspace.requireRepository(repositoryId).path()))
              .equals(realRoot(root)))
        throw new ConflictException("Repository connection changed; reopen the diff");
      active.add(operation);
    }
    try {
      synchronized (lock(root)) {
        checkCancellation();
        Snapshot snapshot = capture(root, request.file(), request.staged());
        if (!snapshot.revision.equals(request.expectedRevision())) throw stale();
        if (!snapshot.reason.isEmpty())
          throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, snapshot.reason);
        GitDiffChange selectedChange = null;
        byte[] restoration = snapshot.before;
        if (request.changeId() != null) {
          selectedChange =
              GitDiffBlocks.changes(
                      snapshot.revision, patch(snapshot), snapshot.before, snapshot.after)
                  .stream()
                  .filter(change -> change.id().equals(request.changeId()))
                  .findFirst()
                  .orElseThrow(
                      () ->
                          new ConflictException(
                              "This change block is no longer available. Reload the diff; nothing was reverted."));
          restoration = GitDiffBlocks.restore(snapshot.before, snapshot.after, selectedChange);
          if (restoration.length > MAX_TEXT)
            throw new ResponseStatusException(
                HttpStatus.UNPROCESSABLE_ENTITY,
                "Restoring this change would exceed the 2 MiB text-editor limit.");
        }
        Path index = indexPath(snapshot.root),
            indexLock = index.resolveSibling(index.getFileName() + ".lock");
        var owned = new java.util.concurrent.atomic.AtomicBoolean();
        GitRevertResponse committed = null;
        try {
          // Git itself observes this lock, including external git add/restore operations.
          try (FileChannel lockFile =
              FileChannel.open(
                  indexLock, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
            owned.set(true);
            Snapshot locked = capture(root, request.file(), request.staged());
            if (!locked.revision.equals(snapshot.revision)) throw stale();
            byte[] originalIndex = readIndex(index);
            var metadata = new LinkedHashMap<String, Object>();
            metadata.put("repositoryRoot", snapshot.root.toString());
            metadata.put("repositoryId", repositoryId);
            metadata.put("file", snapshot.file);
            metadata.put("staged", snapshot.staged);
            metadata.put("expectedRevision", snapshot.revision);
            metadata.put("headCommit", snapshot.headCommit);
            metadata.put("indexEntry", snapshot.index == null ? "" : snapshot.index.identity());
            metadata.put(
                "workingFileExisted", Files.exists(snapshot.path, LinkOption.NOFOLLOW_LINKS));
            metadata.put("baseline", snapshot.staged ? "HEAD" : "index");
            metadata.put("target", snapshot.staged ? "index" : "worktree");
            if (selectedChange != null) {
              metadata.put("changeId", selectedChange.id());
              metadata.put("change", selectedChange);
              metadata.put("operation", "inline-revert");
            }
            String recoveryId =
                recovery.save(
                    metadata,
                    snapshot.after,
                    snapshot.before,
                    snapshot.staged ? originalIndex : null);
            checkCancellation();
            if (snapshot.staged)
              restoreIndex(
                  snapshot,
                  index,
                  indexLock,
                  lockFile,
                  originalIndex,
                  owned,
                  selectedChange == null ? null : restoration);
            else
              restoreWorktree(snapshot, index, originalIndex, restoration, selectedChange != null);
            // From this point the atomic write committed. A cancelled/failed refresh must not
            // tell the caller that no mutation occurred or invite a destructive retry.
            committed =
                new GitRevertResponse(
                    true,
                    snapshot.file,
                    snapshot.staged,
                    snapshot.staged ? "HEAD" : "index",
                    snapshot.staged ? "index" : "worktree",
                    "",
                    recoveryId,
                    true);
            try {
              Snapshot restored = capture(root, request.file(), request.staged());
              committed =
                  new GitRevertResponse(
                      true,
                      snapshot.file,
                      snapshot.staged,
                      snapshot.staged ? "HEAD" : "index",
                      snapshot.staged ? "index" : "worktree",
                      restored.revision,
                      recoveryId,
                      false);
            } catch (RuntimeException ignored) {
            }
            // The recovery bytes were durably saved before mutation; a receipt update is not
            // required for their recoverability.
            try {
              recovery.markRestored(recoveryId, committed.revision());
            } catch (RuntimeException ignored) {
            }
            return committed;
          }
        } catch (FileAlreadyExistsException error) {
          throw new ConflictException(
              "Git is busy updating its index. Wait and reload the diff before reverting.");
        } catch (IOException error) {
          if (committed != null) return committed;
          throw new IllegalStateException(
              "Could not revert the viewed file; its recovery snapshot was preserved if created",
              error);
        } finally {
          if (owned.get())
            try {
              Files.deleteIfExists(indexLock);
            } catch (IOException ignored) {
            }
        }
      }
    } finally {
      active.remove(operation);
      if (operation.cancelled) Thread.interrupted();
    }
  }

  public GitBulkRevertPreview bulkRevertPreview(Path root, GitBulkRevertRequest request) {
    synchronized (lock(root)) {
      List<GitBulkRevertRequest.File> files = bulkFiles(root, request, false);
      List<Snapshot> snapshots = captureBulk(root, files, false);
      verifyBulk(snapshots);
      var previews = new ArrayList<GitBulkRevertPreview.File>();
      for (Snapshot snapshot : snapshots) {
        String reason = bulkReason(snapshot);
        previews.add(
            new GitBulkRevertPreview.File(
                snapshot.file,
                snapshot.staged,
                reason.isEmpty(),
                reason,
                snapshot.revision,
                snapshot.staged ? "HEAD" : "index",
                snapshot.staged ? "index" : "worktree"));
      }
      String reason =
          previews.stream()
              .filter(file -> !file.allowed())
              .map(file -> file.file() + ": " + file.reason())
              .findFirst()
              .orElse("");
      if (reason.isEmpty() && bulkContentSize(snapshots) > MAX_BULK_CONTENT)
        reason = "Select fewer files; combined recovery content must not exceed 32 MiB.";
      return new GitBulkRevertPreview(
          reason.isEmpty(), reason, List.copyOf(previews), recovery.directory(), MAX_BULK_FILES);
    }
  }

  public GitBulkRevertResponse bulkRevert(
      Path root, String repositoryId, GitBulkRevertRequest request) {
    if (repositoryId == null || repositoryId.isBlank())
      throw new IllegalArgumentException("A repository identity is required");
    List<GitBulkRevertRequest.File> files = bulkFiles(root, request, true);
    var operation = new Operation(repositoryId, Thread.currentThread());
    synchronized (admission) {
      if (retired.contains(repositoryId))
        throw new ConflictException("This repository is being removed");
      if (workspace != null
          && !realRoot(Path.of(workspace.requireRepository(repositoryId).path()))
              .equals(realRoot(root)))
        throw new ConflictException("Repository connection changed; preview the selection again");
      active.add(operation);
    }
    try {
      synchronized (lock(root)) {
        List<Snapshot> snapshots = captureBulk(root, files, true);
        for (Snapshot snapshot : snapshots) {
          String reason = bulkReason(snapshot);
          if (!reason.isEmpty())
            throw new ResponseStatusException(
                HttpStatus.UNPROCESSABLE_ENTITY, snapshot.file + ": " + reason);
        }
        if (bulkContentSize(snapshots) > MAX_BULK_CONTENT)
          throw new ResponseStatusException(
              HttpStatus.UNPROCESSABLE_ENTITY,
              "Select fewer files; combined recovery content must not exceed 32 MiB.");
        Path index = indexPath(snapshots.get(0).root);
        Path indexLock = index.resolveSibling(index.getFileName() + ".lock");
        var owned = new java.util.concurrent.atomic.AtomicBoolean();
        GitBulkRevertResponse applied = null;
        try {
          try (FileChannel lockFile =
              FileChannel.open(
                  indexLock, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
            owned.set(true);
            byte[] originalIndex = readIndex(index);
            verifyBulk(snapshots);
            // Build the new index without touching the live index. Staged selections are committed
            // together only after all selected working files have been processed successfully.
            byte[] nextIndex = prepareBulkIndex(snapshots, index, originalIndex);
            var backups = new ArrayList<GitRecoveryRepository.Backup>();
            for (Snapshot snapshot : snapshots) {
              var metadata = new LinkedHashMap<String, Object>();
              metadata.put("file", snapshot.file);
              metadata.put("staged", snapshot.staged);
              metadata.put("expectedRevision", snapshot.revision);
              metadata.put("headCommit", snapshot.headCommit);
              metadata.put("indexEntry", snapshot.index == null ? "" : snapshot.index.identity());
              metadata.put("indexFlags", snapshot.indexFlags);
              metadata.put("workingMode", snapshot.workMode);
              metadata.put(
                  "workingFileExisted", Files.exists(snapshot.path, LinkOption.NOFOLLOW_LINKS));
              metadata.put("baseline", snapshot.staged ? "HEAD" : "index");
              metadata.put("target", snapshot.staged ? "index" : "worktree");
              backups.add(
                  new GitRecoveryRepository.Backup(metadata, snapshot.after, snapshot.before));
            }
            String recoveryId =
                recovery.saveBatch(
                    Map.of(
                        "repositoryId", repositoryId,
                        "repositoryRoot", snapshots.get(0).root.toString(),
                        "indexPath", index.toString()),
                    backups,
                    originalIndex);
            // Backup preparation can take time. Every item must still match immediately before
            // the first live mutation; one stale item rejects the entire batch.
            verifyBulk(snapshots);
            if (!Arrays.equals(originalIndex, readIndex(index))) throw stale();
            checkCancellation();
            applied =
                applyBulk(
                    snapshots,
                    index,
                    indexLock,
                    lockFile,
                    originalIndex,
                    nextIndex,
                    owned,
                    recoveryId);
          }
          return applied;
        } catch (FileAlreadyExistsException error) {
          throw new ConflictException("Git is busy updating its index. Wait and preview again.");
        } catch (IOException error) {
          // Closing an already committed lock channel must never turn success into a retryable
          // error that claims no writes occurred.
          if (applied != null) return applied;
          throw new IllegalStateException(
              "Could not prepare bulk revert; nothing was reverted. Recovery was retained if created.",
              error);
        } finally {
          if (owned.get())
            try {
              Files.deleteIfExists(indexLock);
            } catch (IOException ignored) {
            }
        }
      }
    } finally {
      active.remove(operation);
      if (operation.cancelled) Thread.interrupted();
    }
  }

  private List<GitBulkRevertRequest.File> bulkFiles(
      Path inputRoot, GitBulkRevertRequest request, boolean applying) {
    if (request == null
        || request.files() == null
        || request.files().isEmpty()
        || request.files().size() > MAX_BULK_FILES)
      throw new IllegalArgumentException("Select between 1 and 25 files to revert");
    Path root = realRoot(inputRoot);
    var seen = new HashSet<Path>();
    var files = new ArrayList<GitBulkRevertRequest.File>();
    for (var file : request.files()) {
      if (file == null || file.staged() == null)
        throw new IllegalArgumentException("Every selected file must specify its staged view");
      if (file.file() != null && Path.of(file.file()).isAbsolute())
        throw new IllegalArgumentException("Bulk revert requires repository-relative file paths");
      Path path = safePath(root, file.file());
      if (!seen.add(path))
        throw new IllegalArgumentException(
            "Select each file only once, in either its staged or working-tree view");
      if (applying
          && (file.expectedRevision() == null || !file.expectedRevision().matches("[a-f0-9]{64}")))
        throw new IllegalArgumentException("Every selected file requires its preview revision");
      files.add(
          new GitBulkRevertRequest.File(
              root.relativize(path).toString(), file.staged(), file.expectedRevision()));
    }
    return List.copyOf(files);
  }

  private List<Snapshot> captureBulk(
      Path root, List<GitBulkRevertRequest.File> files, boolean applying) {
    var snapshots = new ArrayList<Snapshot>();
    for (var file : files) {
      Snapshot snapshot = capture(root, file.file(), file.staged());
      if (applying && !snapshot.revision.equals(file.expectedRevision())) throw stale();
      snapshots.add(snapshot);
    }
    return List.copyOf(snapshots);
  }

  private String bulkReason(Snapshot snapshot) {
    if (!snapshot.reason.isEmpty()) return snapshot.reason;
    return snapshot.head == null
        ? "New files are not deleted or reverted by bulk revert. Use their individual staging controls."
        : "";
  }

  private long bulkContentSize(List<Snapshot> snapshots) {
    return snapshots.stream()
        .mapToLong(snapshot -> (long) snapshot.before.length + snapshot.after.length)
        .sum();
  }

  private void verifyBulk(List<Snapshot> snapshots) {
    for (Snapshot snapshot : snapshots)
      if (!snapshot.revision.equals(
          capture(snapshot.root, snapshot.file, snapshot.staged).revision)) throw stale();
  }

  private byte[] prepareBulkIndex(List<Snapshot> snapshots, Path index, byte[] original)
      throws IOException {
    List<Snapshot> staged = snapshots.stream().filter(snapshot -> snapshot.staged).toList();
    if (staged.isEmpty()) return null;
    Path alternate = Files.createTempFile(index.getParent(), "argus-bulk-revert-index-", ".tmp");
    Path alternateLock = alternate.resolveSibling(alternate.getFileName() + ".lock");
    try {
      Files.write(alternate, original);
      privateFile(alternate);
      var args =
          new ArrayList<>(
              List.of("restore", "--source=" + staged.get(0).headCommit, "--staged", "--"));
      for (Snapshot snapshot : staged) {
        if (!snapshot.headCommit.equals(staged.get(0).headCommit)) throw stale();
        args.add(snapshot.file);
      }
      var builder = builder(staged.get(0).root, args);
      builder.environment().put("GIT_INDEX_FILE", alternate.toString());
      try (var process = new OwnedProcess(builder, null, 16_384)) {
        process.closeInput();
        if (process.await(TIMEOUT).exitCode() != 0)
          throw new IllegalStateException("Could not prepare the selected staged entries");
      }
      return readIndex(alternate);
    } finally {
      Files.deleteIfExists(alternateLock);
      Files.deleteIfExists(alternate);
    }
  }

  private GitBulkRevertResponse applyBulk(
      List<Snapshot> snapshots,
      Path index,
      Path indexLock,
      FileChannel lockFile,
      byte[] originalIndex,
      byte[] nextIndex,
      java.util.concurrent.atomic.AtomicBoolean owned,
      String recoveryId) {
    var results = new ArrayList<GitBulkRevertResponse.Result>();
    for (Snapshot snapshot : snapshots)
      results.add(bulkResult(snapshot, "not-applied", "", recoveryId, "Not applied."));
    int current = -1;
    try {
      for (int item = 0; item < snapshots.size(); item++) {
        Snapshot snapshot = snapshots.get(item);
        if (snapshot.staged) continue;
        current = item;
        restoreWorktree(snapshot, index, originalIndex, snapshot.before, false);
        // Record the successful atomic rename before any fallible refresh or next-file check.
        results.set(
            item,
            bulkResult(snapshot, "reverted", "", recoveryId, "Working file restored from index."));
      }
      if (nextIndex != null) {
        current = -1;
        for (int item = 0; item < snapshots.size(); item++) {
          Snapshot snapshot = snapshots.get(item);
          if (!snapshot.staged) continue;
          current = item;
          if (!snapshot.revision.equals(capture(snapshot.root, snapshot.file, true).revision))
            throw stale();
        }
        checkCancellation();
        if (!Arrays.equals(originalIndex, readIndex(index))) throw stale();
        var buffer = ByteBuffer.wrap(nextIndex);
        while (buffer.hasRemaining()) lockFile.write(buffer);
        lockFile.force(true);
        Files.setPosixFilePermissions(
            indexLock, Files.getPosixFilePermissions(index, LinkOption.NOFOLLOW_LINKS));
        Files.move(
            indexLock, index, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        owned.set(false);
        for (int item = 0; item < snapshots.size(); item++) {
          Snapshot snapshot = snapshots.get(item);
          if (snapshot.staged)
            results.set(
                item,
                bulkResult(
                    snapshot,
                    "reverted",
                    "",
                    recoveryId,
                    "Staged entry restored from HEAD; working file preserved."));
        }
      }
    } catch (RuntimeException | IOException error) {
      if (current >= 0) {
        Snapshot snapshot = snapshots.get(current);
        results.set(
            current,
            bulkResult(
                snapshot,
                "failed",
                "",
                recoveryId,
                "Not applied: a selected file or repository changed, the operation was cancelled, or its write failed."));
      }
      return finishBulk(results, recoveryId, false);
    }
    // Revisions are advisory refresh information. Failure here does not undo the successful result.
    for (int item = 0; item < snapshots.size(); item++) {
      Snapshot snapshot = snapshots.get(item);
      try {
        var result = results.get(item);
        results.set(
            item,
            bulkResult(
                snapshot,
                "reverted",
                capture(snapshot.root, snapshot.file, snapshot.staged).revision,
                recoveryId,
                result.message()));
      } catch (RuntimeException ignored) {
      }
    }
    return finishBulk(results, recoveryId, true);
  }

  private GitBulkRevertResponse.Result bulkResult(
      Snapshot snapshot, String status, String revision, String recoveryId, String message) {
    return new GitBulkRevertResponse.Result(
        snapshot.file, snapshot.staged, status, revision, recoveryId, message);
  }

  private GitBulkRevertResponse finishBulk(
      List<GitBulkRevertResponse.Result> results, String recoveryId, boolean complete) {
    boolean changed = results.stream().anyMatch(result -> result.status().equals("reverted"));
    try {
      recovery.markBatchResult(recoveryId, complete, results);
    } catch (RuntimeException ignored) {
      // The already durable recovery bytes do not depend on this informational receipt update.
    }
    return new GitBulkRevertResponse(
        complete,
        !complete && changed,
        complete
            ? "Selected changes reverted. Recovery copies are available."
            : changed
                ? "Bulk revert stopped after some files were restored. Review each result before retrying; recovery copies are available."
                : "Bulk revert stopped without changing any selected file. Refresh and preview again; recovery copies are available.",
        List.copyOf(results),
        List.of(recovery.location(recoveryId)),
        true);
  }

  public GitFileActionPreview fileActionPreview(Path root, String file, String action) {
    synchronized (lock(root)) {
      if ("delete".equals(action)) {
        DeleteSnapshot saved = captureDeletion(root, file);
        return new GitFileActionPreview(
            saved.file,
            action,
            saved.reason.isEmpty(),
            saved.reason,
            saved.revision,
            saved.index != null,
            saved.existed,
            recovery.directory());
      }
      if (!"revert".equals(action)) throw new IllegalArgumentException("Unknown file action");
      Snapshot working = capture(root, file, false), staged = capture(root, file, true);
      String reason = fullRevertReason(working, staged);
      return new GitFileActionPreview(
          working.file,
          action,
          reason.isEmpty(),
          reason,
          fullRevision(working, staged),
          !Objects.equals(staged.index, staged.head),
          Files.exists(working.path, LinkOption.NOFOLLOW_LINKS),
          recovery.directory());
    }
  }

  public GitFileActionResponse fileAction(
      Path root, String repositoryId, String action, GitFileActionRequest request) {
    if (request == null
        || request.expectedRevision() == null
        || !request.expectedRevision().matches("[a-f0-9]{64}"))
      throw new IllegalArgumentException("A valid inspected file revision is required");
    if (!"delete".equals(action) && !"revert".equals(action))
      throw new IllegalArgumentException("Unknown file action");
    if (repositoryId == null || repositoryId.isBlank())
      throw new IllegalArgumentException("A repository identity is required");
    var operation = new Operation(repositoryId, Thread.currentThread());
    synchronized (admission) {
      if (retired.contains(repositoryId))
        throw new ConflictException("This repository is being removed");
      if (workspace != null
          && !realRoot(Path.of(workspace.requireRepository(repositoryId).path()))
              .equals(realRoot(root)))
        throw new ConflictException("Repository connection changed; inspect the file again");
      active.add(operation);
    }
    try {
      synchronized (lock(root)) {
        checkCancellation();
        return "delete".equals(action)
            ? deleteNewFile(root, repositoryId, request)
            : revertWholeFile(root, repositoryId, request);
      }
    } finally {
      active.remove(operation);
      if (operation.cancelled) Thread.interrupted();
    }
  }

  private String fullRevision(Snapshot working, Snapshot staged) {
    return hash(
        working.revision.getBytes(StandardCharsets.UTF_8),
        staged.revision.getBytes(StandardCharsets.UTF_8));
  }

  private String fullRevertReason(Snapshot working, Snapshot staged) {
    if (staged.head == null)
      return "New files have no committed version. Use Delete to remove this new file.";
    if (!staged.reason.isEmpty() && !staged.reason.equals("This view has no changes to revert."))
      return staged.reason;
    if (working.binary) return working.reason;
    if (Files.isSymbolicLink(working.path)
        || (Files.exists(working.path, LinkOption.NOFOLLOW_LINKS)
            && !Files.isRegularFile(working.path, LinkOption.NOFOLLOW_LINKS)))
      return "Only regular files can be reverted.";
    if (working.reason.equals("This view has no changes to revert.")
        && staged.reason.equals(working.reason)) return working.reason;
    return "";
  }

  private GitFileActionResponse revertWholeFile(
      Path root, String repositoryId, GitFileActionRequest request) {
    Snapshot working = capture(root, request.file(), false),
        staged = capture(root, request.file(), true);
    if (!fullRevision(working, staged).equals(request.expectedRevision())) throw fileActionStale();
    String reason = fullRevertReason(working, staged);
    if (!reason.isEmpty())
      throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, reason);
    boolean existed = Files.exists(working.path, LinkOption.NOFOLLOW_LINKS);
    var receipts = new ArrayList<String>();
    try {
      if (staged.reason.isEmpty())
        receipts.add(
            revert(root, repositoryId, new GitRevertRequest(request.file(), true, staged.revision))
                .recoveryId());
      Snapshot next = capture(root, request.file(), false);
      // The first phase intentionally changes the index, not the working bytes.
      // External edits/checkout between phases must be retained, not reinterpreted.
      if (!Arrays.equals(working.after, next.after)
          || existed != Files.exists(next.path, LinkOption.NOFOLLOW_LINKS)
          || !working.workMode.equals(next.workMode)
          || !staged.headCommit.equals(next.headCommit)
          || !Objects.equals(staged.head, next.index)) throw fileActionStale();
      if (next.reason.isEmpty())
        receipts.add(
            revert(root, repositoryId, new GitRevertRequest(request.file(), false, next.revision))
                .recoveryId());
      else if (!next.reason.equals("This view has no changes to revert."))
        throw new ConflictException(next.reason);
      return actionResponse(
          working.file,
          "revert",
          false,
          "File reverted to HEAD; unrelated files were kept.",
          receipts);
    } catch (RuntimeException error) {
      if (receipts.isEmpty()) throw error;
      return actionResponse(
          working.file,
          "revert",
          true,
          "The staged part was reverted, but the working file was kept because the file or repository changed. Refresh and inspect before deciding again. "
              + error.getMessage(),
          receipts);
    }
  }

  private GitFileActionResponse actionResponse(
      String file, String action, boolean refresh, String message, List<String> ids) {
    return new GitFileActionResponse(
        true,
        file,
        action,
        refresh,
        message,
        List.copyOf(ids),
        ids.stream().map(recovery::location).toList());
  }

  private ConflictException fileActionStale() {
    return new ConflictException(
        "This file or its Git state changed after confirmation. Inspect it again; no new action was applied.");
  }

  private DeleteSnapshot captureDeletion(Path inputRoot, String requested) {
    checkCancellation();
    if (requested == null
        || Path.of(requested).isAbsolute()
        || Arrays.stream(requested.replace('\\', '/').split("/"))
            .anyMatch(part -> part.equals("..") || part.equalsIgnoreCase(".git")))
      throw new IllegalArgumentException("A repository-relative source file is required");
    Path root = realRoot(inputRoot), path = safePath(root, requested);
    String file = root.relativize(path).toString(), head = "";
    try {
      head = git(root, List.of("rev-parse", "--verify", "HEAD^{commit}")).stdout().trim();
    } catch (CommandFailedException ignored) {
    }
    IndexRecord indexRecord = indexRecord(root, file);
    var entries = indexRecord.entries;
    Entry index = entries.stream().filter(entry -> entry.stage == 0).findFirst().orElse(null);
    boolean existed = Files.exists(path, LinkOption.NOFOLLOW_LINKS);
    String reason = "", identity = "missing";
    byte[] working = new byte[0], staged = new byte[0];
    if (!head.isEmpty() && headEntry(root, head, file) != null)
      reason = "Tracked files must be reverted, not deleted with Delete new file.";
    else if (entries.stream().anyMatch(entry -> entry.stage != 0))
      reason = "Resolve the merge conflict before deleting this file.";
    else if (renamed(root, file))
      reason = "A renamed file must be handled with its rename pair; it is not a new file.";
    else if (index != null && !regular(index.mode))
      reason = "Symlinks and submodules cannot be deleted here.";
    else if (existed
        && (Files.isSymbolicLink(path) || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)))
      reason = "Only one regular new file can be deleted; folders and symlinks are excluded.";
    else if (index == null
        && (!existed
            || Arrays.stream(
                    git(
                            root,
                            List.of("ls-files", "--others", "--exclude-standard", "-z", "--", file))
                        .stdout()
                        .split("\0"))
                .noneMatch(file::equals)))
      reason = "This is not an untracked source file. Missing and ignored files are excluded.";
    if (reason.isEmpty()) {
      try {
        if (existed) {
          var before =
              Files.readAttributes(
                  path,
                  java.nio.file.attribute.BasicFileAttributes.class,
                  LinkOption.NOFOLLOW_LINKS);
          if (before.size() > MAX_DELETE)
            throw new UnsupportedText(
                "Files larger than 32 MiB must be removed manually; no deletion was applied.");
          try (var stream = Files.newInputStream(path, LinkOption.NOFOLLOW_LINKS)) {
            working = stream.readNBytes(MAX_DELETE + 1);
          }
          var after =
              Files.readAttributes(
                  path,
                  java.nio.file.attribute.BasicFileAttributes.class,
                  LinkOption.NOFOLLOW_LINKS);
          if (working.length > MAX_DELETE
              || before.size() != after.size()
              || !before.lastModifiedTime().equals(after.lastModifiedTime())
              || !Objects.equals(before.fileKey(), after.fileKey())) throw fileActionStale();
          identity =
              after.fileKey()
                  + "|"
                  + after.lastModifiedTime()
                  + "|"
                  + Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS);
        }
        if (index != null) staged = blob(root, index.oid, MAX_DELETE);
      } catch (UnsupportedText error) {
        reason = error.getMessage();
      } catch (IOException error) {
        throw new IllegalStateException(
            "Could not inspect this new file; nothing was deleted", error);
      }
    }
    String revision =
        hash(
            (root
                    + "\0"
                    + indexLocation(root)
                    + "\0"
                    + file
                    + "\0"
                    + head
                    + "\0"
                    + entries
                    + "\0"
                    + indexRecord.flags
                    + "\0"
                    + identity
                    + "\0"
                    + existed)
                .getBytes(StandardCharsets.UTF_8),
            working,
            staged);
    return new DeleteSnapshot(
        root, path, file, head, index, existed, working, staged, reason, revision, identity);
  }

  private GitFileActionResponse deleteNewFile(
      Path root, String repositoryId, GitFileActionRequest request) {
    DeleteSnapshot saved = captureDeletion(root, request.file());
    if (!saved.revision.equals(request.expectedRevision())) throw fileActionStale();
    if (!saved.reason.isEmpty())
      throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, saved.reason);
    Path index = indexLocation(saved.root),
        lock = index.resolveSibling(index.getFileName() + ".lock");
    Path quarantine = null, heldFile = null;
    String recoveryId = null;
    boolean owned = false, moved = false, committed = false;
    try {
      try (var channel =
          FileChannel.open(lock, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
        owned = true;
        if (!saved.revision.equals(captureDeletion(root, saved.file).revision))
          throw fileActionStale();
        byte[] originalIndex =
            Files.exists(index, LinkOption.NOFOLLOW_LINKS) ? readIndex(index) : null;
        var metadata = new LinkedHashMap<String, Object>();
        metadata.put("repositoryId", repositoryId);
        metadata.put("repositoryRoot", saved.root.toString());
        metadata.put("file", saved.file);
        metadata.put("operation", "delete-new-file");
        metadata.put("workingFileExisted", saved.existed);
        metadata.put("expectedRevision", saved.revision);
        metadata.put("headCommit", saved.headCommit);
        metadata.put("workingFileIdentity", saved.identity);
        metadata.put("indexEntry", saved.index == null ? "" : saved.index.identity());
        recoveryId = recovery.save(metadata, saved.working, saved.staged, originalIndex);
        if (saved.index != null) {
          byte[] next = indexWithout(saved, index, originalIndex);
          var buffer = ByteBuffer.wrap(next);
          while (buffer.hasRemaining()) channel.write(buffer);
          channel.force(true);
          Files.setPosixFilePermissions(
              lock, Files.getPosixFilePermissions(index, LinkOption.NOFOLLOW_LINKS));
        }
        checkCancellation();
        if (!saved.revision.equals(captureDeletion(root, saved.file).revision)
            || !Arrays.equals(
                originalIndex,
                Files.exists(index, LinkOption.NOFOLLOW_LINKS) ? readIndex(index) : null))
          throw fileActionStale();
        if (saved.existed) {
          quarantine = Files.createTempDirectory(saved.path.getParent(), ".argus-delete-");
          Files.setPosixFilePermissions(
              quarantine, java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"));
          heldFile = quarantine.resolve("original");
          Files.move(saved.path, heldFile, StandardCopyOption.ATOMIC_MOVE);
          moved = true;
          // Retain concurrent writes rather than deleting a different inode/content.
          if (Files.isSymbolicLink(heldFile)
              || !Files.isRegularFile(heldFile, LinkOption.NOFOLLOW_LINKS)) throw fileActionStale();
          var held =
              Files.readAttributes(
                  heldFile,
                  java.nio.file.attribute.BasicFileAttributes.class,
                  LinkOption.NOFOLLOW_LINKS);
          String identity =
              held.fileKey()
                  + "|"
                  + held.lastModifiedTime()
                  + "|"
                  + Files.getPosixFilePermissions(heldFile, LinkOption.NOFOLLOW_LINKS);
          byte[] bytes;
          try (var stream = Files.newInputStream(heldFile, LinkOption.NOFOLLOW_LINKS)) {
            bytes = stream.readNBytes(MAX_DELETE + 1);
          }
          if (!saved.identity.equals(identity) || !Arrays.equals(saved.working, bytes))
            throw fileActionStale();
        }
        checkCancellation();
        String currentHead = "";
        try {
          currentHead =
              git(saved.root, List.of("rev-parse", "--verify", "HEAD^{commit}")).stdout().trim();
        } catch (CommandFailedException ignored) {
        }
        if (!saved.headCommit.equals(currentHead)
            || !indexLocation(saved.root).equals(index)
            || !Arrays.equals(
                originalIndex,
                Files.exists(index, LinkOption.NOFOLLOW_LINKS) ? readIndex(index) : null))
          throw fileActionStale();
        if (saved.index != null) {
          Files.move(
              lock, index, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
          owned = false;
        }
        committed = true;
        if (heldFile != null) {
          Files.delete(heldFile);
          moved = false;
        }
        try {
          recovery.markDeleted(recoveryId);
        } catch (RuntimeException ignored) {
        }
        boolean newerFile = Files.exists(saved.path, LinkOption.NOFOLLOW_LINKS);
        return actionResponse(
            saved.file,
            "delete",
            newerFile,
            newerFile
                ? "The confirmed new file was removed, but a newer file appeared at this path and was kept. Refresh to inspect it."
                : "New file deleted from the working tree and removed from staging. A local recovery copy was saved.",
            List.of(recoveryId));
      }
    } catch (IOException | RuntimeException error) {
      if (error instanceof FileAlreadyExistsException && !owned)
        throw new ConflictException("Git is updating its index. Wait and inspect the file again.");
      if (committed)
        return actionResponse(
            saved.file,
            "delete",
            true,
            "The file action completed, but cleanup needs inspection. Recovery copy: "
                + recovery.location(recoveryId),
            List.of(recoveryId));
      if (moved) {
        try {
          Files.createLink(saved.path, heldFile);
          Files.delete(heldFile);
          moved = false;
        } catch (IOException rollback) {
          throw new IllegalStateException(
              "Deletion stopped. The current path was not overwritten; the original is preserved at "
                  + heldFile
                  + ". Recovery: "
                  + recovery.location(recoveryId),
              error);
        }
      }
      if (error instanceof RuntimeException runtime) throw runtime;
      throw new IllegalStateException(
          "Could not delete this file; original contents were kept", error);
    } finally {
      if (owned)
        try {
          Files.deleteIfExists(lock);
        } catch (IOException ignored) {
        }
      if (quarantine != null && !moved)
        try {
          Files.deleteIfExists(quarantine);
        } catch (IOException ignored) {
        }
    }
  }

  private byte[] indexWithout(DeleteSnapshot saved, Path index, byte[] original)
      throws IOException {
    Path alternate = Files.createTempFile(index.getParent(), "argus-delete-index-", ".tmp");
    try {
      Files.write(alternate, original);
      privateFile(alternate);
      var builder =
          builder(saved.root, List.of("update-index", "--force-remove", "--", saved.file));
      builder.environment().put("GIT_INDEX_FILE", alternate.toString());
      try (var process = new OwnedProcess(builder, null, 16_384)) {
        process.closeInput();
        if (process.await(TIMEOUT).exitCode() != 0)
          throw new IllegalStateException("Could not prepare removal of the new index entry");
      }
      return readIndex(alternate);
    } finally {
      Files.deleteIfExists(alternate.resolveSibling(alternate.getFileName() + ".lock"));
      Files.deleteIfExists(alternate);
    }
  }

  public Map<String, Object> purgeRepositories(List<String> ids) {
    disconnectRepositories(ids);
    return Map.of("gitRecoverySnapshotsDeleted", recovery.purgeRepositories(ids));
  }

  /** Stop in-flight writes, keeping the user's recovery snapshots intact. */
  public Map<String, Object> disconnectRepositories(List<String> ids) {
    List<Operation> selected;
    synchronized (admission) {
      retired.addAll(ids);
      selected = active.stream().filter(item -> ids.contains(item.repositoryId)).toList();
      selected.forEach(
          item -> {
            item.cancelled = true;
            item.thread.interrupt();
          });
    }
    long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
    while (selected.stream().anyMatch(active::contains) && System.nanoTime() < deadline)
      try {
        Thread.sleep(10);
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        throw new IllegalStateException("Git recovery drain interrupted", error);
      }
    if (selected.stream().anyMatch(active::contains))
      throw new IllegalStateException(
          "File revert has not stopped; repository recovery was not purged");
    return Map.of("gitOperationsDrained", selected.size());
  }

  public void releaseRetiredRepositories(List<String> ids) {
    synchronized (admission) {
      retired.removeAll(ids);
    }
  }

  private void restoreIndex(
      Snapshot snapshot,
      Path index,
      Path indexLock,
      FileChannel lockFile,
      byte[] original,
      java.util.concurrent.atomic.AtomicBoolean owned,
      byte[] replacement)
      throws IOException {
    Path alternate = Files.createTempFile(index.getParent(), "argus-revert-index-", ".tmp");
    Path alternateLock = alternate.resolveSibling(alternate.getFileName() + ".lock");
    try {
      Files.write(alternate, original);
      privateFile(alternate);
      List<String> update =
          replacement == null
              ? List.of(
                  "restore", "--source=" + snapshot.headCommit, "--staged", "--", snapshot.file)
              : List.of(
                  "update-index",
                  "--add",
                  "--cacheinfo",
                  (snapshot.index == null ? snapshot.head.mode : snapshot.index.mode)
                      + ","
                      + writeBlob(snapshot.root, index.getParent(), replacement)
                      + ","
                      + snapshot.file);
      var builder = builder(snapshot.root, update);
      builder.environment().put("GIT_INDEX_FILE", alternate.toString());
      try (OwnedProcess process = new OwnedProcess(builder, null, 16_384)) {
        process.closeInput();
        CommandResult result = process.await(TIMEOUT);
        if (result.exitCode() != 0)
          throw new IllegalStateException("Git could not restore this index entry");
      }
      if (replacement != null) {
        if (snapshot.indexFlags.equals("h") || snapshot.indexFlags.equals("s"))
          indexFlag(snapshot.root, alternate, "--assume-unchanged", snapshot.file);
        if (snapshot.indexFlags.equals("S") || snapshot.indexFlags.equals("s"))
          indexFlag(snapshot.root, alternate, "--skip-worktree", snapshot.file);
      }
      checkCancellation();
      if (!Arrays.equals(original, readIndex(index))
          || !snapshot.revision.equals(capture(snapshot.root, snapshot.file, true).revision))
        throw stale();
      byte[] next = readIndex(alternate);
      var buffer = ByteBuffer.wrap(next);
      while (buffer.hasRemaining()) lockFile.write(buffer);
      lockFile.force(true);
      if (Files.exists(index, LinkOption.NOFOLLOW_LINKS))
        Files.setPosixFilePermissions(
            indexLock, Files.getPosixFilePermissions(index, LinkOption.NOFOLLOW_LINKS));
      Files.move(
          indexLock, index, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
      owned.set(false); // A subsequent index.lock can belong to another Git process.
    } finally {
      try {
        Files.deleteIfExists(alternateLock);
        Files.deleteIfExists(alternate);
      } catch (IOException ignored) {
      }
    }
  }

  private void restoreWorktree(
      Snapshot snapshot, Path index, byte[] originalIndex, byte[] replacement, boolean inline)
      throws IOException {
    Path temporary = Files.createTempFile(snapshot.path.getParent(), ".argus-revert-", ".tmp");
    try {
      Files.write(temporary, replacement);
      if (inline && Files.isRegularFile(snapshot.path, LinkOption.NOFOLLOW_LINKS))
        Files.setPosixFilePermissions(
            temporary, Files.getPosixFilePermissions(snapshot.path, LinkOption.NOFOLLOW_LINKS));
      else setFileMode(temporary, snapshot.path, snapshot.index.mode);
      try (var channel = FileChannel.open(temporary, StandardOpenOption.WRITE)) {
        channel.force(true);
      }
      checkCancellation();
      if (!Arrays.equals(originalIndex, readIndex(index))
          || !snapshot.revision.equals(capture(snapshot.root, snapshot.file, false).revision))
        throw stale();
      Files.move(
          temporary,
          snapshot.path,
          StandardCopyOption.ATOMIC_MOVE,
          StandardCopyOption.REPLACE_EXISTING);
    } finally {
      try {
        Files.deleteIfExists(temporary);
      } catch (IOException ignored) {
      }
    }
  }

  private String writeBlob(Path root, Path gitDirectory, byte[] bytes) throws IOException {
    Path temporary = Files.createTempFile(gitDirectory, "argus-revert-content-", ".tmp");
    try {
      Files.write(temporary, bytes);
      privateFile(temporary);
      checkCancellation();
      String oid =
          git(root, List.of("hash-object", "-w", "--no-filters", "--", temporary.toString()))
              .stdout()
              .trim();
      if (!oid.matches("[a-f0-9]{40}|[a-f0-9]{64}"))
        throw new IllegalStateException("Git returned an invalid restored blob identifier");
      return oid;
    } finally {
      Files.deleteIfExists(temporary);
    }
  }

  private void indexFlag(Path root, Path index, String flag, String file) throws IOException {
    checkCancellation();
    var builder = builder(root, List.of("update-index", flag, "--", file));
    builder.environment().put("GIT_INDEX_FILE", index.toString());
    try (var process = new OwnedProcess(builder, null, 16_384)) {
      process.closeInput();
      if (process.await(TIMEOUT).exitCode() != 0)
        throw new IllegalStateException("Git could not preserve this index entry's flags");
    }
  }

  private Snapshot capture(Path inputRoot, String requested, boolean staged) {
    checkCancellation();
    Path root = realRoot(inputRoot), path = safePath(root, requested);
    String file = root.relativize(path).toString();
    String head = "";
    try {
      head = git(root, List.of("rev-parse", "--verify", "HEAD^{commit}")).stdout().trim();
    } catch (CommandFailedException ignored) {
    }
    if (!head.isEmpty() && !head.matches("[a-f0-9]{40}|[a-f0-9]{64}"))
      throw new IllegalStateException("Invalid Git HEAD revision");
    IndexRecord indexRecord = indexRecord(root, file);
    List<Entry> indexEntries = indexRecord.entries;
    String indexFlags = indexRecord.flags;
    Entry index = indexEntries.stream().filter(entry -> entry.stage == 0).findFirst().orElse(null);
    Entry committed = head.isEmpty() ? null : headEntry(root, head, file);
    String reason = "";
    if (indexEntries.stream().anyMatch(entry -> entry.stage != 0))
      reason = "Resolve this file's merge conflict before reverting it.";
    else if (renamed(root, file))
      reason =
          "Renamed files must be handled together; file-level revert does not modify rename pairs.";
    else if (staged && committed == null)
      reason =
          "This added file has no HEAD version to restore. Use Git staging controls; the working file will not be deleted.";
    else if (!staged && index == null)
      reason = "Untracked files have no staged baseline and will not be deleted by Revert changes.";
    else if ((index != null && !regular(index.mode))
        || (committed != null && !regular(committed.mode)))
      reason = "Symlinks and submodules cannot be reverted in the text diff editor.";
    if (Files.isSymbolicLink(path)) reason = "Symlinks cannot be reverted in the text diff editor.";
    else if (Files.exists(path, LinkOption.NOFOLLOW_LINKS)
        && !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS))
      reason = "Only regular text files can be reverted in the diff editor.";
    byte[] before = new byte[0], after = new byte[0];
    boolean binary = false;
    String workMode = "missing";
    try {
      Entry baseline = staged ? committed : index;
      if (baseline != null && regular(baseline.mode)) before = blob(root, baseline.oid);
      if (staged) {
        if (index != null && regular(index.mode)) after = blob(root, index.oid);
      } else if (Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
        if (Files.size(path) > MAX_TEXT)
          throw new UnsupportedText(
              "Files larger than 2 MiB cannot be reverted in the diff editor.");
        after = Files.readAllBytes(path);
        workMode = Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS).toString();
      }
      if (!validText(before) || !validText(after)) {
        binary = true;
        reason = "Binary or non-UTF-8 files cannot be reverted in the text diff editor.";
      }
    } catch (UnsupportedText error) {
      reason = error.getMessage();
      binary = true;
    } catch (IOException error) {
      throw new IllegalStateException("Could not read the viewed Git file", error);
    }
    if (reason.isEmpty()
        && Arrays.equals(before, after)
        && (staged
            ? Objects.equals(index, committed)
            : index != null && modeMatches(path, index.mode)))
      reason = "This view has no changes to revert.";
    String revision =
        hash(
            (root
                    + "\0"
                    + indexLocation(root)
                    + "\0"
                    + file
                    + "\0"
                    + staged
                    + "\0"
                    + head
                    + "\0"
                    + indexEntries
                    + "\0"
                    + indexFlags
                    + "\0"
                    + committed
                    + "\0"
                    + workMode
                    + "\0"
                    + Files.exists(path, LinkOption.NOFOLLOW_LINKS)
                    + "\0")
                .getBytes(StandardCharsets.UTF_8),
            before,
            after);
    return new Snapshot(
        root,
        path,
        file,
        staged,
        head,
        index,
        committed,
        before,
        after,
        binary,
        reason,
        revision,
        indexFlags,
        workMode);
  }

  private IndexRecord indexRecord(Path root, String file) {
    var entries = new ArrayList<Entry>();
    String flags = "";
    // One observation contains every conflict stage and the assume-unchanged /
    // skip-worktree flag, avoiding a second Git process in each verified capture.
    for (String item :
        git(root, List.of("ls-files", "--stage", "-v", "-z", "--", file)).stdout().split("\0")) {
      int tab = item.indexOf('\t');
      if (tab < 2 || item.charAt(1) != ' ' || !item.substring(tab + 1).equals(file)) continue;
      if (flags.isEmpty()) flags = item.substring(0, 1);
      String[] fields = item.substring(2, tab).split(" ");
      if (fields.length == 3)
        entries.add(new Entry(fields[0], fields[1], Integer.parseInt(fields[2])));
    }
    return new IndexRecord(List.copyOf(entries), flags);
  }

  private Entry headEntry(Path root, String head, String file) {
    for (String item : git(root, List.of("ls-tree", "-z", head, "--", file)).stdout().split("\0")) {
      int tab = item.indexOf('\t');
      if (tab < 0 || !item.substring(tab + 1).equals(file)) continue;
      String[] fields = item.substring(0, tab).split(" ");
      if (fields.length == 3) return new Entry(fields[0], fields[2], 0);
    }
    return null;
  }

  private boolean renamed(Path root, String file) {
    String[] fields =
        git(
                root,
                List.of(
                    "diff", "--cached", "--name-status", "-z", "--find-renames", "--no-ext-diff"))
            .stdout()
            .split("\0");
    for (int index = 0; index < fields.length; ) {
      String status = fields[index++];
      if (index >= fields.length) break;
      String first = fields[index++];
      if (status.startsWith("R") || status.startsWith("C")) {
        if (index >= fields.length) break;
        String second = fields[index++];
        if (first.equals(file) || second.equals(file)) return true;
      }
    }
    return false;
  }

  private byte[] blob(Path root, String oid) throws IOException {
    return blob(root, oid, MAX_TEXT);
  }

  private byte[] blob(Path root, String oid, int limit) throws IOException {
    if (!oid.matches("[a-f0-9]{40}|[a-f0-9]{64}"))
      throw new IllegalStateException("Invalid Git object identifier");
    long size = Long.parseLong(git(root, List.of("cat-file", "-s", oid)).stdout().trim());
    if (size > limit)
      throw new UnsupportedText(
          "Files larger than " + (limit / 1024 / 1024) + " MiB cannot be handled by this action.");
    Path temporary = Files.createTempFile("argus-git-blob-", ".tmp");
    try {
      var builder = builder(root, List.of("cat-file", "blob", oid));
      builder.redirectOutput(temporary.toFile());
      try (OwnedProcess process = new OwnedProcess(builder, null, 16_384)) {
        process.closeInput();
        if (process.await(TIMEOUT).exitCode() != 0)
          throw new IllegalStateException("Could not read Git blob");
      }
      if (Files.size(temporary) != size || size > limit)
        throw new IllegalStateException("Git blob size changed");
      return Files.readAllBytes(temporary);
    } finally {
      Files.deleteIfExists(temporary);
    }
  }

  private Path indexPath(Path root) {
    try {
      Path index = indexLocation(root);
      if (Files.isSymbolicLink(index) || !Files.isRegularFile(index, LinkOption.NOFOLLOW_LINKS))
        throw new IOException("A regular Git index is required");
      return index;
    } catch (IOException error) {
      throw new IllegalArgumentException("A regular Git index is required", error);
    }
  }

  private Path indexLocation(Path root) {
    try {
      Path index =
          Path.of(
                  git(root, List.of("rev-parse", "--path-format=absolute", "--git-path", "index"))
                      .stdout()
                      .trim())
              .toAbsolutePath()
              .normalize();
      // The index need not exist yet in an unborn repository. Bind its canonical
      // parent and filename so a redirected .git cannot replay another view's token.
      return index.getParent().toRealPath().resolve(index.getFileName());
    } catch (IOException error) {
      throw new IllegalArgumentException("The Git index directory is unavailable", error);
    }
  }

  private byte[] readIndex(Path file) throws IOException {
    if (Files.isSymbolicLink(file)
        || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)
        || Files.size(file) > MAX_INDEX) throw new IOException("Unsupported Git index");
    return Files.readAllBytes(file);
  }

  private CommandResult git(Path root, List<String> args) {
    var command = arguments(root, args);
    return commands.run("git", command, null, TIMEOUT);
  }

  private ProcessBuilder builder(Path root, List<String> args) {
    var command = new ArrayList<>(List.of("git"));
    command.addAll(arguments(root, args));
    var builder = new ProcessBuilder(command);
    com.argus.common.process.GitEnvironment.sanitize(builder.environment());
    return builder;
  }

  private List<String> arguments(Path root, List<String> args) {
    var values =
        new ArrayList<>(
            List.of(
                "--no-optional-locks",
                "--literal-pathspecs",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.hooksPath=/dev/null",
                "-C",
                root.toString()));
    values.addAll(args);
    return values;
  }

  private Path safePath(Path root, String requested) {
    if (requested == null || requested.isBlank() || requested.indexOf('\0') >= 0)
      throw new IllegalArgumentException("A repository file path is required");
    Path candidate = root.resolve(requested).normalize();
    if (!candidate.startsWith(root) || candidate.equals(root))
      throw new IllegalArgumentException("File must be inside the repository");
    Path current = root;
    for (Path part : root.relativize(candidate)) {
      if (part.toString().equals(".git"))
        throw new IllegalArgumentException("Git metadata cannot be edited");
      current = current.resolve(part);
      if (!current.equals(candidate) && Files.isSymbolicLink(current))
        throw new IllegalArgumentException("Symlink directories cannot be reverted");
    }
    try {
      if (!candidate.getParent().toRealPath().startsWith(root))
        throw new IllegalArgumentException("File must be inside the repository");
    } catch (IOException error) {
      throw new IllegalArgumentException("The file's parent directory is unavailable", error);
    }
    return candidate;
  }

  private Path realRoot(Path root) {
    try {
      return root.toRealPath();
    } catch (IOException error) {
      throw new IllegalArgumentException("Repository directory is unavailable", error);
    }
  }

  private boolean regular(String mode) {
    return mode.equals("100644") || mode.equals("100755");
  }

  private boolean validText(byte[] bytes) {
    for (byte value : bytes) if (value == 0) return false;
    try {
      StandardCharsets.UTF_8
          .newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(bytes));
      return true;
    } catch (CharacterCodingException error) {
      return false;
    }
  }

  private String text(byte[] bytes) {
    return new String(bytes, StandardCharsets.UTF_8);
  }

  private String hash(byte[]... values) {
    try {
      var digest = MessageDigest.getInstance("SHA-256");
      for (byte[] value : values) {
        digest.update(ByteBuffer.allocate(4).putInt(value.length).array());
        digest.update(value);
      }
      return HexFormat.of().formatHex(digest.digest());
    } catch (java.security.NoSuchAlgorithmException error) {
      throw new IllegalStateException(error);
    }
  }

  private boolean modeMatches(Path path, String mode) {
    return Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)
        && Files.isExecutable(path) == mode.equals("100755");
  }

  private void setFileMode(Path file, Path original, String mode) throws IOException {
    var permissions =
        new HashSet<>(
            Files.getPosixFilePermissions(
                Files.isRegularFile(original, LinkOption.NOFOLLOW_LINKS) ? original : file,
                LinkOption.NOFOLLOW_LINKS));
    var reads =
        List.of(
            PosixFilePermission.OWNER_READ,
            PosixFilePermission.GROUP_READ,
            PosixFilePermission.OTHERS_READ);
    var executes =
        List.of(
            PosixFilePermission.OWNER_EXECUTE,
            PosixFilePermission.GROUP_EXECUTE,
            PosixFilePermission.OTHERS_EXECUTE);
    for (int index = 0; index < executes.size(); index++) {
      if (mode.equals("100755") && permissions.contains(reads.get(index)))
        permissions.add(executes.get(index));
      else permissions.remove(executes.get(index));
    }
    Files.setPosixFilePermissions(file, permissions);
  }

  private void privateFile(Path file) throws IOException {
    Files.setPosixFilePermissions(
        file, Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
  }

  private void checkCancellation() {
    if (Thread.currentThread().isInterrupted())
      throw new ConflictException("File revert was cancelled before completion");
  }

  private ConflictException stale() {
    return new ConflictException(
        "This diff changed after it was opened. Reload it before reverting; nothing was reverted.");
  }

  private record Entry(String mode, String oid, int stage) {
    String identity() {
      return mode + " " + oid + " " + stage;
    }
  }

  private record IndexRecord(List<Entry> entries, String flags) {}

  private record Snapshot(
      Path root,
      Path path,
      String file,
      boolean staged,
      String headCommit,
      Entry index,
      Entry head,
      byte[] before,
      byte[] after,
      boolean binary,
      String reason,
      String revision,
      String indexFlags,
      String workMode) {}

  private record DeleteSnapshot(
      Path root,
      Path path,
      String file,
      String headCommit,
      Entry index,
      boolean existed,
      byte[] working,
      byte[] staged,
      String reason,
      String revision,
      String identity) {}

  private static class UnsupportedText extends RuntimeException {
    UnsupportedText(String message) {
      super(message);
    }
  }

  private static class Operation {
    final String repositoryId;
    final Thread thread;
    volatile boolean cancelled;

    Operation(String repositoryId, Thread thread) {
      this.repositoryId = repositoryId;
      this.thread = thread;
    }
  }
}
