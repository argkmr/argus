package com.argus.apiclient.service;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Parses cURL syntax as data. Never invokes a shell, command, or file reference. */
public final class CurlParser {
  private CurlParser() {}

  public static Map<String, Object> parse(String source) {
    List<String> tokens = tokenize((source == null ? "" : source).replaceAll("\\\\\\r?\\n", " "));
    if (tokens.isEmpty() || !tokens.get(0).equalsIgnoreCase("curl"))
      throw new IllegalArgumentException("Paste a command that starts with curl");
    String method = "GET", url = "", body = "";
    boolean forceGet = false;
    var headers = new LinkedHashMap<String, Object>();
    for (int i = 1; i < tokens.size(); i++) {
      String token = tokens.get(i), option = token, inline = null;
      int equals = token.indexOf('=');
      if (token.startsWith("--") && equals > 0) {
        option = token.substring(0, equals);
        inline = token.substring(equals + 1);
      }
      if (Set.of(
              "-X",
              "--request",
              "-H",
              "--header",
              "-d",
              "--data",
              "--data-raw",
              "--data-binary",
              "--data-ascii",
              "--data-urlencode",
              "--json",
              "--url",
              "-u",
              "--user",
              "-b",
              "--cookie",
              "-A",
              "--user-agent",
              "-e",
              "--referer")
          .contains(option)) {
        String value;
        if (inline != null) value = inline;
        else {
          if (++i >= tokens.size()) throw new IllegalArgumentException(option + " needs a value");
          value = tokens.get(i);
        }
        switch (option) {
          case "-X", "--request" -> method = value.toUpperCase();
          case "-H", "--header" -> {
            int colon = value.indexOf(':');
            if (colon > 0)
              headers.put(value.substring(0, colon).trim(), value.substring(colon + 1).trim());
          }
          case "--url" -> url = value;
          case "-u", "--user" ->
              headers.put(
                  "Authorization",
                  "Basic "
                      + Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8)));
          case "-b", "--cookie" -> headers.put("Cookie", value);
          case "-A", "--user-agent" -> headers.put("User-Agent", value);
          case "-e", "--referer" -> headers.put("Referer", value);
          default -> {
            body = value;
            if (method.equals("GET")) method = "POST";
            if (option.equals("--json")
                && headers.keySet().stream().noneMatch(key -> key.equalsIgnoreCase("Content-Type")))
              headers.put("Content-Type", "application/json");
          }
        }
      } else if (Set.of("-G", "--get").contains(token)) {
        forceGet = true;
        method = "GET";
      } else if (Set.of("-I", "--head").contains(token)) method = "HEAD";
      else if (!token.startsWith("-") && url.isEmpty()) url = token;
    }
    if (url.isEmpty())
      throw new IllegalArgumentException("The cURL command does not contain a URL");
    URI uri = URI.create(url);
    if (!Set.of("http", "https").contains(uri.getScheme()) || uri.getHost() == null)
      throw new IllegalArgumentException("Only HTTP and HTTPS requests are supported");
    if (forceGet && !body.isEmpty()) {
      var query = new ArrayList<>(ApiRequestParameters.query(url));
      query.addAll(ApiRequestParameters.query("?" + body));
      url = ApiRequestParameters.compose(url, query);
      body = "";
    }
    var result = new LinkedHashMap<String, Object>();
    result.put(
        "name",
        method + " " + (uri.getPath() == null || uri.getPath().isEmpty() ? "/" : uri.getPath()));
    result.put("method", method);
    result.put("url", url);
    result.put("headers", headers);
    result.put("body", body);
    return result;
  }

  private static List<String> tokenize(String text) {
    var tokens = new ArrayList<String>();
    var current = new StringBuilder();
    char quote = 0;
    boolean escaped = false;
    for (char c : text.trim().toCharArray()) {
      if (escaped) {
        current.append(c);
        escaped = false;
      } else if (c == '\\' && quote != '\'') escaped = true;
      else if ((c == '\'' || c == '"') && (quote == 0 || quote == c)) quote = quote == c ? 0 : c;
      else if (quote == 0 && Character.isWhitespace(c)) {
        if (!current.isEmpty()) {
          tokens.add(current.toString());
          current.setLength(0);
        }
      } else current.append(c);
    }
    if (quote != 0) throw new IllegalArgumentException("The pasted cURL has an unclosed quote");
    if (escaped) current.append('\\');
    if (!current.isEmpty()) tokens.add(current.toString());
    return tokens;
  }
}
