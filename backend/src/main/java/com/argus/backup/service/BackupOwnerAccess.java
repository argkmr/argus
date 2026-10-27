package com.argus.backup.service;

import com.argus.common.process.CommandRunner;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermission;
import java.security.*;
import java.security.spec.X509EncodedKeySpec;
import java.time.Duration;
import java.util.*;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/**
 * A copied distribution never enrolls itself. Only an externally signed local grant enables backup.
 */
@Component
public class BackupOwnerAccess {
  private static final int MAX_ENVELOPE = 4096;
  private static final Set<String> CLAIMS = Set.of("version", "capability", "machineHash", "uid");
  private static final Pattern MACHINE =
      Pattern.compile("\"IOPlatformUUID\"\\s*=\\s*\"([0-9A-Fa-f-]{36})\"");
  private static final ObjectMapper JSON =
      JsonMapper.builder(
              JsonFactory.builder()
                  .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                  .streamReadConstraints(
                      StreamReadConstraints.builder()
                          .maxNestingDepth(4)
                          .maxStringLength(MAX_ENVELOPE)
                          .maxNumberLength(8)
                          .build())
                  .build())
          .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
          .build();
  private final Path entitlement;
  private final List<Path> protectedDirectories;
  private final List<Path> backupRoots;
  private final PublicKey verificationKey;
  private final Supplier<Identity> identity;

  @org.springframework.beans.factory.annotation.Autowired
  public BackupOwnerAccess(CommandRunner commands, BackupPaths paths) {
    this(
        Path.of(
            System.getProperty("user.home"),
            "Library",
            "Application Support",
            "Argus Personal Owner",
            "backup-owner.json"),
        loadVerificationKey(),
        () -> localIdentity(commands),
        List.of(paths.data, paths.maintenance, paths.collections, paths.project, paths.source));
  }

  // Dependency injection for signed disposable fixtures; there is no runtime unlock flag or setter.
  BackupOwnerAccess(
      Path entitlement,
      PublicKey verificationKey,
      Supplier<Identity> identity,
      List<Path> backupRoots) {
    this.entitlement = entitlement.toAbsolutePath().normalize();
    this.verificationKey = verificationKey;
    this.identity = identity;
    this.backupRoots = List.copyOf(backupRoots);
    this.protectedDirectories =
        List.of(
            this.entitlement.getParent(),
            this.entitlement.getParent().resolveSibling("Argus Owner Signing"));
  }

  public boolean allowed() {
    try {
      if (verificationKey == null) return false;
      for (Path root : backupRoots) requireSafeStorageRoot(root);
      BackupFiles.safeAncestors(entitlement);
      if (!Files.isRegularFile(entitlement, LinkOption.NOFOLLOW_LINKS)
          || Files.size(entitlement) > MAX_ENVELOPE) return false;
      requirePrivatePermissions(entitlement, false);
      requirePrivatePermissions(entitlement.getParent(), true);
      byte[] envelope;
      try (InputStream stream = Files.newInputStream(entitlement, LinkOption.NOFOLLOW_LINKS)) {
        envelope = stream.readNBytes(MAX_ENVELOPE + 1);
      }
      if (envelope.length == 0 || envelope.length > MAX_ENVELOPE) return false;
      Map<?, ?> encoded = JSON.readValue(envelope, Map.class);
      if (!encoded.keySet().equals(Set.of("payload", "signature"))
          || !(encoded.get("payload") instanceof String payloadText)
          || !(encoded.get("signature") instanceof String signatureText)) return false;
      byte[] payload = Base64.getDecoder().decode(payloadText);
      byte[] signature = Base64.getDecoder().decode(signatureText);
      if (payload.length == 0 || payload.length > 1024 || signature.length != 64) return false;
      Signature verifier = Signature.getInstance("Ed25519");
      verifier.initVerify(verificationKey);
      verifier.update(payload);
      if (!verifier.verify(signature)) return false;
      Map<?, ?> claims = JSON.readValue(payload, Map.class);
      if (!claims.keySet().equals(CLAIMS)
          || !(claims.get("version") instanceof Integer version)
          || version != 1
          || !"argus-backup-owner".equals(claims.get("capability"))
          || !(claims.get("machineHash") instanceof String machineHash)
          || !machineHash.matches("[0-9a-f]{64}")
          || !(claims.get("uid") instanceof String uid)
          || !uid.matches("0|[1-9][0-9]{0,9}")) return false;
      Identity current = identity.get();
      return current != null
          && machineHash.equals(current.machineHash())
          && uid.equals(current.uid())
          && ((Number) Files.getAttribute(entitlement, "unix:uid", LinkOption.NOFOLLOW_LINKS))
                  .longValue()
              == Long.parseLong(uid)
          && ((Number)
                      Files.getAttribute(
                          entitlement.getParent(), "unix:uid", LinkOption.NOFOLLOW_LINKS))
                  .longValue()
              == Long.parseLong(uid);
    } catch (Exception ignored) {
      return false;
    }
  }

