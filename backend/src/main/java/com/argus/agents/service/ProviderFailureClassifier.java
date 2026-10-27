package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;

import java.time.Instant;
import java.util.*;
import java.util.regex.Pattern;
import tools.jackson.databind.ObjectMapper;

/**
 * Provider diagnostics only: a tool result or assistant quotation is not account-health evidence.
 */
final class ProviderFailureClassifier {
  private ProviderFailureClassifier() {}

  private static final ObjectMapper JSON = new ObjectMapper();
  private static final int LIMIT = 120_000;
  private static final Pattern ANSI = Pattern.compile("\\u001B\\[[0-?]*[ -/]*[@-~]");
  private static final Pattern PREFIX =
      Pattern.compile(
          "(?i)^(?:(?:error|fatal|codex(?: error)?|claude(?: code)?(?: error)?)\\s*:\\s*|\\[(?:error|fatal)\\]\\s*)");
  private static final Pattern LEADING_CONTEXT =
      Pattern.compile(
          "(?i)^(?:(?:you(?:'ve|’ve| have)?|your|the|account|organization|has|is|codex|claude|code|api)\\s+)*$");
  private static final Pattern QUOTA =
      Pattern.compile(
          "(?i)\\binsufficient[_\\s-]?quota\\b|\\busage[_-]limit[_-]reached\\b|\\bbilling_error\\b"
              + "|\\bquota (?:has been )?(?:exceeded|exhausted)\\b"
              + "|\\b(?:usage|spending|monthly|weekly|daily|billing) (?:limit|cap).{0,80}(?:reached|exceeded)\\b"
              + "|\\b(?:reached|hit) (?:your|the).{0,40}(?:usage|weekly|daily|monthly|billing) limit\\b"
              + "|\\bout of (?:credits|tokens)\\b|\\bcredits? (?:are )?(?:exhausted|depleted)\\b"
              + "|\\b(?:credit )?balance (?:is )?too low\\b|\\bno (?:credits|quota) remaining\\b"
              + "|\\b(?:subscription|membership|plan) (?:has |is )?(?:expired|exhausted)\\b"
              + "|\\b(?:subscription|membership|plan)(?:\\s+access)? (?:is|has been)?\\s*disabled\\b"
              + "|\\bdisabled.{0,40}(?:subscription|membership|plan)(?:\\s+access)?\\b"
              + "|\\bpayment required\\b|"
              + httpStatus("402"));
  private static final Pattern RATE =
      Pattern.compile(
          "(?i)\\btoo many requests\\b|\\brate[_-]limit(?:_error)?\\b|\\brate[\\s-]?limit(?:ed|[\\s-](?:error|exceeded|reached))\\b"
              + "|\\boverloaded(?:_error)?\\b|"
              + httpStatus("429")
              + "|"
              + httpStatus("529"));
  private static final Pattern AUTH =
      Pattern.compile(
          "(?i)\\bnot logged in\\b|\\blogin required\\b|\\bsign[ -]?in required\\b"
              + "|\\bauthentication (?:required|failed)\\b|\\bauthentication_error\\b"
              + "|\\binvalid[_ -](?:api[_ -])?key\\b|\\bunauthorized\\b|"
              + httpStatus("401"));
  private static final Pattern NETWORK =
      Pattern.compile(
          "(?i)\\bECONNREFUSED\\b|\\bconnection refused\\b|\\bfetch failed\\b|\\bcould not connect\\b"
              + "|\\bnetwork error\\b|\\bENOTFOUND\\b|\\b(?:request |connection )?timed? out\\b");
  private static final Pattern RESET =
      Pattern.compile(
          "(?i)(?:resets?(?:\\s+at|\\s+in|\\s+on)?|try again(?:\\s+at|\\s+in|\\s+after)?|retry after)[:\\s]+([^\\n.]{1,100})");

  private record Diagnostic(String text, boolean structured) {}

  private static String httpStatus(String code) {
    return "\\b(?:HTTP(?:/[\\d.]+)?(?: status)?|(?:unexpected )?status(?: code)?|API error|error code)\\s*:?\\s*"
        + code
        + "\\b";
  }

  static Map<String, Object> classify(String output, String error) {
    var diagnostics = new ArrayList<Diagnostic>();
    collect(output, diagnostics);
    collect(error, diagnostics);
    // Prefer explicit protocol errors over plain console diagnostics when both are present.
    diagnostics.sort(Comparator.comparing(Diagnostic::structured).reversed());
    for (var diagnostic : diagnostics) {
      String input = diagnostic.text();
      String code = "", status = "", message = "";
      if (matches(QUOTA, diagnostic)) {
        code = "quota_exhausted";
        status = "exhausted";
        message =
            input.toLowerCase(Locale.ROOT).contains("disabled")
                ? "Subscription access is disabled"
                : "Usage quota reached";
      } else if (matches(RATE, diagnostic)) {
        code = "rate_limited";
        status = "rate-limited";
        message = "Temporarily rate limited";
      } else if (matches(AUTH, diagnostic)) {
        code = "authentication_required";
        status = "authentication-required";
        message = "Sign-in is required";
      } else if (input.contains("Input must be provided") && input.contains("--print")) {
        code = "invalid_cli_arguments";
        status = "unknown";
        message =
            "Claude did not receive the prompt. Update Argus to the latest CLI adapter and retry.";
      } else if (matches(NETWORK, diagnostic)) {
        code = "provider_unavailable";
        status = "unavailable";
        message = "Provider connection unavailable";
      }
      if (code.isEmpty()) continue;
      var reset = RESET.matcher(input);
      String resetHint =
          !code.equals("authentication_required") && reset.find() ? reset.group(1).trim() : "";
      return fields(
          "code",
          code,
          "status",
          status,
          "canRun",
          code.equals("invalid_cli_arguments"),
          "message",
          message,
          "resetHint",
          resetHint,
          "source",
          "last-run",
          "checkedAt",
          Instant.now().toString());
    }
    return Map.of();
  }

