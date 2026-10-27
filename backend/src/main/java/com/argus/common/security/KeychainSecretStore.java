package com.argus.common.security;

import com.argus.common.process.CommandFailedException;
import com.argus.common.process.CommandRunner;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

@Component
public class KeychainSecretStore {
  private static final String SERVICE_PREFIX = "com.argus.personal";
  private final CommandRunner commands;
  private final Map<String, String> fallback = new ConcurrentHashMap<>();

  public KeychainSecretStore(CommandRunner commands) {
    this.commands = commands;
  }

  public void set(String namespace, String account, String value) {
    requireName(namespace, "Secret namespace");
    setInService(service(namespace), account, value);
  }

  /** Keep this edition's credentials isolated from other Argus installations. */
  public void setLocal(String namespace, String account, String value) {
    requireName(namespace, "Secret namespace");
    setInService("argus-personal:" + namespace, account, value);
  }

  private void setInService(String service, String account, String value) {
    requireName(account, "Secret account");
    if (value == null || value.isBlank())
      throw new IllegalArgumentException("Secret value is required");
    if (!isMac()) {
      fallback.put(key(service, account), value);
      return;
    }
    commands.run(
        "security",
        List.of("add-generic-password", "-U", "-s", service, "-a", account, "-w", value),
        null,
        Duration.ofSeconds(15));
  }

  public String get(String namespace, String account) {
    requireName(namespace, "Secret namespace");
    return getFromService(service(namespace), account);
  }

  public String getLocal(String namespace, String account) {
    requireName(namespace, "Secret namespace");
    return getFromService("argus-personal:" + namespace, account);
  }

  private String getFromService(String service, String account) {
    requireName(account, "Secret account");
    if (!isMac()) return fallback.getOrDefault(key(service, account), "");
    try {
      return commands
          .run(
              "security",
              List.of("find-generic-password", "-s", service, "-a", account, "-w"),
              null,
              Duration.ofSeconds(15))
          .stdout()
          .trim();
    } catch (CommandFailedException error) {
      return "";
    }
  }

  public void delete(String namespace, String account) {
    requireName(namespace, "Secret namespace");
    deleteFromService(service(namespace), account);
  }

  public void deleteLocal(String namespace, String account) {
    requireName(namespace, "Secret namespace");
    deleteFromService("argus-personal:" + namespace, account);
  }

  /** Remove orphaned legacy accounts too, but only within one exact Argus-owned namespace. */
  public void deleteLocalNamespace(String namespace) {
    requireName(namespace, "Secret namespace");
    String selected = "argus-personal:" + namespace;
    if (!isMac()) {
      fallback.keySet().removeIf(key -> key.startsWith(selected + ":"));
      return;
    }
    for (int count = 0; count < 1000; count++) {
      try {
        commands.run(
            "security",
            List.of("delete-generic-password", "-s", selected),
            null,
            Duration.ofSeconds(15));
      } catch (CommandFailedException error) {
        if (error.result().exitCode() == 44)
          return; // errSecItemNotFound; every other failure remains visible.
        throw error;
      }
    }
    throw new IllegalStateException(
        "The Keychain namespace could not be fully removed within the safety limit");
  }

  private void deleteFromService(String service, String account) {
    requireName(account, "Secret account");
    if (!isMac()) {
      fallback.remove(key(service, account));
      return;
    }
    try {
      commands.run(
          "security",
          List.of("delete-generic-password", "-s", service, "-a", account),
          null,
          Duration.ofSeconds(15));
    } catch (CommandFailedException ignored) {
    }
  }

  private static boolean isMac() {
    return System.getProperty("os.name", "").toLowerCase().contains("mac");
  }

  private static String service(String namespace) {
    return SERVICE_PREFIX + "." + namespace;
  }

  private static String key(String namespace, String account) {
    return namespace + ":" + account;
  }

  private static void requireName(String value, String label) {
    if (value == null || value.isBlank())
      throw new IllegalArgumentException(label + " is required");
  }
}
