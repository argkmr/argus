package com.argus.runtime.service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Small structural helpers for compatibility JSON; never evaluate project source. */
public final class RuntimeData {
  private RuntimeData() {}

  @SuppressWarnings("unchecked")
  public static Map<String, Object> map(Object value) {
    return value instanceof Map<?, ?> ? (Map<String, Object>) value : Map.of();
  }

  public static List<?> list(Object value) {
    return value instanceof List<?> list ? list : List.of();
  }

  public static List<String> strings(Object value) {
    return list(value).stream().map(String::valueOf).toList();
  }

  public static String text(Object value) {
    return value == null ? "" : String.valueOf(value);
  }

  public static String text(Map<String, Object> value, String key) {
    return text(value.get(key));
  }

  public static long number(Object value) {
    try {
      return value instanceof Number n ? n.longValue() : Long.parseLong(text(value));
    } catch (RuntimeException ignored) {
      return 0;
    }
  }

  public static Map<String, Object> object(Object... pairs) {
    var result = new LinkedHashMap<String, Object>();
    for (int i = 0; i < pairs.length; i += 2) result.put(String.valueOf(pairs[i]), pairs[i + 1]);
    return result;
  }

  public static Object copy(Object value) {
    if (value instanceof Map<?, ?> map) {
      var result = new LinkedHashMap<String, Object>();
      map.forEach((k, v) -> result.put(String.valueOf(k), copy(v)));
      return result;
    }
    if (value instanceof List<?> list)
      return list.stream()
          .map(RuntimeData::copy)
          .collect(java.util.stream.Collectors.toCollection(ArrayList::new));
    return value;
  }

  public static Map<String, Object> copyMap(Map<String, Object> value) {
    return map(copy(value));
  }

  public static String read(Path path) {
    try {
      if (!Files.exists(path)) return "";
      if (Files.size(path) > 8 * 1024 * 1024)
        throw new IllegalArgumentException(
            "Project metadata exceeds the 8 MB safety limit: " + path.getFileName());
      return Files.readString(path);
    } catch (IOException error) {
      throw new IllegalStateException("Could not read " + path, error);
    }
  }

  public static Path inside(Path root, String relative) {
    Path absolute = root.toAbsolutePath().normalize(),
        target = absolute.resolve(relative).normalize();
    if (!target.startsWith(absolute))
      throw new IllegalArgumentException("Path must stay inside the repository");
    try {
      Path realRoot = absolute.toRealPath(), existing = target;
      while (existing != null && !Files.exists(existing)) existing = existing.getParent();
      if (existing == null || !existing.toRealPath().startsWith(realRoot))
        throw new IllegalArgumentException(
            "Path must stay inside the repository; escaping symbolic links are not allowed");
    } catch (IOException error) {
      throw new IllegalStateException("Could not resolve repository path", error);
    }
    return target;
  }
}
