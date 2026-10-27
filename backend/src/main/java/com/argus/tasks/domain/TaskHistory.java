package com.argus.tasks.domain;

import java.util.*;
import java.util.regex.Pattern;

/** Deterministic local history budgets; no model calls or cross-chat retrieval. */
public final class TaskHistory {
  public static final int WORKING_LIMIT = 48_000, RECENT_LIMIT = 34_000, MEMORY_LIMIT = 12_000;
  private static final Pattern IMPORTANT =
      Pattern.compile(
          "error|fail|root cause|decision|require|must|should|fixed|changed|test|api|port|branch|commit|/[A-Za-z0-9_.-]+|https?://",
          Pattern.CASE_INSENSITIVE);
  private static final Pattern DURABLE =
      Pattern.compile(
          "decision|decided|require|must|root cause|fixed|changed|test|branch|commit|api|port|do not|never",
          Pattern.CASE_INSENSITIVE);

  private TaskHistory() {}

  public static String text(Object value) {
    return Objects.toString(value, "");
  }

  public static String head(String value, int limit) {
    return value.substring(0, Math.min(value.length(), limit));
  }

  public static String tail(String value, int limit) {
    return value.substring(Math.max(0, value.length() - limit));
  }

  public static void cap(AiTask task) {
    if (task.messages == null) task.messages = new ArrayList<>();
    if (task.rollingContext == null) task.rollingContext = "";
    var counts = new HashMap<String, Integer>();
    var archived = new ArrayList<TaskMessage>();
    var kept = new ArrayList<TaskMessage>();
    for (int i = task.messages.size() - 1; i >= 0; i--) {
      var message = task.messages.get(i);
      String role = "user".equals(message.role) ? "user" : "assistant";
      if (counts.getOrDefault(role, 0) < 50) {
        counts.merge(role, 1, Integer::sum);
        kept.add(message);
      } else archived.add(message);
    }
    if (archived.isEmpty()) return;
    boolean priorPrefix =
        (task.rollingContext.isEmpty() && task.archivedMessageCount == 0)
            || Boolean.TRUE.equals(task.additionalProperties().get("rollingContextIsPrefix"));
    // Role budgets can archive noncontiguous messages; only a contiguous prefix is safe to
    // reuse when editing an earlier prompt. Unknown legacy compaction deliberately stays unknown.
    int lastArchived = task.messages.indexOf(archived.get(0));
    int firstKept = task.messages.indexOf(kept.get(kept.size() - 1));
    task.additionalProperties()
        .put("rollingContextIsPrefix", priorPrefix && lastArchived < firstKept);
    Collections.reverse(archived);
    Collections.reverse(kept);
    var additions = new ArrayList<String>();
    for (var message : archived) {
      String content = text(message.content).trim();
      if (content.length() > 6000) {
        String important =
            head(
                String.join(
                    "\n",
                    new LinkedHashSet<>(
                        content.lines().filter(line -> IMPORTANT.matcher(line).find()).toList())),
                4000);
        content =
            head(
                head(content, 900)
                    + "\n"
                    + (important.isEmpty()
                        ? "\n"
                        : "\nImportant retained details:\n" + important + "\n")
                    + "…\n"
                    + tail(content, 900),
                6000);
      }
      String refs = attachments(message, "- Attached ");
      additions.add(
          "### "
              + ("user".equals(message.role) ? "User" : "Argus")
              + " · "
              + (text(message.createdAt).isEmpty() ? "earlier" : message.createdAt)
              + "\n"
              + content
              + (refs.isEmpty() ? "" : "\nAttachments retained for context:\n" + refs));
    }
    String rolling =
        (task.rollingContext.isEmpty() ? "" : task.rollingContext + "\n\n")
            + String.join("\n\n", additions);
    if (rolling.length() > 90_000) {
      var lines =
          rolling.lines().map(String::stripTrailing).filter(line -> !line.isEmpty()).toList();
      var retained = new ArrayList<String>();
      var seen = new HashSet<String>();
      int size = 0;
      for (int i = lines.size() - 1; i >= 0 && size < 82_000; i--) {
        String line = lines.get(i);
        if (seen.add(head(line.replaceAll("\\s+", " "), 500))) {
          retained.add(line);
          size += line.length() + 1;
        }
      }
      Collections.reverse(retained);
      rolling =
          "Earlier task context was compacted. The newest unique facts and decisions are retained below.\n\n"
              + String.join("\n", retained);
    }
    task.rollingContext = tail(rolling, 90_000);
    task.archivedMessageCount += archived.size();
    task.messages = kept;
  }

