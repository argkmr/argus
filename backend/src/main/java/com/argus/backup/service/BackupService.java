package com.argus.backup.service;

import com.argus.common.security.KeychainSecretStore;
import com.argus.common.storage.AtomicJsonStore;
import java.io.IOException;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

/**
 * Native backup coordinator. Remote actions are entered only through confirmed controller calls.
 */
@Service
public class BackupService {
  static final Set<String> EXCLUDED =
      Set.of(
          "ide", // Regenerable language-server indexes, not editor drafts or user settings.
          "blob_storage",
          "Cache",
          "Code Cache",
          "Cookies",
          "Cookies-journal",
          "DIPS",
          "DIPS-wal",
          "DawnCache",
          "DawnGraphiteCache",
          "DawnWebGPUCache",
          "DevToolsActivePort",
          "GPUCache",
          "Local Storage",
          "Network Persistent State",
          "Preferences",
          "Session Storage",
          "Shared Dictionary",
          "SharedStorage",
          "SingletonCookie",
          "SingletonLock",
          "SingletonSocket",
          "spring-backend.pid.json",
          "TransportSecurity",
          "Trust Tokens",
          "Trust Tokens-journal",
          "WebStorage",
          "api-collections");
  private static final Set<String> SOURCE_IGNORED =
      Set.of(
          ".ds_store",
          ".git",
          ".gradle",
          ".next",
          ".argus-data",
          "build",
          "dist",
          "node_modules",
          "out",
          "target");
  private static final Set<String> SOURCE_ENTRIES =
      Set.of(
          ".gitignore",
          ".gitattributes",
          "README.md",
          "LICENSE",
          "LICENSE.md",
          "package.json",
          "package-lock.json",
          "backend",
          "chrome-extension",
          "desktop",
          "docs",
          "frontend",
          "public",
          "scripts",
          "test");
  private static final Set<String> SOURCE_CREDENTIAL_NAMES =
      Set.of(
          ".aws",
          ".ssh",
          ".gnupg",
          ".codex",
          ".claude",
          ".config",
          ".git-credentials",
          "git-recovery",
          ".npmrc",
          ".pypirc",
          ".netrc",
          "kubeconfig",
          "id_rsa",
          "id_ed25519",
          "backup-owner.json",
          "argus owner",
          "argus owner signing");
  private static final String SOURCE_MANIFEST = ".argus-code-manifest.json";
  private final BackupPaths paths;
  private final BackupGit git;
  private final KeychainSecretStore secrets;
  private final AtomicJsonStore store;
  private final ObjectMapper json;
  private final BackupOwnerAccess owner;
  private final AtomicBoolean operation = new AtomicBoolean();

  public BackupService(
      BackupPaths paths,
      BackupGit git,
      KeychainSecretStore secrets,
      AtomicJsonStore store,
      ObjectMapper json,
      BackupOwnerAccess owner) {
    this.paths = paths;
    this.git = git;
    this.secrets = secrets;
    this.store = store;
    this.json = json;
    this.owner = owner;
  }

  public boolean active() {
    return operation.get();
  }

  public void invalidateLocalSnapshot() {
    owner.requireAllowed();
    try {
      BackupFiles.safeAncestors(paths.encrypted);
      BackupFiles.safeAncestors(paths.manifest);
      Files.deleteIfExists(paths.encrypted);
      Files.deleteIfExists(paths.manifest);
    } catch (IOException error) {
      throw new IllegalStateException("Could not invalidate the prior local backup", error);
    }
  }

  public void removeDriveSnapshot(String drive) {
    owner.requireAllowed();
    if (drive == null || drive.isBlank()) return;
    Path destination = paths.driveRoot(drive);
    owner.requireSafeStorageRoot(destination);
    for (Path root :
        List.of(paths.data, paths.maintenance, paths.collections, paths.project, paths.source))
      if (destination.startsWith(root) || root.startsWith(destination))
        throw new IllegalArgumentException(
            "Google Drive backup destination overlaps an Argus data or source root");
    try {
      BackupFiles.deleteTree(destination);
    } catch (IOException error) {
      throw new IllegalStateException("Could not remove the prior Google Drive backup", error);
    }
  }

