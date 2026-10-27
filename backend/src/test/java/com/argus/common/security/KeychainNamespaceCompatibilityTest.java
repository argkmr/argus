package com.argus.common.security;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.common.process.CommandFailedException;
import com.argus.common.process.CommandResult;
import com.argus.common.process.CommandRunner;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;

class KeychainNamespaceCompatibilityTest {
  @Test
  void namespaceCleanupStopsOnlyAtMissingAndNeverSwallowsDeniedAccess() {
    var commands = mock(CommandRunner.class);
    var secrets = new KeychainSecretStore(commands);
    if (!System.getProperty("os.name").toLowerCase().contains("mac")) {
      secrets.setLocal("selected", "a", "value");
      secrets.setLocal("other", "b", "keep");
      secrets.deleteLocalNamespace("selected");
      assertEquals("", secrets.getLocal("selected", "a"));
      assertEquals("keep", secrets.getLocal("other", "b"));
      return;
    }
    var missing = new CommandFailedException("not found", new CommandResult("", "", 44));
    when(commands.run(anyString(), anyList(), isNull(), any(Duration.class)))
        .thenReturn(new CommandResult("", "", 0))
        .thenThrow(missing);
    secrets.deleteLocalNamespace("selected");
    verify(commands, times(2))
        .run(
            "security",
            List.of("delete-generic-password", "-s", "argus-personal:selected"),
            null,
            Duration.ofSeconds(15));
    var denied = new CommandFailedException("denied", new CommandResult("", "", 1));
    doThrow(denied).when(commands).run(anyString(), anyList(), isNull(), any(Duration.class));
    assertSame(
        denied,
        assertThrows(CommandFailedException.class, () -> secrets.deleteLocalNamespace("selected")));
  }

  @Test
  void namespaceCleanupHasBoundedExactTargetAndValidatesNames() {
    var commands = mock(CommandRunner.class);
    var secrets = new KeychainSecretStore(commands);
    assertThrows(IllegalArgumentException.class, () -> secrets.deleteLocalNamespace(""));
    verifyNoInteractions(commands);
    if (!System.getProperty("os.name").toLowerCase().contains("mac")) return;
    when(commands.run(anyString(), anyList(), isNull(), any(Duration.class)))
        .thenReturn(new CommandResult("", "", 0));
    assertThrows(IllegalStateException.class, () -> secrets.deleteLocalNamespace("selected"));
    verify(commands, times(1000))
        .run(
            "security",
            List.of("delete-generic-password", "-s", "argus-personal:selected"),
            null,
            Duration.ofSeconds(15));
  }

  @Test
  void preservesExistingCredentialServiceNamesWithoutCallingRealKeychain() {
    var commands = mock(CommandRunner.class);
    var secrets = new KeychainSecretStore(commands);
    if (!System.getProperty("os.name").toLowerCase().contains("mac")) {
      secrets.setLocal("backup", "account", "local");
      secrets.set("backup", "account", "integration");
      assertEquals("local", secrets.getLocal("backup", "account"));
      assertEquals("integration", secrets.get("backup", "account"));
      return;
    }
    when(commands.run(anyString(), anyList(), isNull(), any(Duration.class)))
        .thenReturn(new CommandResult("fixture", "", 0));
    secrets.getLocal("argus-backup", "recovery-passphrase");
    secrets.get("configuration", "test");
    secrets.setLocal("configuration", "environment", "fixture");
    secrets.deleteLocal("configuration", "environment");
    verify(commands)
        .run(
            "security",
            List.of(
                "find-generic-password",
                "-s",
                "argus-personal:argus-backup",
                "-a",
                "recovery-passphrase",
                "-w"),
            null,
            Duration.ofSeconds(15));
    verify(commands)
        .run(
            "security",
            List.of(
                "find-generic-password",
                "-s",
                "com.argus.personal.configuration",
                "-a",
                "test",
                "-w"),
            null,
            Duration.ofSeconds(15));
    verify(commands)
        .run(
            "security",
            List.of(
                "add-generic-password",
                "-U",
                "-s",
                "argus-personal:configuration",
                "-a",
                "environment",
                "-w",
                "fixture"),
            null,
            Duration.ofSeconds(15));
    verify(commands)
        .run(
            "security",
            List.of(
                "delete-generic-password",
                "-s",
                "argus-personal:configuration",
                "-a",
                "environment"),
            null,
            Duration.ofSeconds(15));
  }
}
