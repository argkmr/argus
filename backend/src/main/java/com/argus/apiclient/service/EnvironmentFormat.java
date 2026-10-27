package com.argus.apiclient.service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import tools.jackson.databind.ObjectMapper;

/** Shared literal dotenv/Vault conversion. No expansion, shell, or environment lookup. */
public final class EnvironmentFormat {
  private static final ObjectMapper JSON = new ObjectMapper();

  private EnvironmentFormat() {}

  public static Map<String, String> parse(String text) {
    return parse(text, "dotenv");
  }

  public static Map<String, String> parse(String text, String format) {
    String source = text == null ? "" : text;
    if ("vault".equals(format)) {
      if (source.isBlank()) return new LinkedHashMap<>();
      Object parsed;
      try {
        parsed = JSON.readValue(source, Object.class);
      } catch (RuntimeException e) {
        throw new IllegalArgumentException("Vault values must be pasted as one valid JSON object");
      }
      if (!(parsed instanceof Map<?, ?> object))
        throw new IllegalArgumentException("Vault values must be a JSON object");
      var result = new LinkedHashMap<String, String>();
      object.forEach(
          (key, value) ->
              result.put(
                  String.valueOf(key),
                  value instanceof Map<?, ?> || value instanceof java.util.List<?>
                      ? JSON.writeValueAsString(value)
                      : value == null ? "" : String.valueOf(value)));
      return result;
    }
    var entries = new ArrayList<String>();
    var current = new StringBuilder();
    char quote = 0;
    boolean escaped = false;
    for (char character : source.toCharArray()) {
      if (escaped) {
        current.append(character);
        escaped = false;
        continue;
      }
      if (character == '\\' && quote != 0) {
        current.append(character);
        escaped = true;
        continue;
      }
      if ((character == '"' || character == '\'') && (quote == 0 || quote == character)) {
        quote = quote == character ? 0 : character;
        current.append(character);
        continue;
      }
      if (quote == 0 && (character == '\n' || character == ';')) {
        entries.add(current.toString());
        current.setLength(0);
        continue;
      }
      current.append(character);
    }
    entries.add(current.toString());
    var environment = new LinkedHashMap<String, String>();
    for (String raw : entries) {
      String entry = raw.trim();
      if (entry.isEmpty() || entry.startsWith("#")) continue;
      entry = entry.replaceFirst("^export\\s+", "");
      int equals = entry.indexOf('=');
      if (equals < 1)
        throw new IllegalArgumentException(
            "Invalid environment entry: " + entry.substring(0, Math.min(60, entry.length())));
      String key = entry.substring(0, equals).trim();
      if (!key.matches("[A-Za-z_][A-Za-z0-9_]*"))
        throw new IllegalArgumentException("Invalid environment variable: " + key);
      String value = entry.substring(equals + 1).trim();
      if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
        try {
          value = JSON.readValue(value, String.class);
        } catch (RuntimeException e) {
          value = value.substring(1, value.length() - 1);
        }
      } else if (value.length() >= 2 && value.startsWith("'") && value.endsWith("'"))
        value = value.substring(1, value.length() - 1);
      environment.put(key, value);
    }
    return environment;
  }

  public static String serialize(Map<String, String> values) {
    return serialize(values, "dotenv");
  }

  public static String serialize(Map<String, String> values, String format) {
    if ("vault".equals(format)) {
      var object = new LinkedHashMap<String, Object>();
      values.forEach(
          (key, value) -> {
            Object restored = value;
            String trimmed = value.trim();
            if (trimmed.startsWith("{") || trimmed.startsWith("["))
              try {
                restored = JSON.readValue(trimmed, Object.class);
              } catch (RuntimeException ignored) {
              }
            object.put(key, restored);
          });
      return JSON.writerWithDefaultPrettyPrinter().writeValueAsString(object);
    }
    return values.entrySet().stream()
        .map(
            entry ->
                entry.getKey()
                    + "="
                    + (entry.getValue().matches("[A-Za-z0-9_./:@%+,-]*")
                        ? entry.getValue()
                        : JSON.writeValueAsString(entry.getValue())))
        .collect(java.util.stream.Collectors.joining("\n"));
  }
}