  public boolean verifyPushAccess(String remote) {
    owner.requireAllowed();
    if (remote == null || remote.isBlank()) return false;
    if (!operation.compareAndSet(false, true)) return false;
    try {
      paths.requireDedicatedProject();
      validateRemote(remote);
      ensureWorkingCopy(remote);
      requireConfirmedRemote(remote);
      String revision = quiet(List.of("rev-parse", "--verify", "HEAD")).trim();
      if (revision.isBlank()) {
        // An empty remote has no HEAD to dry-run. Create an unreferenced empty commit
        // locally, never a branch or remote write, solely for receive-pack authorization.
        String tree = command(List.of("mktree")).trim();
        revision =
            command(
                    List.of(
                        "-c",
                        "user.name=Argus Backup",
                        "-c",
                        "user.email=argus-backup@localhost",
                        "commit-tree",
                        tree,
                        "-m",
                        "Argus backup access verification"))
                .trim();
      }
      git.run(
          paths.project,
          List.of("push", "--dry-run", "--force", "origin", revision + ":refs/heads/main"),
          Duration.ofSeconds(30));
      return true;
    } catch (RuntimeException ignored) {
      return false;
    } finally {
      operation.set(false);
    }
  }

  public Map<String, Object> status(Map<String, Object> configuration) {
    owner.requireAllowed();
    var result = new LinkedHashMap<String, Object>();
    result.put("repositoryUrl", configuration.getOrDefault("repositoryUrl", ""));
    result.put("driveDirectory", configuration.getOrDefault("driveDirectory", ""));
    result.put("branch", quiet(List.of("branch", "--show-current")).trim());
    result.put("localDirectory", paths.project.toString());
    result.put("encryptedPath", paths.encrypted.toString());
    result.put(
        "changedFiles",
        quiet(List.of("status", "--short")).lines().filter(line -> !line.isBlank()).toList());
    result.put("diffSummary", quiet(List.of("diff", "--stat", "HEAD")).trim());
    result.put("lastBackup", readMap(paths.manifest));
    result.put("backupExists", Files.isRegularFile(paths.encrypted, LinkOption.NOFOLLOW_LINKS));
    result.put("sourceRoot", paths.source.toString());
    result.put("sourceFileCount", sourceFiles().size());
    result.put("syncing", active());
    return result;
  }

  public Map<String, Object> plan(String remote, String drive) {
    owner.requireAllowed();
    paths.requireDedicatedProject();
    validateRemote(remote);
    validateDriveDestination(drive);
    var result = new LinkedHashMap<String, Object>();
    result.put("repositoryUrl", remote);
    result.put("driveDirectory", drive);
    result.put("driveDestination", paths.driveRoot(drive).toString());
    result.put("branch", "main");
    result.put("retention", "latest snapshot only");
    result.put("sourceRoot", paths.source.toString());
    result.put("sourceFileCount", sourceFiles().size());
    result.put("privateDataEntries", localDataEntries(paths.data));

    result.put(
        "gitIncludes",
        List.of(
            "single latest readable Argus source snapshot",
            "latest encrypted complete Argus-managed data archive",
            "latest non-secret backup manifest"));
    result.put(
        "driveIncludes",
        List.of(
            "single exact mirror of the latest Git remote payload",
            "latest encrypted complete Argus-managed data archive",
            "latest non-secret backup manifest"));
    result.put(
        "excludes",
        List.of(
            "Registered CLI authentication owned by each executable",
            "macOS Keychain master material",
            "Electron browser caches and transient runtime files",
            "connected source repositories other than Argus itself"));
    return result;
  }

  public Map<String, Object> sync(
      String remote,
      String drive,
      String passphrase,
      List<Map<String, Object>> configurations,
      Consumer<Map<String, Object>> progress) {
    owner.requireAllowed();
    if (!operation.compareAndSet(false, true))
      throw new IllegalStateException("Another backup operation is already running");
    try {
      if (remote == null || remote.isBlank() || drive == null || drive.isBlank())
        throw new IllegalArgumentException(
            "Both a verified Git remote repository and Google Drive folder are required for a complete Argus backup");
      paths.requireDedicatedProject();
      validateRemote(remote);
      validateDriveDestination(drive);
      sourceFiles(); // Fail before remote publication or replacement if the source bundle is
      // absent.
      progress.accept(progress(0, "Preparing backup working copy"));
      ensureWorkingCopy(remote);
      if (!command(List.of("branch", "--show-current")).trim().equals("main"))
        throw new IllegalArgumentException("Argus backups only save from the main branch");
      requireConfirmedRemote(remote);
      progress.accept(progress(1, "Encrypting private Argus data"));
      var manifest = createArchive(passphrase, configurations);
      progress.accept(progress(2, "Preparing readable Argus source"));
      var files = syncCodebase();
      progress.accept(progress(3, "Updating Git remote main"));
      owner.requireAllowed();
      var changed = replaceMain(remote);
      progress.accept(progress(4, "Mirroring to Google Drive"));
      owner.requireAllowed();
      var mirrored = mirror(drive, files);
      var result = new LinkedHashMap<String, Object>();
      result.put("ok", true);
      result.put("localSaved", true);
      result.put("committed", true);
      result.put("changedFiles", changed);
      result.put("manifest", manifest);
      result.put("drive", mirrored);
      result.put(
          "destinations",
          Map.of(
              "bitbucket",
              Map.of(
                  "saved",
                  true,
                  "repositoryUrl",
                  remote,
                  "branch",
                  "main",
                  "committed",
                  true,
                  "changedFiles",
                  changed,
                  "sourceFiles",
                  files.size(),
                  "privateArchive",
                  ".argus-backup/argus-backup.enc",
                  "manifest",
                  ".argus-backup/manifest.json",
                  "retention",
                  "single-latest-commit"),
              "drive",
              Map.of(
                  "saved",
                  true,
                  "path",
                  mirrored.get("path"),
                  "mode",
                  mirrored.get("mode"),
                  "sourceFiles",
                  files.size(),
                  "privateArchive",
                  ".argus-backup/argus-backup.enc",
                  "manifest",
                  ".argus-backup/manifest.json")));
      result.put("codebase", Map.of("copied", true, "fileCount", files.size()));
      result.put("pushed", true);
      result.put("completedAt", Instant.now().toString());
      progress.accept(progress(5, "Backup complete"));
      return result;
    } finally {
      operation.set(false);
    }
  }