  private static boolean matches(Pattern pattern, Diagnostic diagnostic) {
    var matcher = pattern.matcher(diagnostic.text());
    while (matcher.find())
      if (diagnostic.structured()
          || LEADING_CONTEXT.matcher(diagnostic.text().substring(0, matcher.start())).matches())
        return true;
    return false;
  }

  private static void collect(String raw, List<Diagnostic> result) {
    if (raw == null || raw.isBlank()) return;
    String input = ANSI.matcher(raw).replaceAll("");
    if (input.length() > LIMIT) {
      input = input.substring(input.length() - LIMIT);
      // A tail may begin inside quoted tool output. Never treat that partial line as a diagnostic.
      int newline = input.indexOf('\n');
      input = newline < 0 ? "" : input.substring(newline + 1);
    }
    if (input.isBlank()) return;
    Object whole = parse(input.trim());
    if (whole != null) {
      extract(whole, result);
      return;
    }
    boolean protocol = false, fenced = false;
    var plain = new ArrayList<Diagnostic>();
    for (String line : input.split("\\R")) {
      String value = line.strip();
      if (value.startsWith("```") || value.startsWith("~~~")) {
        fenced = !fenced;
        continue;
      }
      if (fenced || value.isEmpty()) continue;
      Object parsed = parse(value);
      if (parsed != null) {
        protocol = true;
        extract(parsed, result);
        continue;
      }
      String unprefixed = value;
      for (int prefix = 0; prefix < 3; prefix++) {
        var matcher = PREFIX.matcher(unprefixed);
        if (!matcher.find()) break;
        unprefixed = unprefixed.substring(matcher.end());
      }
      // Malformed/partial JSON, quoted values, source listings and stack traces are not CLI errors.
      if (unprefixed.isBlank() || "{[\"'`>}".indexOf(unprefixed.charAt(0)) >= 0) continue;
      plain.add(new Diagnostic(unprefixed, false));
    }
    // Exec/stream-json output is authoritative only through its protocol envelope, never free text.
    if (!protocol) result.addAll(plain);
  }

  private static Object parse(String value) {
    try {
      return JSON.readValue(value, Object.class);
    } catch (RuntimeException notJson) {
      return null;
    }
  }

  private static void extract(Object value, List<Diagnostic> result) {
    if (!(value instanceof Map<?, ?>)) return;
    var event = obj(value);
    String type = text(event.get("type")), method = text(event.get("method"));
    if (Set.of("error", "turn.failed").contains(type)) {
      diagnostic(event.get("error"), result);
      diagnostic(event, result);
    } else if ((type.isEmpty() || type.equals("result"))
        && Boolean.TRUE.equals(event.get("is_error"))) {
      diagnostic(event.get("error"), result);
      diagnostic(event.get("result"), result);
      if (event.get("errors") instanceof List<?> errors)
        errors.stream().limit(20).forEach(error -> diagnostic(error, result));
    } else if (type.equals("assistant")
        && event.get("error") instanceof String code
        && Set.of("authentication_failed", "billing_error", "rate_limit", "server_error")
            .contains(code)) {
      // Claude's top-level error discriminator is a CLI signal; message/content is still model
      // text.
      diagnostic(code.equals("authentication_failed") ? "authentication failed" : code, result);
    } else if (method.equals("error")) {
      diagnostic(obj(event.get("params")).get("error"), result);
    } else if (method.equals("turn/completed")) {
      var turn = obj(obj(event.get("params")).get("turn"));
      if ("failed".equals(turn.get("status"))) diagnostic(turn.get("error"), result);
    }
  }

  private static void diagnostic(Object value, List<Diagnostic> result) {
    if (value instanceof String message && !message.isBlank()) {
      result.add(new Diagnostic(message, true));
    } else if (value instanceof Map<?, ?>) {
      var error = obj(value);
      // Never recursively scan arbitrary data/details/tool payloads, even within an error envelope.
      var fields = new ArrayList<String>();
      for (String key : List.of("message", "code", "type"))
        if (error.get(key) instanceof String message && !message.isBlank()) fields.add(message);
      for (String key : List.of("status", "status_code", "http_status", "http_status_code"))
        if (error.get(key) instanceof Number status
            && Set.of(401, 402, 429).contains(status.intValue()))
          fields.add("HTTP " + status.intValue());
      if (!fields.isEmpty()) result.add(new Diagnostic(String.join("\n", fields), true));
    }
  }
}