  public void requireAllowed() {
    if (!allowed())
      throw new ResponseStatusException(
          HttpStatus.FORBIDDEN, "Backup is unavailable for this installation");
  }

  /** Enrollment and signing material cannot enter readable source or encrypted data snapshots. */
  public void requireSafeStorageRoot(Path candidate) {
    Path root = candidate.toAbsolutePath().normalize();
    try {
      if (Files.exists(root, LinkOption.NOFOLLOW_LINKS)) root = root.toRealPath();
      for (Path directory : protectedDirectories) {
        Path protectedRoot =
            Files.exists(directory, LinkOption.NOFOLLOW_LINKS) ? directory.toRealPath() : directory;
        if (root.startsWith(protectedRoot) || protectedRoot.startsWith(root))
          throw new IllegalArgumentException(
              "Backup storage overlaps private installation enrollment");
      }
    } catch (java.io.IOException error) {
      throw new IllegalArgumentException("Backup storage could not be verified", error);
    }
  }

  public Map<String, Object> visiblePreferences(Map<String, Object> preferences) {
    var visible = new LinkedHashMap<>(preferences);
    if (!allowed()) visible.remove("backup");
    return Collections.unmodifiableMap(visible);
  }

  private static void requirePrivatePermissions(Path path, boolean directory)
      throws java.io.IOException {
    Set<PosixFilePermission> expected =
        directory
            ? Set.of(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE,
                PosixFilePermission.OWNER_EXECUTE)
            : Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE);
    if (!Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS).equals(expected))
      throw new java.io.IOException("Enrollment permissions are not private");
  }

  static Identity localIdentity(CommandRunner commands) {
    if (!System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("mac")) return null;
    String output =
        commands
            .run(
                "/usr/sbin/ioreg",
                List.of("-rd1", "-c", "IOPlatformExpertDevice"),
                null,
                Duration.ofSeconds(5))
            .stdout();
    var match = MACHINE.matcher(output);
    if (!match.find()) return null;
    String uuid = match.group(1).trim().toLowerCase(Locale.ROOT);
    if (!uuid.matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
        || match.find()) return null;
    String uid =
        commands.run("/usr/bin/id", List.of("-u"), null, Duration.ofSeconds(5)).stdout().trim();
    if (!uid.matches("0|[1-9][0-9]{0,9}")) return null;
    try {
      return new Identity(
          HexFormat.of()
              .formatHex(
                  MessageDigest.getInstance("SHA-256")
                      .digest(uuid.getBytes(StandardCharsets.UTF_8))),
          uid);
    } catch (GeneralSecurityException error) {
      return null;
    }
  }

  private static PublicKey loadVerificationKey() {
    try (InputStream input =
        BackupOwnerAccess.class.getResourceAsStream("/backup-owner-public-key.txt")) {
      if (input == null) return null;
      byte[] bytes = input.readNBytes(MAX_ENVELOPE + 1);
      if (bytes.length > MAX_ENVELOPE) return null;
      String pem = new String(bytes, StandardCharsets.US_ASCII).trim();
      if (!pem.startsWith("-----BEGIN PUBLIC KEY-----")
          || !pem.endsWith("-----END PUBLIC KEY-----")) return null;
      String base64 =
          pem.substring(
                  "-----BEGIN PUBLIC KEY-----".length(),
                  pem.length() - "-----END PUBLIC KEY-----".length())
              .replaceAll("\\s", "");
      return KeyFactory.getInstance("Ed25519")
          .generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(base64)));
    } catch (Exception ignored) {
      return null;
    }
  }

  record Identity(String machineHash, String uid) {}
}
