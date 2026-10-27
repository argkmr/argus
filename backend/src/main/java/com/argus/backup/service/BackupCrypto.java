package com.argus.backup.service;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.SecureRandom;
import java.util.Arrays;
import org.bouncycastle.crypto.engines.AESEngine;
import org.bouncycastle.crypto.generators.SCrypt;
import org.bouncycastle.crypto.modes.GCMBlockCipher;
import org.bouncycastle.crypto.params.AEADParameters;
import org.bouncycastle.crypto.params.KeyParameter;

/** Byte-compatible ARGUS01 + scrypt(N=16384,r=8,p=1) + AES-256-GCM archive envelope. */
public final class BackupCrypto {
  private static final byte[] MAGIC = "ARGUS01".getBytes(StandardCharsets.US_ASCII);
  private static final long MAX_ARCHIVE_BYTES = 8L * 1024 * 1024 * 1024;

  private BackupCrypto() {}

  public static void encrypt(Path source, Path destination, String passphrase) {
    transform(source, destination, passphrase, true);
  }

  public static void decrypt(Path source, Path destination, String passphrase) {
    transform(source, destination, passphrase, false);
  }

  private static void transform(Path source, Path destination, String passphrase, boolean encrypt) {
    Path temporary = null;
    byte[] key = null, password = passphrase.getBytes(StandardCharsets.UTF_8);
    try {
      BackupFiles.safeAncestors(source);
      if (!Files.isRegularFile(source, LinkOption.NOFOLLOW_LINKS)
          || Files.size(source) > MAX_ARCHIVE_BYTES)
        throw new IOException("Invalid or oversized Argus backup file");
      temporary =
          BackupFiles.privateFile(destination.toAbsolutePath().getParent(), ".argus-crypto-");
      try (var input = Files.newInputStream(source, LinkOption.NOFOLLOW_LINKS);
          var output = Files.newOutputStream(temporary, StandardOpenOption.WRITE)) {
        byte[] header = new byte[35];
        if (encrypt) {
          System.arraycopy(MAGIC, 0, header, 0, MAGIC.length);
          byte[] entropy = new byte[28];
          new SecureRandom().nextBytes(entropy);
          System.arraycopy(entropy, 0, header, 7, 28);
          output.write(header);
        } else if (input.readNBytes(header, 0, header.length) != 35
            || Files.size(source) < 51
            || !Arrays.equals(Arrays.copyOf(header, 7), MAGIC))
          throw new IOException("This is not an Argus backup file");
        key = SCrypt.generate(password, Arrays.copyOfRange(header, 7, 23), 16384, 8, 1, 32);
        var cipher = new GCMBlockCipher(new AESEngine());
        cipher.init(
            encrypt,
            new AEADParameters(new KeyParameter(key), 128, Arrays.copyOfRange(header, 23, 35)));
        byte[] buffer = new byte[65536], transformed = new byte[65568];
        int count;
        long read = 0;
        while ((count = input.read(buffer)) >= 0) {
          read += count;
          if (read > MAX_ARCHIVE_BYTES || Thread.currentThread().isInterrupted())
            throw new IOException("Backup encryption was interrupted or exceeded its size limit");
          int written = cipher.processBytes(buffer, 0, count, transformed, 0);
          output.write(transformed, 0, written);
        }
        output.write(transformed, 0, cipher.doFinal(transformed, 0));
      }
      try (var channel = FileChannel.open(temporary, StandardOpenOption.WRITE)) {
        channel.force(true);
      }
      BackupFiles.replace(temporary, destination.toAbsolutePath());
      temporary = null;
    } catch (org.bouncycastle.crypto.InvalidCipherTextException error) {
      throw new IllegalArgumentException(
          "The recovery passphrase is incorrect or the backup is damaged", error);
    } catch (IOException error) {
      throw new IllegalStateException(error.getMessage(), error);
    } finally {
      Arrays.fill(password, (byte) 0);
      if (key != null) Arrays.fill(key, (byte) 0);
      if (temporary != null)
        try {
          Files.deleteIfExists(temporary);
        } catch (IOException ignored) {
        }
    }
  }
}
