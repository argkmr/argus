package com.argus.tasks.service;

import java.util.*;

/** Bounded, immutable user-authored note snapshots; never executable commands or system policy. */
public final class PromptNotes {
  private PromptNotes() {}

  public static List<Map<String, Object>> normalize(Object value) {
    if (!(value instanceof List<?> entries) || entries.size() > 20)
      throw new IllegalArgumentException("Prompt notes must be a list of up to 20 notes");
    var result = new ArrayList<Map<String, Object>>();
    var ids = new HashSet<String>();
    int total = 0;
    for (Object entry : entries) {
      if (!(entry instanceof Map<?, ?> note)
          || !(note.get("id") instanceof String id)
          || !id.matches("[A-Za-z0-9_-]{1,100}")
          || !ids.add(id)
          || !(note.get("text") instanceof String text)
          || text.isBlank()
          || text.length() > 4_000
          || text.indexOf('\0') >= 0
          || !(note.get("enabled") instanceof Boolean enabled))
        throw new IllegalArgumentException(
            "Each prompt note needs a unique ID, text (1–4,000 characters), and enabled setting");
      total += text.length();
      if (total > 20_000)
        throw new IllegalArgumentException("Prompt notes must total at most 20,000 characters");
      var copy = new LinkedHashMap<String, Object>();
      copy.put("id", id);
      copy.put("text", text);
      copy.put("enabled", enabled);
      result.add(Collections.unmodifiableMap(copy));
    }
    return List.copyOf(result);
  }

  public static List<Map<String, Object>> resolve(Map<String, Object> input, Object defaults) {
    return normalize(input.containsKey("promptNotes") ? input.get("promptNotes") : defaults);
  }

  public static String append(String prompt, Object snapshot) {
    var enabled =
        normalize(snapshot).stream()
            .filter(note -> Boolean.TRUE.equals(note.get("enabled")))
            .toList();
    if (enabled.isEmpty()) return prompt;
    var result = new StringBuilder(prompt);
    result.append("\n\nNOTE — user-authored instructions for this prompt:\n");
    for (int index = 0; index < enabled.size(); index++)
      result.append("\n").append(index + 1).append(". ").append(enabled.get(index).get("text"));
    return result.toString();
  }
}