  public Map<String, Object> createArchive(
      String passphrase, List<Map<String, Object>> configurations) {
    owner.requireAllowed();
    if (passphrase == null || passphrase.length() < 12)
      throw new IllegalArgumentException("Use a recovery passphrase with at least 12 characters");
    Path temporary = temporary("archive");
    try {
      Path staged = temporary.resolve("payload"), data = staged.resolve("argus-data");
      BackupFiles.privateDirectory(data);
      var entries = localDataEntries(paths.data);
      for (String name : entries)
        BackupFiles.copyTree(paths.data.resolve(name), data.resolve(name));
      var environments = resolveEnvironments(configurations);
      store.write(staged.resolve("keychain-environments.json"), environments);
      if (Files.exists(paths.collections, LinkOption.NOFOLLOW_LINKS))
        BackupFiles.copyTree(paths.collections, staged.resolve(paths.collections.getFileName()));
      Path archive = temporary.resolve("argus-data.tar.gz");
      BackupArchive.create(staged, archive);
      String hash = sha256(archive);
      // Re-encrypt even unchanged data: the user may have changed their recovery passphrase.
      BackupCrypto.encrypt(archive, paths.encrypted, passphrase);
      var manifest = new LinkedHashMap<String, Object>();
      manifest.put("format", 3);
      manifest.put("encrypted", true);
      manifest.put("algorithm", "AES-256-GCM + scrypt");
      manifest.put("createdAt", Instant.now().toString());
      manifest.put("contentHash", hash);
      manifest.put("sizeBytes", Files.size(paths.encrypted));
      manifest.put(
          "includes",
          List.of(
              "all Argus-managed local application data",
              "workspace metadata",
              "AI tasks and conversations",
              "context attachments",
              "local environments",
              "repository AI kits",
              "API collections",
              "selected Keychain environment bundles"));
      manifest.put("dataEntries", entries);
      manifest.put(
          "inventory",
          Map.of(
              "localData",
              inventory(data),
              "apiCollections",
              inventory(paths.collections),
              "keychainEnvironmentBundles",
              environments.size()));
      manifest.put(
          "excluded",
          List.of(
              "Registered AI CLI authentication",
              "macOS Keychain master material and the backup passphrase",
              "Electron browser caches and transient runtime files",
              "connected repositories other than the readable Argus source bundle"));
      store.write(paths.manifest, manifest);
      return manifest;
    } catch (IOException error) {
      throw new IllegalStateException("Could not prepare private backup data", error);
    } finally {
      cleanup(temporary);
    }
  }

  public Map<String, Object> restore(String passphrase, String drive, String remote) {
    owner.requireAllowed();
    if (!operation.compareAndSet(false, true))
      throw new IllegalStateException("Another backup operation is already running");
    Path temporary = null;
    try {
      temporary = temporary("restore");
      Path source = paths.encrypted;
      if (remote != null && !remote.isBlank()) {
        paths.requireDedicatedProject();
        validateRemote(remote);
        // Latest-only backups deliberately replace main history. A fast-forward pull
        // cannot restore another machine's snapshot and must not discard local recovery.
        Path checkout = temporary.resolve("remote-snapshot");
        git.run(
            null,
            List.of(
                "clone", "--branch", "main", "--single-branch", "--", remote, checkout.toString()),
            Duration.ofMinutes(5));
        source = checkout.resolve(".argus-backup/argus-backup.enc");
      }
      if (!Files.isRegularFile(source, LinkOption.NOFOLLOW_LINKS)
          && drive != null
          && !drive.isBlank()) source = paths.driveRoot(drive).resolve("argus-backup.enc");
      if (!Files.isRegularFile(source, LinkOption.NOFOLLOW_LINKS))
        throw new IllegalArgumentException(
            "No Argus backup was found in Git remote or the selected Drive folder");
      Path archive = temporary.resolve("argus-data.tar.gz"),
          extracted = temporary.resolve("extracted");
      BackupCrypto.decrypt(source, archive, passphrase);
      BackupArchive.extract(archive, extracted);
      Path data = extracted.resolve("argus-data");
      if (!Files.isDirectory(data, LinkOption.NOFOLLOW_LINKS))
        data = extracted.resolve(paths.data.getFileName());
      if (!Files.isDirectory(data, LinkOption.NOFOLLOW_LINKS))
        throw new IllegalArgumentException("The backup does not contain Argus local data");
      Path collections = extracted.resolve(paths.collections.getFileName());
      Map<String, Object> environments = readMap(extracted.resolve("keychain-environments.json"));
      validateEnvironments(environments);
      return applyRestore(data, collections, environments, passphrase);
    } finally {
      if (temporary != null) cleanup(temporary);
      operation.set(false);
    }
  }

