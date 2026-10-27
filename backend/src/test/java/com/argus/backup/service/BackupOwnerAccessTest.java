package com.argus.backup.service;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.common.process.CommandResult;
import com.argus.common.process.CommandRunner;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.*;
import java.util.*;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class BackupOwnerAccessTest {
  @TempDir Path temporary;
  private final ObjectMapper json = new ObjectMapper();
  private final String machine = "a".repeat(64);

  @Test
  void nativeIdentityUsesEffectiveUidAndFixedSystemExecutablesWithoutAUsernameAllowlist()
      throws Exception {
    var commands = mock(CommandRunner.class);
    if (!System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("mac")) {
      assertThat(BackupOwnerAccess.localIdentity(commands)).isNull();
      verifyNoInteractions(commands);
      return;
    }
    String uuid = "12345678-9ABC-DEF0-1234-56789ABCDEF0";
    when(commands.run(
            eq("/usr/sbin/ioreg"),
            eq(List.of("-rd1", "-c", "IOPlatformExpertDevice")),
            isNull(),
            any()))
        .thenReturn(new CommandResult("\"IOPlatformUUID\" = \"" + uuid + "\"", "", 0));
    when(commands.run(eq("/usr/bin/id"), eq(List.of("-u")), isNull(), any()))
        .thenReturn(new CommandResult("502\n", "", 0));
    String hash =
        HexFormat.of()
            .formatHex(
                MessageDigest.getInstance("SHA-256")
                    .digest(uuid.toLowerCase(Locale.ROOT).getBytes(StandardCharsets.UTF_8)));
    assertThat(BackupOwnerAccess.localIdentity(commands))
        .isEqualTo(new BackupOwnerAccess.Identity(hash, "502"));
    when(commands.run(eq("/usr/sbin/ioreg"), anyList(), isNull(), any()))
        .thenReturn(
            new CommandResult(
                "\"IOPlatformUUID\" = \"" + uuid + "\"\n\"IOPlatformUUID\" = \"" + uuid + "\"",
                "",
                0));
    assertThat(BackupOwnerAccess.localIdentity(commands)).isNull();
    verify(commands, times(1)).run(eq("/usr/bin/id"), eq(List.of("-u")), isNull(), any());
  }

  @Test
  void onlyCorrectSignatureMachineAndEffectiveUserEnableAnInstallation() throws Exception {
    var fixture = fixture();
    sign(fixture, claims(fixture.uid), fixture.keys.getPrivate());
    assertThat(fixture.owner.allowed()).isTrue();
    assertThat(
            new BackupOwnerAccess(
                    fixture.file,
                    fixture.keys.getPublic(),
                    () -> new BackupOwnerAccess.Identity("b".repeat(64), fixture.uid),
                    List.of())
                .allowed())
        .isFalse();
    assertThat(
            new BackupOwnerAccess(
                    fixture.file,
                    fixture.keys.getPublic(),
                    () -> new BackupOwnerAccess.Identity(machine, "4294967295"),
                    List.of())
                .allowed())
        .isFalse();
    var anotherKey = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
    assertThat(
            new BackupOwnerAccess(
                    fixture.file,
                    anotherKey.getPublic(),
                    () -> new BackupOwnerAccess.Identity(machine, fixture.uid),
                    List.of())
                .allowed())
        .isFalse();
    var envelope = json.readValue(Files.readAllBytes(fixture.file), Map.class);
    envelope.put(
        "payload",
        Base64.getEncoder().encodeToString(json.writeValueAsBytes(claims("4294967295"))));
    Files.write(fixture.file, json.writeValueAsBytes(envelope));
    assertThat(fixture.owner.allowed()).isFalse();
  }

  @Test
  void missingMalformedOversizedAndNonPrivateFilesFailClosedWithoutReadingMachineIdentity()
      throws Exception {
    var fixture = fixture();
    Supplier<BackupOwnerAccess.Identity> identity = mock(Supplier.class);
    var owner = new BackupOwnerAccess(fixture.file, fixture.keys.getPublic(), identity, List.of());
    assertThat(owner.allowed()).isFalse();
    Files.writeString(fixture.file, "{}");
    assertThat(owner.allowed()).isFalse();
    sign(fixture, claims(fixture.uid), fixture.keys.getPrivate());
    Files.setPosixFilePermissions(fixture.file, PosixFilePermissions.fromString("rw-r--r--"));
    assertThat(owner.allowed()).isFalse();
    Files.setPosixFilePermissions(fixture.file, PosixFilePermissions.fromString("rw-------"));
    Files.setPosixFilePermissions(
        fixture.file.getParent(), PosixFilePermissions.fromString("rwxr-xr-x"));
    assertThat(owner.allowed()).isFalse();
    Files.setPosixFilePermissions(
        fixture.file.getParent(), PosixFilePermissions.fromString("rwx------"));
    Files.writeString(fixture.file, "x".repeat(4097));
    assertThat(owner.allowed()).isFalse();
    verifyNoInteractions(identity);
    assertThat(new BackupOwnerAccess(fixture.file, null, identity, List.of()).allowed()).isFalse();
  }

  @Test
  void signedClaimsMustHaveExactShapeAndCannotChangeCapabilityOrVersion() throws Exception {
    var fixture = fixture();
    for (Map<String, Object> invalid :
        List.of(
            altered(fixture.uid, "version", "1"),
            altered(fixture.uid, "version", 2),
            altered(fixture.uid, "version", 1.0),
            altered(fixture.uid, "uid", Long.valueOf(fixture.uid)),
            altered(fixture.uid, "capability", "argus-admin"),
            altered(fixture.uid, "machineHash", machine.toUpperCase()),
            altered(fixture.uid, "extra", true))) {
      sign(fixture, invalid, fixture.keys.getPrivate());
      assertThat(fixture.owner.allowed()).as(invalid.toString()).isFalse();
    }
    String valid = json.writeValueAsString(claims(fixture.uid));
    signBytes(
        fixture,
        (valid.substring(0, valid.length() - 1) + ",\"version\":1}")
            .getBytes(StandardCharsets.UTF_8),
        fixture.keys.getPrivate());
    assertThat(fixture.owner.allowed()).isFalse();
    signBytes(fixture, (valid + " {}").getBytes(StandardCharsets.UTF_8), fixture.keys.getPrivate());
    assertThat(fixture.owner.allowed()).isFalse();
  }

  @Test
  void EnrollmentAndSigningRootsCannotBeBackedUpAndLinksCannotProvideEnrollment() throws Exception {
    var fixture = fixture();
    sign(fixture, claims(fixture.uid), fixture.keys.getPrivate());
    for (Path root :
        List.of(
            fixture.file.getParent(),
            fixture.file.getParent().getParent(),
            fixture.file.getParent().resolveSibling("Argus Owner Signing"))) {
      assertThatThrownBy(() -> fixture.owner.requireSafeStorageRoot(root))
          .isInstanceOf(IllegalArgumentException.class);
      assertThat(
              new BackupOwnerAccess(
                      fixture.file,
                      fixture.keys.getPublic(),
                      () -> new BackupOwnerAccess.Identity(machine, fixture.uid),
                      List.of(root))
                  .allowed())
          .isFalse();
    }
    Path linked = temporary.toRealPath().resolve("linked-owner");
    Files.createSymbolicLink(linked, fixture.file.getParent());
    assertThat(
            new BackupOwnerAccess(
                    linked.resolve("backup-owner.json"),
                    fixture.keys.getPublic(),
                    () -> new BackupOwnerAccess.Identity(machine, fixture.uid),
                    List.of())
                .allowed())
        .isFalse();
    Path original = fixture.file.resolveSibling("original.json");
    Files.move(fixture.file, original);
    Files.createSymbolicLink(fixture.file, original);
    assertThat(fixture.owner.allowed()).isFalse();
  }

  @Test
  void signedUidMustAlsoOwnEnrollmentFilesAndUnavailableIdentityCannotGrantAccess()
      throws Exception {
    var fixture = fixture();
    String differentUid = fixture.uid.equals("4294967295") ? "4294967294" : "4294967295";
    sign(fixture, claims(differentUid), fixture.keys.getPrivate());
    assertThat(
            new BackupOwnerAccess(
                    fixture.file,
                    fixture.keys.getPublic(),
                    () -> new BackupOwnerAccess.Identity(machine, differentUid),
                    List.of())
                .allowed())
        .isFalse();
    sign(fixture, claims(fixture.uid), fixture.keys.getPrivate());
    assertThat(
            new BackupOwnerAccess(fixture.file, fixture.keys.getPublic(), () -> null, List.of())
                .allowed())
        .isFalse();
    assertThat(
            new BackupOwnerAccess(
                    fixture.file,
                    fixture.keys.getPublic(),
                    () -> {
                      throw new IllegalStateException("OS lookup denied");
                    },
                    List.of())
                .allowed())
        .isFalse();
    assertThatThrownBy(
            () -> new BackupOwnerAccess(fixture.file, null, () -> null, List.of()).requireAllowed())
        .hasMessageContaining("403");
  }

  private Fixture fixture() throws Exception {
    Path directory =
        Files.createDirectory(temporary.toRealPath().resolve(UUID.randomUUID().toString()));
    Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
    String uid = String.valueOf(Files.getAttribute(directory, "unix:uid"));
    var keys = KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
    Path file = directory.resolve("backup-owner.json");
    var owner =
        new BackupOwnerAccess(
            file, keys.getPublic(), () -> new BackupOwnerAccess.Identity(machine, uid), List.of());
    return new Fixture(file, keys, owner, uid);
  }

  private Map<String, Object> claims(String uid) {
    return Map.of(
        "version", 1, "capability", "argus-backup-owner", "machineHash", machine, "uid", uid);
  }

  private Map<String, Object> altered(String uid, String key, Object value) {
    var claims = new LinkedHashMap<>(claims(uid));
    claims.put(key, value);
    return claims;
  }

  private void sign(Fixture fixture, Map<String, Object> claims, PrivateKey key) throws Exception {
    signBytes(fixture, json.writeValueAsBytes(claims), key);
  }

  private void signBytes(Fixture fixture, byte[] payload, PrivateKey key) throws Exception {
    Signature signer = Signature.getInstance("Ed25519");
    signer.initSign(key);
    signer.update(payload);
    Files.write(
        fixture.file,
        json.writeValueAsBytes(
            Map.of(
                "payload",
                Base64.getEncoder().encodeToString(payload),
                "signature",
                Base64.getEncoder().encodeToString(signer.sign()))));
    Files.setPosixFilePermissions(fixture.file, PosixFilePermissions.fromString("rw-------"));
  }

  private record Fixture(Path file, KeyPair keys, BackupOwnerAccess owner, String uid) {}
}
