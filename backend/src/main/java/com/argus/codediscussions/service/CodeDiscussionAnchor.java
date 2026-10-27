package com.argus.codediscussions.service;

import static com.argus.codediscussions.service.CodeDiscussionData.*;

import java.io.IOException;
import java.nio.file.*;
import java.util.*;

/**
 * Client editor snapshots may be unsaved or historical; validation does not claim disk equality.
 */
final class CodeDiscussionAnchor {
  private CodeDiscussionAnchor() {}

  static Map<String, Object> validate(Path root, Object supplied) {
    var input = map(supplied);
    String path = text(input.get("path"));
    if (!(input.get("path") instanceof String)
        || path.isBlank()
        || path.length() > 4096
        || path.chars().anyMatch(Character::isISOControl)
        || path.contains("\\")
        || path.contains(":")
        || Path.of(path).isAbsolute()
        || Arrays.asList(path.split("/", -1)).stream()
            .anyMatch(p -> p.equals("..") || p.equals(".") || p.isEmpty())
        || path.equals(".git")
        || path.startsWith(".git/"))
      throw new IllegalArgumentException("Choose a file inside this repository");
    try {
      Path realRoot = root.toRealPath();
      Path existing = realRoot.resolve(path);
      while (!Files.exists(existing, LinkOption.NOFOLLOW_LINKS)) existing = existing.getParent();
      if (!existing.toRealPath().startsWith(realRoot))
        throw new IllegalArgumentException("The selected file points outside this repository");
    } catch (IOException failure) {
      throw new IllegalArgumentException(
          "The selected repository file cannot be resolved", failure);
    }
    String side = text(input.get("side"));
    if (!Set.of("source", "before", "after").contains(side))
      throw new IllegalArgumentException("Choose the source or a diff side");
    var result = new LinkedHashMap<String, Object>();
    result.put("version", 1);
    result.put("path", path);
    result.put("side", side);
    for (String key : List.of("staged", "unsaved", "selectionTruncated"))
      result.put(key, Boolean.TRUE.equals(input.get(key)));
    if (side.equals("source")) result.put("staged", false);
    for (String key : List.of("line", "column", "endLine", "endColumn")) {
      Object value = input.get(key);
      if (!(value instanceof Number number)
          || number.doubleValue() != number.intValue()
          || number.intValue() < 1
          || number.intValue() > 10_000_000)
        throw new IllegalArgumentException("Invalid code selection " + key);
      result.put(key, number.intValue());
    }
    int line = (int) result.get("line"), endLine = (int) result.get("endLine");
    if (endLine < line
        || (endLine == line && (int) result.get("endColumn") < (int) result.get("column")))
      throw new IllegalArgumentException("Invalid code selection range");
    for (String key :
        List.of(
            "selection",
            "contextBefore",
            "contextAfter",
            "symbol",
            "contentHash",
            "snapshotHash")) {
      int limit =
          key.equals("selection")
              ? 8000
              : key.startsWith("context") ? 800 : key.equals("contentHash") ? 256 : 240;
      String value = text(input.get(key));
      if (value.length() > limit)
        throw new IllegalArgumentException("Code selection " + key + " is too large");
      result.put(key, value);
    }
    if (input.containsKey("selectedLength")
        && (!(input.get("selectedLength") instanceof Number n)
            || n.doubleValue() != n.intValue()
            || n.intValue() < 0
            || n.intValue() > 100_000_000))
      throw new IllegalArgumentException("Invalid selected code length");
    int selectedLength =
        input.get("selectedLength") instanceof Number n
            ? n.intValue()
            : text(input.get("selection")).length();
    result.put("selectedLength", Math.max(text(input.get("selection")).length(), selectedLength));
    result.put("snapshotSource", "client-editor-unverified");
    return result;
  }
}
