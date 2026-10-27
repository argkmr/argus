package com.argus.browser.service;

import com.argus.common.security.KeychainSecretStore;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Instant;
import java.util.Base64;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class BrowserPairingService {
  private final KeychainSecretStore secrets;
  private final Clock clock;
  private final SecureRandom random = new SecureRandom();
  private String code;
  private long expiresAt;
  private int attempts;

  @Autowired
  public BrowserPairingService(KeychainSecretStore secrets) {
    this(secrets, Clock.systemUTC());
  }

  BrowserPairingService(KeychainSecretStore secrets, Clock clock) {
    this.secrets = secrets;
    this.clock = clock;
  }

  public synchronized Map<String, Object> status() {
    return Map.of(
        "paired",
        !secrets.getLocal("browser-extension", "pairing-token").isEmpty(),
        "pairingPending",
        code != null && expiresAt > clock.millis());
  }

  public synchronized Map<String, Object> start() {
    code = String.valueOf(100_000 + random.nextInt(900_000));
    expiresAt = clock.millis() + 300_000;
    attempts = 0;
    return Map.of("code", code, "expiresAt", Instant.ofEpochMilli(expiresAt).toString());
  }

  public synchronized Map<String, String> complete(String supplied) {
    if (code == null || expiresAt <= clock.millis()) {
      code = null;
      throw denied("Pairing code expired. Generate a new code in Argus.");
    }
    attempts++;
    if (!equal(code, supplied == null ? "" : supplied.trim())) {
      if (attempts >= 5) code = null;
      throw denied("Pairing code is incorrect");
    }
    String token = secrets.getLocal("browser-extension", "pairing-token");
    if (token.isEmpty()) {
      byte[] bytes = new byte[32];
      random.nextBytes(bytes);
      token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
      secrets.setLocal("browser-extension", "pairing-token", token);
    }
    code = null;
    return Map.of("token", token);
  }

  public boolean verify(String token) {
    String expected = secrets.getLocal("browser-extension", "pairing-token");
    return !expected.isEmpty() && equal(expected, token);
  }

  private static boolean equal(String left, String right) {
    return MessageDigest.isEqual(
        left.getBytes(StandardCharsets.UTF_8),
        (right == null ? "" : right).getBytes(StandardCharsets.UTF_8));
  }

  private static ResponseStatusException denied(String message) {
    return new ResponseStatusException(HttpStatus.UNAUTHORIZED, message);
  }
}
