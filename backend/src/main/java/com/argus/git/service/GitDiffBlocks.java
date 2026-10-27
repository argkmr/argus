package com.argus.git.service;

import com.argus.git.dto.GitDiffChange;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.regex.Pattern;

/** Maps the displayed Git patch to immutable raw text, never trusting a client patch. */
final class GitDiffBlocks {
  private static final Pattern HUNK =
      Pattern.compile("^@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@.*$");

  private GitDiffBlocks() {}

  static List<GitDiffChange> changes(String revision, String patch, byte[] before, byte[] after) {
    var left = lines(before);
    var right = lines(after);
    var result = new ArrayList<GitDiffChange>();
    int l = 0, r = 0, leftEnd = 0, rightEnd = 0, blockL = -1, blockR = -1;
    boolean hunk = false;
    try {
      for (String line : patch.split("\n", -1)) {
        cancelled();
        var header = HUNK.matcher(line);
        if (header.matches()) {
          if (hunk && (l != leftEnd || r != rightEnd)) return List.of();
          if (blockL >= 0) {
            result.add(change(revision, blockL, l, blockR, r));
            blockL = -1;
          }
          int lc = header.group(2) == null ? 1 : Integer.parseInt(header.group(2));
          int rc = header.group(4) == null ? 1 : Integer.parseInt(header.group(4));
          int nextL = Integer.parseInt(header.group(1)) - (lc == 0 ? 0 : 1);
          int nextR = Integer.parseInt(header.group(3)) - (rc == 0 ? 0 : 1);
          // Any omitted patch context must be byte-exact unchanged text too.
          if (nextL < l
              || nextR < r
              || nextL - l != nextR - r
              || nextL > left.size()
              || nextR > right.size()) return List.of();
          for (; l < nextL; l++, r++) if (!left.get(l).equals(right.get(r))) return List.of();
          l = nextL;
          r = nextR;
          leftEnd = l + lc;
          rightEnd = r + rc;
          if (leftEnd > left.size() || rightEnd > right.size()) return List.of();
          hunk = true;
          continue;
        }
        if (!hunk || line.startsWith("\\ No newline at end of file")) continue;
        if (l == leftEnd && r == rightEnd) {
          if (blockL >= 0) {
            result.add(change(revision, blockL, l, blockR, r));
            blockL = -1;
          }
          hunk = false;
          continue;
        }
        if (line.isEmpty()) return List.of();
        char kind = line.charAt(0);
        String value = line.substring(1);
        if (kind == ' ') {
          if (blockL >= 0) {
            result.add(change(revision, blockL, l, blockR, r));
            blockL = -1;
          }
          if (l >= leftEnd
              || r >= rightEnd
              || !body(left.get(l)).equals(value)
              || !left.get(l).equals(right.get(r))) return List.of();
          l++;
          r++;
        } else if (kind == '-' || kind == '+') {
          if (blockL < 0) {
            blockL = l;
            blockR = r;
          }
          if (kind == '-') {
            if (l >= leftEnd || !body(left.get(l)).equals(value)) return List.of();
            l++;
          } else {
            if (r >= rightEnd || !body(right.get(r)).equals(value)) return List.of();
            r++;
          }
        } else return List.of();
      }
      if (hunk && (l != leftEnd || r != rightEnd)) return List.of();
      if (blockL >= 0) result.add(change(revision, blockL, l, blockR, r));
      if (left.size() - l != right.size() - r) return List.of();
      for (; l < left.size(); l++, r++) if (!left.get(l).equals(right.get(r))) return List.of();
      return List.copyOf(result);
    } catch (IndexOutOfBoundsException | NumberFormatException invalid) {
      return List.of();
    }
  }

  static byte[] restore(byte[] before, byte[] after, GitDiffChange change) {
    var left = lines(before);
    var right = lines(after);
    int start = change.afterStart() - 1;
    var result = new StringBuilder();
    for (int i = 0; i < start; i++) {
      cancelled();
      result.append(right.get(i));
    }
    for (int i = change.beforeStart() - 1;
        i < change.beforeStart() - 1 + change.beforeCount();
        i++) {
      cancelled();
      result.append(left.get(i));
    }
    for (int i = start + change.afterCount(); i < right.size(); i++) {
      cancelled();
      result.append(right.get(i));
    }
    return result.toString().getBytes(StandardCharsets.UTF_8);
  }

  private static List<String> lines(byte[] bytes) {
    String value = new String(bytes, StandardCharsets.UTF_8);
    var result = new ArrayList<String>();
    int start = 0;
    for (int i = 0; i < value.length(); i++)
      if (value.charAt(i) == '\n') {
        result.add(value.substring(start, i + 1));
        start = i + 1;
      }
    if (start < value.length()) result.add(value.substring(start));
    return result;
  }

  private static String body(String line) {
    return line.endsWith("\n") ? line.substring(0, line.length() - 1) : line;
  }

  private static GitDiffChange change(
      String revision, int before, int beforeEnd, int after, int afterEnd) {
    try {
      String identity = revision + ":" + before + ":" + beforeEnd + ":" + after + ":" + afterEnd;
      String id =
          HexFormat.of()
              .formatHex(
                  MessageDigest.getInstance("SHA-256")
                      .digest(identity.getBytes(StandardCharsets.UTF_8)));
      return new GitDiffChange(id, before + 1, beforeEnd - before, after + 1, afterEnd - after);
    } catch (java.security.NoSuchAlgorithmException error) {
      throw new IllegalStateException(error);
    }
  }

  private static void cancelled() {
    if (Thread.currentThread().isInterrupted())
      throw new com.argus.common.error.ConflictException(
          "File revert was cancelled before completion");
  }
}
