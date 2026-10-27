package com.argus.backup.service;

import java.net.URI;
import java.util.Arrays;
import java.util.regex.Pattern;

/** Pure destination parsing. Never selects an account, accesses Git, or persists a URL. */
public final class BackupRepositoryUrl {
  private static final Pattern HOST =
      Pattern.compile(
          "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*");
  private static final Pattern SCP = Pattern.compile("([A-Za-z0-9._-]+)@([^/:]+):(.+)");

  private BackupRepositoryUrl() {}

  public static String normalize(String input) {
    String value = input == null ? "" : input.trim();
    if (value.isEmpty() || value.chars().anyMatch(Character::isISOControl)) throw invalid();
    if (value.matches("^git +clone +.*")) {
      value = value.replaceFirst("^git +clone +", "").trim();
      if (value.length() >= 2
          && ((value.startsWith("\"") && value.endsWith("\""))
              || (value.startsWith("'") && value.endsWith("'"))))
        value = value.substring(1, value.length() - 1);
    }
    if (value.matches(".*[\\s;&|`$<>\\\\\"'].*") || value.chars().anyMatch(c -> c > 0x7e))
      throw invalid();
    var scp = SCP.matcher(value);
    if (scp.matches()) {
      if (!HOST.matcher(scp.group(2)).matches() || !validPath(scp.group(3))) throw invalid();
      if (scp.group(2).equalsIgnoreCase("bitbucket.org") && scp.group(3).split("/").length != 2)
        throw invalid();
      return value;
    }
    try {
      URI uri = URI.create(value);
      String scheme = uri.getScheme(), host = uri.getHost(), user = uri.getRawUserInfo();
      if (!("https".equals(scheme) || "ssh".equals(scheme))
          || host == null
          || !HOST.matcher(host).matches()
          || uri.getRawQuery() != null
          || uri.getRawFragment() != null
          || uri.getPort() == 0
          || uri.getPort() > 65535
          || (user != null && !user.matches("[A-Za-z0-9._-]+"))) throw invalid();
      String raw = uri.getRawPath();
      if (raw == null || !raw.startsWith("/")) throw invalid();
      String path = raw.substring(1).replaceFirst("/$", "");
      if (!validPath(path)) throw invalid();
      String[] parts = path.split("/");
      if (host.equalsIgnoreCase("bitbucket.org")) {
        if ("https".equals(scheme)
            && (uri.getPort() == -1 || uri.getPort() == 443)
            && parts.length == 4
            && parts[2].equals("src"))
          return "https://bitbucket.org/"
              + parts[0]
              + "/"
              + parts[1].replaceFirst("\\.git$", "")
              + ".git";
        if (parts.length != 2) throw invalid();
      }
      return value;
    } catch (IllegalArgumentException error) {
      throw invalid();
    }
  }

  public static void validateCloneUrl(String value) {
    if (!normalize(value).equals(value))
      throw new IllegalArgumentException(
          "Use the normalized backup clone URL shown in the confirmation");
  }

  private static boolean validPath(String path) {
    return !path.isEmpty()
        && Arrays.stream(path.split("/", -1))
            .allMatch(
                part ->
                    !part.equals(".")
                        && !part.equals("..")
                        && part.matches("(?:[A-Za-z0-9._~-]|%20)+"));
  }

  private static IllegalArgumentException invalid() {
    return new IllegalArgumentException(
        "Use a valid HTTPS or SSH backup clone URL without embedded passwords or other credentials, commands, or extra arguments");
  }
}
