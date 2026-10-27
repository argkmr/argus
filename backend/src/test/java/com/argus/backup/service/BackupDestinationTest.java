package com.argus.backup.service;

import static org.assertj.core.api.Assertions.*;

import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class BackupDestinationTest {
  @TempDir Path temporary;

  @Test
  void detectsOnlyOneRealMacDriveAndNeverChoosesBetweenAccounts() throws Exception {
    Path home = temporary.toRealPath(), cloud = home.resolve("Library/CloudStorage");
    Path first = cloud.resolve("GoogleDrive-first@example.test/My Drive");
    Files.createDirectories(first);
    var detector = new GoogleDriveDetector();
    assertThat(detector.detect(home, true))
        .containsEntry("detected", true)
        .containsEntry("ambiguous", false)
        .containsEntry("path", first.toString());
    assertThat(detector.detect(home, false))
        .containsEntry("detected", false)
        .containsEntry("path", "");
    Path outside = home.resolve("outside");
    Files.createDirectories(outside);
    Files.createSymbolicLink(cloud.resolve("GoogleDrive-symlink"), outside);
    assertThat(detector.detect(home, true)).containsEntry("path", first.toString());
    Files.createDirectories(cloud.resolve("GoogleDrive-second@example.test/My Drive"));
    assertThat(detector.detect(home, true))
        .containsEntry("detected", false)
        .containsEntry("ambiguous", true)
        .containsEntry("path", "");
  }

  @Test
  void backupFailuresKeepNetworkGuidanceWithoutRawGitOutputOrPasswords() {
    var restricted =
        BackupGit.remoteFailure(
            "To access this repository, an admin must whitelist your IP. fatal: secret-token");
    assertThat(restricted.code).isEqualTo("BITBUCKET_IP_NOT_ALLOWED");
    assertThat(restricted)
        .hasMessageContaining("VPN")
        .hasMessageNotContaining("fatal:")
        .hasMessageNotContaining("secret-token");
    var unavailable = BackupGit.remoteFailure("Command timed out after 30 seconds");
    assertThat(unavailable.code).isEqualTo("BITBUCKET_UNAVAILABLE");
    assertThat(unavailable).hasMessageContaining("network").hasMessageContaining("SSH");
    assertThat(
            BackupGit.remoteFailure("https://user:secret-password@example.test unexpected failure"))
        .hasMessageNotContaining("secret-password")
        .hasMessageNotContaining("user:");
  }
}