  private Map<String, Object> applyRestore(
      Path data, Path collections, Map<String, Object> environments, String passphrase) {
    Recovery recovery =
        prepareRecovery(passphrase, environments == null ? Set.of() : environments.keySet());
    boolean filesAttempted = false, collectionsAttempted = false, keychainAttempted = false;
    try {
      journal(recovery, "applying", Map.of());
      filesAttempted = true;
      replaceLocal(data);
      if (Files.exists(collections, LinkOption.NOFOLLOW_LINKS)) {
        collectionsAttempted = true;
        BackupFiles.deleteTree(paths.collections);
        BackupFiles.copyTree(collections, paths.collections);
      }
      if (environments != null) {
        keychainAttempted = true;
        restoreEnvironments(environments);
      }
      journal(recovery, "completed", Map.of());
      String warning = "";
      try {
        BackupFiles.deleteTree(recovery.plaintext);
      } catch (IOException error) {
        warning =
            "Restore completed; private plaintext recovery copies remain at " + recovery.directory;
      }
      return Map.of(
          "ok",
          true,
          "restoredAt",
          Instant.now().toString(),
          "restartRequired",
          true,
          "recoveryPath",
          recovery.encrypted.toString(),
          "recoveryCleanupWarning",
          warning,
          "keychainAtomic",
          false);
    } catch (Exception failure) {
      var rollbackErrors = new ArrayList<String>();
      if (filesAttempted) rollback(rollbackErrors, "Local data", () -> replaceLocal(recovery.data));
      if (collectionsAttempted)
        rollback(
            rollbackErrors,
            "API collections",
            () -> {
              BackupFiles.deleteTree(paths.collections);
              if (recovery.collectionsExisted)
                BackupFiles.copyTree(recovery.collections, paths.collections);
            });
      if (keychainAttempted)
        rollback(
            rollbackErrors,
            "Keychain environments",
            () -> restoreEnvironments(recovery.environments));
      boolean partial = keychainAttempted || !rollbackErrors.isEmpty();
      try {
        journal(
            recovery,
            partial ? "recovery-required" : "rolled-back",
            Map.of("rollbackErrors", rollbackErrors, "keychainAtomic", false));
      } catch (RuntimeException ignored) {
      }
      throw new RestoreFailure(
          "Restore failed. "
              + (partial
                  ? "Recovery may be incomplete; verify local data and Keychain before use."
                  : "Previous local data was restored.")
              + " Restart Argus before continuing. Pre-restore recovery is retained at "
              + recovery.directory,
          recovery.directory,
          partial,
          rollbackErrors,
          failure);
    }
  }

  private Recovery prepareRecovery(String passphrase, Set<String> environmentIds) {
    try {
      Path
          directory =
              paths.maintenance.resolve(".restore-recovery").resolve(UUID.randomUUID().toString()),
          plaintext = directory.resolve("pre-restore"),
          data = plaintext.resolve("argus-data"),
          collections = plaintext.resolve(paths.collections.getFileName()),
          encrypted = directory.resolve("pre-restore.enc");
      BackupFiles.privateDirectory(data);
      for (String name : localDataEntries(paths.data))
        BackupFiles.copyTree(paths.data.resolve(name), data.resolve(name));
      boolean collectionsExisted = Files.exists(paths.collections, LinkOption.NOFOLLOW_LINKS);
      if (collectionsExisted) BackupFiles.copyTree(paths.collections, collections);
      var configurations = new LinkedHashMap<String, Map<String, Object>>();
      var workspace = readMap(data.resolve("workspace.json"));
      if (workspace != null && workspace.get("runConfigurations") instanceof List<?> list)
        for (Object item : list)
          if (item instanceof Map<?, ?> map) {
            var configuration = cast(map);
            configurations.put(text(configuration.get("id")), configuration);
          }
      for (String id : environmentIds) configurations.putIfAbsent(id, Map.of("id", id));
      var environments = resolveEnvironments(new ArrayList<>(configurations.values()));
      store.write(plaintext.resolve("keychain-environments.json"), environments);
      Path archive = directory.resolve("pre-restore.tar.gz");
      BackupArchive.create(plaintext, archive);
      BackupCrypto.encrypt(archive, encrypted, passphrase);
      Files.delete(archive);
      Recovery result =
          new Recovery(
              directory, plaintext, data, collections, encrypted, collectionsExisted, environments);
      journal(result, "prepared", Map.of());
      return result;
    } catch (IOException error) {
      throw new IllegalStateException(
          "Could not create the pre-restore recovery snapshot; no data was applied", error);
    }
  }

