package com.argus.agents.domain;

import java.time.Instant;
import java.util.*;

/** JSON contract helpers retain optional/null fields without schema truncation. */
public final class AgentValues {
  private AgentValues() {}

  public static String text(Object value) {
    return Objects.toString(value, "");
  }

  public static String value(Map<String, Object> map, String key, String fallback) {
    String text = text(map.get(key));
    return text.isEmpty() ? fallback : text;
  }

  public static double number(Object value) {
    return value instanceof Number n ? n.doubleValue() : 0;
  }

  public static boolean truth(Object value) {
    return Boolean.TRUE.equals(value);
  }

  public static String now() {
    return Instant.now().toString();
  }

  public static String head(String value, int limit) {
    return value.substring(0, Math.min(value.length(), limit));
  }

  public static String tail(String value, int limit) {
    return value.substring(Math.max(0, value.length() - limit));
  }

  @SuppressWarnings("unchecked")
  public static Map<String, Object> obj(Object value) {
    return value instanceof Map<?, ?> ? (Map<String, Object>) value : new LinkedHashMap<>();
  }

  @SuppressWarnings("unchecked")
  public static <T> List<T> list(Object value) {
    return value instanceof List<?> ? (List<T>) value : new ArrayList<>();
  }

  public static Map<String, Object> fields(Object... pairs) {
    var map = new LinkedHashMap<String, Object>();
    for (int i = 0; i < pairs.length; i += 2) map.put((String) pairs[i], pairs[i + 1]);
    return map;
  }
}
