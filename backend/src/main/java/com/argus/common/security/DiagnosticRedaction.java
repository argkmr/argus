package com.argus.common.security;

public final class DiagnosticRedaction {
  private DiagnosticRedaction() {}

  public static String redact(String input) {
    if (input == null) return "";
    return input
        .replaceAll("(?i)(authorization\\s*:\\s*bearer\\s+)\\S+", "$1[REDACTED]")
        .replaceAll("(?i)(https?://[^:/\\s]+:)[^@/\\s]+@", "$1[REDACTED]@")
        .replaceAll("(?i)(--?(?:token|password|secret)(?:=|\\s+))\\S+", "$1[REDACTED]");
  }
}