  private void replaceLocal(Path source) throws IOException {
    var names = new LinkedHashSet<>(localDataEntries(paths.data));
    names.addAll(localDataEntries(source));
    BackupFiles.privateDirectory(paths.data);
    for (String name : names) {
      BackupFiles.deleteTree(paths.data.resolve(name));
      if (Files.exists(source.resolve(name), LinkOption.NOFOLLOW_LINKS))
        BackupFiles.copyTree(source.resolve(name), paths.data.resolve(name));
    }
  }

  private void journal(Recovery recovery, String status, Map<String, Object> details) {
    var record = new LinkedHashMap<>(details);
    record.put("version", 1);
    record.put("status", status);
    record.put("updatedAt", Instant.now().toString());
    record.put("encryptedRecovery", recovery.encrypted.toString());
    store.write(recovery.directory.resolve("status.json"), record);
  }

  private Map<String, Object> resolveEnvironments(List<Map<String, Object>> configurations) {
    var result = new LinkedHashMap<String, Object>();
    var retainedConfigurations = new LinkedHashMap<String, Map<String, Object>>();
    var workspace = readMap(paths.data.resolve("workspace.json"));
    if (workspace != null && workspace.get("runConfigurations") instanceof List<?> saved)
      for (Object item : saved)
        if (item instanceof Map<?, ?> map) {
          var configuration = cast(map);
          retainedConfigurations.put(text(configuration.get("id")), configuration);
        }
    for (var configuration : configurations)
      retainedConfigurations.put(text(configuration.get("id")), configuration);
    // Active UI snapshots exclude disconnected repositories; backups must not exclude
    // their retained keychain environments and saved run configurations.
    for (var configuration : retainedConfigurations.values()) {
      String id = text(configuration.get("id"));
      if (id.isBlank()) continue;
      var values =
          configuration.get("env") instanceof Map<?, ?> map
              ? new LinkedHashMap<>(cast(map))
              : new LinkedHashMap<String, Object>();
      String bundle = secrets.getLocal(id, "__environment_bundle__");
      if (!bundle.isBlank())
        try {
          values.putAll(json.readValue(bundle, Map.class));
        } catch (RuntimeException ignored) {
        }
      if (configuration.get("secretKeys") instanceof List<?> keys)
        for (Object key : keys) values.put(text(key), secrets.getLocal(id, text(key)));
      result.put(id, values);
    }
    return result;
  }

  private void restoreEnvironments(Map<String, Object> environments) {
    validateEnvironments(environments);
    environments.forEach(
        (id, value) ->
            secrets.setLocal(id, "__environment_bundle__", json.writeValueAsString(value)));
  }

  private static void validateEnvironments(Map<String, Object> environments) {
    if (environments == null) return;
    if (environments.size() > 10000
        || environments.entrySet().stream()
            .anyMatch(
                entry ->
                    !entry.getKey().matches("[A-Za-z0-9_:-]{1,240}")
                        || !(entry.getValue() instanceof Map<?, ?>)))
      throw new IllegalArgumentException("Invalid backup environment bundles");
  }

  public List<String> localDataEntries(Path directory) {
    if (!Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) return List.of();
    try {
      BackupFiles.safeAncestors(directory);
      try (var entries = Files.list(directory)) {
        return entries
            .filter(
                entry ->
                    !Files.isSymbolicLink(entry)
                        && !EXCLUDED.contains(entry.getFileName().toString())
                        && !Set.of("backup-owner.json", "argus owner", "argus owner signing")
                            .contains(entry.getFileName().toString().toLowerCase(Locale.ROOT)))
            .map(entry -> entry.getFileName().toString())
            .sorted()
            .toList();
      }
    } catch (IOException error) {
      throw new IllegalStateException("Could not inventory managed data", error);
    }
  }