  private static String attachments(TaskMessage message, String prefix) {
    if (message.attachments == null) return "";
    return String.join(
        "\n",
        message.attachments.stream()
            .map(
                item ->
                    prefix + first(item, "title", "kind") + ": " + first(item, "path", "url", "id"))
            .toList());
  }

  private static String first(Map<String, Object> item, String... keys) {
    for (String key : keys) if (!text(item.get(key)).isEmpty()) return text(item.get(key));
    return "Attachment";
  }

  public static Map<String, Object> workingContext(AiTask task, String query) {
    var formatted =
        task.messages.stream()
            .map(
                message ->
                    text(message.role).toUpperCase(Locale.ROOT)
                        + ":\n"
                        + text(message.content)
                        + (attachments(message, "- ").isEmpty()
                            ? ""
                            : "\nATTACHMENTS AVAILABLE TO THIS CONVERSATION:\n"
                                + attachments(message, "- ")))
            .toList();
    var recent = new ArrayList<String>();
    int used = 0, index = formatted.size() - 1;
    for (; index >= 0; index--) {
      String entry = formatted.get(index);
      if (used + entry.length() > RECENT_LIMIT && !recent.isEmpty()) break;
      recent.add(tail(entry, RECENT_LIMIT));
      used += Math.min(entry.length(), RECENT_LIMIT);
    }
    Collections.reverse(recent);
    String older =
        text(task.rollingContext) + "\n\n" + String.join("\n\n", formatted.subList(0, index + 1));
    var stop =
        Set.of(
            "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of",
            "on", "or", "that", "the", "this", "to", "with");
    var matcher =
        Pattern.compile("[a-z0-9][a-z0-9_.-]+").matcher(text(query).toLowerCase(Locale.ROOT));
    var terms = new LinkedHashSet<String>();
    while (matcher.find()) if (!stop.contains(matcher.group())) terms.add(matcher.group());
    record Scored(String line, int index, int score) {}
    var scored = new ArrayList<Scored>();
    var lines = older.split("\n", -1);
    for (int i = 0; i < lines.length; i++) {
      String line = lines[i];
      int score =
          (int) terms.stream().filter(term -> line.toLowerCase(Locale.ROOT).contains(term)).count()
                  * 3
              + (DURABLE.matcher(line).find() ? 2 : 0);
      if (!line.isBlank() && score > 0) scored.add(new Scored(line, i, score));
    }
    scored.sort(Comparator.comparingInt(Scored::score).thenComparingInt(Scored::index).reversed());
    var selected = new ArrayList<String>();
    int selectedChars = 0;
    // Enforce the documented character budget (the legacy reducer counted array entries).
    for (var item : scored)
      if (selectedChars + item.line.length() + 1 <= MEMORY_LIMIT) {
        selected.add(item.line);
        selectedChars += item.line.length() + 1;
      }
    Collections.reverse(selected);
    String retrieved = String.join("\n", selected);
    String recentText = String.join("\n\n", recent);
    String context =
        tail(
            (retrieved.isEmpty()
                    ? ""
                    : "RETRIEVED EARLIER FACTS AND DECISIONS:\n"
                        + retrieved
                        + (recentText.isEmpty() ? "" : "\n\n"))
                + (recentText.isEmpty() ? "" : "RECENT CONVERSATION:\n" + recentText),
            WORKING_LIMIT);
    int available =
        String.join("\n\n", formatted).length()
            + text(task.rollingContext).length()
            + (task.rollingContext.isEmpty() || formatted.isEmpty() ? 0 : 2);
    var metrics = new LinkedHashMap<String, Object>();
    metrics.put("strategy", "recent-window-plus-retrieved-memory");
    metrics.put("visibleMessages", task.messages.size());
    metrics.put("compactedMessages", task.archivedMessageCount);
    metrics.put("availableCharacters", available);
    metrics.put("selectedCharacters", context.length());
    metrics.put("estimatedInputTokens", (context.length() + 3) / 4);
    metrics.put("estimatedTokensAvoided", Math.max(0, (available - context.length() + 3) / 4));
    metrics.put("budgetCharacters", WORKING_LIMIT);
    return Map.of("context", context, "metrics", metrics);
  }
}
