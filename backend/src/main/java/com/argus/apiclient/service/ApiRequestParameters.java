package com.argus.apiclient.service;

import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

public final class ApiRequestParameters {
  private ApiRequestParameters() {}

  public static final Pattern PATH =
      Pattern.compile(":([A-Za-z_][\\w.-]*)|(?<!\\{)\\{([A-Za-z_][\\w.-]*)}(?!})");

  public static List<Map<String, Object>> normalize(Object input) {
    if (!(input instanceof List<?> list)) return List.of();
    var result = new ArrayList<Map<String, Object>>();
    for (var item : list)
      if (item instanceof Map<?, ?> row) {
        var entry = new LinkedHashMap<String, Object>();
        entry.put("key", text(row.get("key")));
        entry.put("value", text(row.get("value")));
        var description = row.get("description");
        entry.put(
            "description",
            description instanceof Map<?, ?> map ? text(map.get("content")) : text(description));
        entry.put(
            "enabled",
            !Boolean.FALSE.equals(row.get("enabled")) && !Boolean.TRUE.equals(row.get("disabled")));
        result.add(entry);
      }
    return result;
  }

  public static List<Map<String, Object>> query(String url) {
    String source = url.split("#", 2)[0];
    int mark = source.indexOf('?');
    if (mark < 0) return List.of();
    var result = new ArrayList<Map<String, Object>>();
    for (String part : source.substring(mark + 1).split("&"))
      if (!part.isEmpty()) {
        int equals = part.indexOf('=');
        result.add(
            Map.of(
                "key",
                decode(equals < 0 ? part : part.substring(0, equals)),
                "value",
                decode(equals < 0 ? "" : part.substring(equals + 1)),
                "enabled",
                true,
                "description",
                ""));
      }
    return result;
  }

  public static List<Map<String, Object>> path(String url) {
    var names = new java.util.LinkedHashSet<String>();
    var matcher = PATH.matcher(url.split("[?#]", 2)[0]);
    while (matcher.find())
      names.add(matcher.group(1) == null ? matcher.group(2) : matcher.group(1));
    return names.stream()
        .map(
            name ->
                Map.<String, Object>of(
                    "key", name, "value", "", "enabled", true, "description", ""))
        .toList();
  }

  public static String compose(String url, Object parameters) {
    int hash = url.indexOf('#');
    String fragment = hash >= 0 ? url.substring(hash) : "",
        rest = hash >= 0 ? url.substring(0, hash) : url;
    int query = rest.indexOf('?');
    String base = query >= 0 ? rest.substring(0, query) : rest;
    String suffix =
        normalize(parameters).stream()
            .filter(
                row -> Boolean.TRUE.equals(row.get("enabled")) && !text(row.get("key")).isEmpty())
            .map(
                row ->
                    encode(text(row.get("key"))).replace("%7B%7B", "{{").replace("%7D%7D", "}}")
                        + "="
                        + encode(text(row.get("value")))
                            .replace("%7B%7B", "{{")
                            .replace("%7D%7D", "}}"))
            .collect(java.util.stream.Collectors.joining("&"));
    return base + (suffix.isEmpty() ? "" : "?" + suffix) + fragment;
  }

  public static String text(Object value) {
    return value == null ? "" : String.valueOf(value);
  }

  public static String encode(String value) {
    return URLEncoder.encode(value, StandardCharsets.UTF_8)
        .replace("+", "%20")
        .replace("%21", "!")
        .replace("%27", "'")
        .replace("%28", "(")
        .replace("%29", ")")
        .replace("%7E", "~");
  }

  private static String decode(String value) {
    try {
      return URLDecoder.decode(value, StandardCharsets.UTF_8);
    } catch (IllegalArgumentException e) {
      return value;
    }
  }
}