  private List<Path> sourceFiles() {
    var result = new ArrayList<Path>();
    if (!Files.isDirectory(paths.source, LinkOption.NOFOLLOW_LINKS))
      throw new IllegalStateException(
          "Argus source bundle is missing; reinstall the current build before saving");
    try {
      BackupFiles.safeAncestors(paths.source);
      Files.walkFileTree(
          paths.source,
          new SimpleFileVisitor<>() {
            private boolean excluded(Path file, boolean directory) {
              Path relative = paths.source.relativize(file);
              if (relative.getNameCount() > 0
                  && !SOURCE_ENTRIES.contains(relative.getName(0).toString())) return true;
              String name = file.getFileName().toString(), lower = name.toLowerCase(Locale.ROOT);
              if (SOURCE_IGNORED.contains(lower)
                  || name.equals(SOURCE_MANIFEST)
                  || SOURCE_CREDENTIAL_NAMES.contains(lower)
                  || lower.matches("\\.env(?:\\..*)?")
                  || lower.matches(".*\\.(?:pem|key|p12|pfx|jks|keystore)$")) return true;
              boolean sensitiveName = lower.matches(".*(?:secret|credential|private[-_.]?key).*");
              // Secret-handling implementation code is part of the build; credential data is not.
              return sensitiveName
                  && (directory
                      || !lower.matches(
                          ".*\\.(?:java|js|mjs|cjs|ts|tsx|jsx|css|html|vue|svelte|c|h)$"));
            }

            @Override
            public FileVisitResult preVisitDirectory(
                Path dir, java.nio.file.attribute.BasicFileAttributes attrs) throws IOException {
              if (!dir.equals(paths.source) && excluded(dir, true))
                return FileVisitResult.SKIP_SUBTREE;
              if (paths.source.relativize(dir).getNameCount() > 128)
                throw new IOException("Source nesting exceeds safety limit");
              return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(
                Path file, java.nio.file.attribute.BasicFileAttributes attrs) throws IOException {
              if (attrs.isRegularFile() && !excluded(file, false)) result.add(file);
              if (result.size() > 100000)
                throw new IOException("Source exceeds 100,000 file limit");
              return FileVisitResult.CONTINUE;
            }
          });
      if (result.isEmpty())
        throw new IOException("Argus source bundle contains no application files");
      return result.stream().sorted().toList();
    } catch (IOException error) {
      throw new IllegalStateException("Could not inventory Argus source", error);
    }
  }

  private List<String> syncCodebase() {
    paths.requireDedicatedProject();
    var files = sourceFiles();
    try {
      BackupFiles.safeAncestors(paths.project);
      try (var entries = Files.list(paths.project)) {
        for (Path entry : entries.toList())
          if (!Set.of(".git", ".argus-backup").contains(entry.getFileName().toString()))
            BackupFiles.deleteTree(entry);
      }
      var names = new ArrayList<String>();
      for (Path file : files) {
        Path relative = paths.source.relativize(file);
        copy(file, paths.project.resolve(relative));
        names.add(relative.toString().replace('\\', '/'));
      }
      store.write(
          paths.project.resolve(SOURCE_MANIFEST),
          Map.of("format", 1, "source", "Argus distributable source bundle", "files", names));
      // Do not carry historic staging or unexpected plaintext from the dedicated
      // checkout's backup directory into a force-staged snapshot.
      Path backupDirectory = paths.project.resolve(".argus-backup");
      BackupFiles.safeAncestors(backupDirectory);
      try (var entries = Files.list(backupDirectory)) {
        for (Path entry : entries.toList())
          if (!Set.of("argus-backup.enc", "manifest.json").contains(entry.getFileName().toString()))
            BackupFiles.deleteTree(entry);
      }
      return names;
    } catch (IOException error) {
      throw new IllegalStateException("Could not prepare readable Argus source", error);
    }
  }

  private List<String> replaceMain(String remote) {
    paths.requireDedicatedProject();
    String branch = "argus-latest-" + UUID.randomUUID();
    try {
      if (quiet(List.of("rev-parse", "--verify", "HEAD")).isBlank())
        command(List.of("symbolic-ref", "HEAD", "refs/heads/" + branch));
      else command(List.of("checkout", "--orphan", branch));
      // Source .gitignore must not exclude the encrypted archive, manifests or
      // other explicitly whitelisted snapshot files. This is a dedicated checkout.
      command(List.of("add", "--force", "--all"));
      var changed =
          command(List.of("status", "--short")).lines().filter(line -> !line.isBlank()).toList();
      command(
          List.of(
              "-c",
              "user.name=Argus Backup",
              "-c",
              "user.email=argus-backup@localhost",
              "commit",
              "-m",
              "Latest Argus backup " + Instant.now()));
      command(List.of("branch", "-M", "main"));
      requireConfirmedRemote(remote);
      git.run(
          paths.project, List.of("push", "--force", "origin", "HEAD:main"), Duration.ofSeconds(30));
      command(List.of("reflog", "expire", "--expire=now", "--all"));
      command(List.of("gc", "--prune=now"));
      return changed;
    } catch (RuntimeException error) {
      try {
        command(List.of("checkout", "-f", "main"));
      } catch (RuntimeException ignored) {
      }
      throw error;
    }
  }

  private void requireConfirmedRemote(String remote) {
    String confirmed = remote.trim();
    if (!command(List.of("remote", "get-url", "origin")).trim().equals(confirmed))
      throw new IllegalArgumentException(
          "Backup repository origin changed; review and confirm the destination again");
    List<String> pushUrls =
        command(List.of("remote", "get-url", "--push", "--all", "origin"))
            .lines()
            .map(String::trim)
            .filter(value -> !value.isBlank())
            .toList();
    if (!pushUrls.equals(List.of(confirmed)))
      throw new IllegalArgumentException(
          "Backup repository push destination changed; review and confirm the destination again");
  }

  private void ensureWorkingCopy(String remote) {
    paths.requireDedicatedProject();
    if (Files.isDirectory(paths.project.resolve(".git"), LinkOption.NOFOLLOW_LINKS)) return;
    validateRemote(remote);
    Path staging = null;
    try {
      BackupFiles.safeAncestors(paths.project);
      BackupFiles.privateDirectory(paths.project.getParent());
      if (Files.exists(paths.project))
        try (var entries = Files.list(paths.project)) {
          if (entries.anyMatch(path -> !path.getFileName().toString().equals(".argus-backup")))
            throw new IllegalArgumentException(
                "Argus backup directory is not an empty Git working copy");
        }
      staging = Files.createTempDirectory(paths.project.getParent(), ".argus-clone-").toRealPath();
      Path checkout = staging.resolve("checkout");
      String heads =
          git.run(null, List.of("ls-remote", "--heads", "--", remote), Duration.ofSeconds(30));
      boolean main = heads.lines().anyMatch(line -> line.endsWith("\trefs/heads/main"));
      if (!heads.isBlank() && !main)
        throw new IllegalArgumentException(
            "The backup repository has branches but no main branch; select a dedicated empty repository or one with main");
      var clone = new ArrayList<String>(List.of("clone", "--single-branch"));
      if (main) clone.addAll(List.of("--branch", "main"));
      else clone.add("--no-checkout");
      clone.addAll(List.of("--", remote, checkout.toString()));
      git.run(null, clone, Duration.ofMinutes(5));
      if (!main)
        git.run(
            checkout, List.of("symbolic-ref", "HEAD", "refs/heads/main"), Duration.ofSeconds(10));
      if (Files.exists(paths.project.resolve(".argus-backup")))
        BackupFiles.copyTree(
            paths.project.resolve(".argus-backup"), checkout.resolve(".argus-backup"));
      if (Files.exists(paths.project)) BackupFiles.deleteTree(paths.project);
      Files.move(checkout, paths.project, StandardCopyOption.ATOMIC_MOVE);
    } catch (IOException error) {
      throw new IllegalStateException("Could not prepare backup working copy", error);
    } finally {
      if (staging != null) cleanup(staging);
    }
  }

  private Map<String, Object> mirror(String drive, List<String> files) {
    Path destination = validateDriveDestination(drive), staging = null, previous = null;
    try {
      for (Path root :
          List.of(paths.data, paths.maintenance, paths.collections, paths.project, paths.source))
        if (destination.startsWith(root) || root.startsWith(destination))
          throw new IllegalArgumentException(
              "Google Drive backup destination overlaps an Argus data or source root");
      BackupFiles.safeAncestors(destination);
      BackupFiles.privateDirectory(destination.getParent());
      staging =
          Files.createTempDirectory(destination.getParent(), ".argus-mirror-" + UUID.randomUUID())
              .toRealPath();
      copy(paths.encrypted, staging.resolve("argus-backup.enc"));
      copy(paths.manifest, staging.resolve("manifest.json"));
      Path complete = staging.resolve("Complete Git remote Mirror");
      for (String name : files) copy(paths.project.resolve(name), complete.resolve(name));
      for (String name :
          List.of(SOURCE_MANIFEST, ".argus-backup/argus-backup.enc", ".argus-backup/manifest.json"))
        copy(paths.project.resolve(name), complete.resolve(name));
      if (Files.exists(destination)) {
        previous = destination.resolveSibling(".argus-previous-" + UUID.randomUUID());
        Files.move(destination, previous, StandardCopyOption.ATOMIC_MOVE);
      }
      try {
        Files.move(staging, destination, StandardCopyOption.ATOMIC_MOVE);
        staging = null;
      } catch (IOException error) {
        if (previous != null) {
          Files.move(previous, destination, StandardCopyOption.ATOMIC_MOVE);
          previous = null;
        }
        throw error;
      }
      if (previous != null) {
        BackupFiles.deleteTree(previous);
        previous = null;
      }
      return Map.of(
          "configured",
          true,
          "saved",
          true,
          "includesCode",
          true,
          "mode",
          "complete-bitbucket-mirror",
          "path",
          destination.resolve("Complete Git remote Mirror").toString(),
          "retention",
          "latest-only");
    } catch (IOException error) {
      throw new IllegalStateException("Could not mirror encrypted backup to Google Drive", error);
    } finally {
      if (staging != null) cleanup(staging);
    }
  }

  private Path validateDriveDestination(String drive) {
    Path destination = paths.driveRoot(drive);
    owner.requireSafeStorageRoot(destination);
    for (Path root :
        List.of(paths.data, paths.maintenance, paths.collections, paths.project, paths.source))
      if (destination.startsWith(root) || root.startsWith(destination))
        throw new IllegalArgumentException(
            "Google Drive backup destination overlaps an Argus data or source root");
    try {
      BackupFiles.safeAncestors(destination);
    } catch (IOException error) {
      throw new IllegalArgumentException(
          "Google Drive backup destination must not traverse symbolic links", error);
    }
    return destination;
  }

  private Path temporary(String purpose) {
    try {
      Path root = paths.maintenance.resolve(".backup-work");
      BackupFiles.privateDirectory(root);
      return Files.createTempDirectory(root, purpose + "-").toRealPath();
    } catch (IOException error) {
      throw new IllegalStateException("Could not prepare private backup working directory", error);
    }
  }

  private String command(List<String> arguments) {
    return git.run(paths.project, arguments, Duration.ofMinutes(2));
  }

  private String quiet(List<String> arguments) {
    try {
      return command(arguments);
    } catch (RuntimeException ignored) {
      return "";
    }
  }

  @SuppressWarnings("unchecked")
  private Map<String, Object> readMap(Path file) {
    if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) return null;
    try {
      BackupFiles.safeAncestors(file);
      if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > 16_000_000)
        throw new IOException("Invalid backup metadata");
      try (var input = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)) {
        return json.readValue(input.readNBytes(16_000_001), Map.class);
      }
    } catch (IOException error) {
      throw new IllegalStateException("Could not read backup metadata", error);
    }
  }

  @SuppressWarnings("unchecked")
  private static LinkedHashMap<String, Object> cast(Map<?, ?> value) {
    return new LinkedHashMap<>((Map<String, Object>) value);
  }

  private static String text(Object value) {
    return value == null ? "" : String.valueOf(value);
  }

  private static Map<String, Object> progress(int completed, String phase) {
    return Map.of("completed", completed, "phase", phase, "message", phase + "…");
  }

  private static void copy(Path source, Path target) {
    try {
      BackupFiles.copyTree(source, target);
    } catch (IOException error) {
      throw new IllegalStateException("Could not copy private backup file", error);
    }
  }

  private static Map<String, Object> inventory(Path root) throws IOException {
    long bytes = 0;
    var files = BackupFiles.files(root);
    for (Path file : files) bytes += Files.size(file);
    return Map.of("files", files.size(), "bytes", bytes);
  }

  private static String sha256(Path file) {
    try {
      var hash = java.security.MessageDigest.getInstance("SHA-256");
      try (var input = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)) {
        byte[] bytes = new byte[65536];
        int count;
        while ((count = input.read(bytes)) >= 0) hash.update(bytes, 0, count);
      }
      return java.util.HexFormat.of().formatHex(hash.digest());
    } catch (Exception error) {
      throw new IllegalStateException("Could not checksum backup archive", error);
    }
  }

  private static void cleanup(Path exact) {
    try {
      BackupFiles.deleteTree(exact);
    } catch (IOException ignored) {
    }
  }

  private static void validateRemote(String remote) {
    BackupRepositoryUrl.validateCloneUrl(remote);
  }

  private static void rollback(List<String> failures, String label, Action action) {
    try {
      action.run();
    } catch (Exception error) {
      failures.add(label + " rollback did not complete");
    }
  }

  @FunctionalInterface
  private interface Action {
    void run() throws Exception;
  }

  private record Recovery(
      Path directory,
      Path plaintext,
      Path data,
      Path collections,
      Path encrypted,
      boolean collectionsExisted,
      Map<String, Object> environments) {}

  public static class RestoreFailure extends IllegalStateException {
    public final Path recoveryPath;
    public final boolean partialRestore;
    public final List<String> rollbackErrors;

    RestoreFailure(
        String message, Path path, boolean partial, List<String> rollbackErrors, Throwable cause) {
      super(message, cause);
      recoveryPath = path;
      partialRestore = partial;
      this.rollbackErrors = List.copyOf(rollbackErrors);
    }
  }
}
