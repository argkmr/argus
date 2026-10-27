package com.argus.agents.service;

import com.argus.tasks.domain.AiTask;
import com.argus.tasks.domain.TaskMessage;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.*;
import java.util.regex.Pattern;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.ObjectMapper;

/** Explicit assistant-output questions, never tool data or inferred process/approval state. */
public final class AgentQuestion {
  private AgentQuestion() {}

  private static final int MAX_OUTPUT = 500_000;
  private static final int MAX_BLOCK = 16_000;
  private static final Pattern FENCE = Pattern.compile("^ {0,3}(`{3,}|~{3,})([^\\r\\n]*)$");
  private static final Pattern EXAMPLE_INTRO =
      Pattern.compile(
          "(?i)^(?:(?:here is|here's|this is|the following is)\\s+(?:an?|the)\\s+)?"
              + "(?:example|sample|template|schema)"
              + "(?:\\s+(?:(?:argus-question|question)(?:\\s+block)?|block|format))?\\s*:$");
  private static final Pattern DIRECT_ASK =
      Pattern.compile(
          "(?is)^(?:(?:can|could|would|will|do|did|are|have) you\\b|"
              + "(?:which|what|where|when|how)\\b[^?]{0,1400}\\b(?:you|your|should I|should we|can I|can we|shall I|shall we)\\b)[^?]*\\?");

  private record Block(int start, int end, Map<String, Object> question) {}

  public static Map<String, Object> parse(String output, ObjectMapper mapper) {
    if (output == null || output.isBlank() || output.length() > MAX_OUTPUT) return Map.of();
    var blocks = blocks(output, mapper);
    if (blocks.size() == 1) return blocks.get(0).question();
    if (!blocks.isEmpty()) return Map.of();
    return suggested(output, mapper);
  }

  /** IDs are unique to one occurrence, even when two turns ask the exact same question. */
  public static Map<String, Object> scoped(String occurrenceId, Map<String, Object> question) {
    if (question == null || question.isEmpty() || occurrenceId == null || occurrenceId.isBlank())
      return Map.of();
    var result = new LinkedHashMap<>(question);
    result.put("id", occurrenceId + ":" + question.get("id"));
    return result;
  }

  public static Map<String, Object> forMessage(TaskMessage message, ObjectMapper mapper) {
    if (message == null
        || !"assistant".equals(message.role)
        || Set.of("failed", "cancelled").contains(Objects.toString(message.status, "")))
      return Map.of();
    Object saved = message.additionalProperties().get("question");
    if (saved instanceof Map<?, ?> value
        && value.get("id") instanceof String id
        && !id.isBlank()
        && Set.of("structured", "suggested").contains(Objects.toString(value.get("source"), ""))) {
      var normalized = normalize(value, mapper, value.get("source").toString());
      if (!normalized.isEmpty()) {
        normalized.put("id", id);
        return unlessCancelled(message, normalized);
      }
    }
    return unlessCancelled(message, scoped(message.id, parse(message.content, mapper)));
  }

  private static Map<String, Object> unlessCancelled(
      TaskMessage message, Map<String, Object> question) {
    var cancellation =
        AgentQuestionCancellation.metadata(
            message.additionalProperties().get("questionCancellation"));
    return !question.isEmpty() && Objects.equals(question.get("id"), cancellation.get("questionId"))
        ? Map.of()
        : question;
  }

  /** A new user message makes earlier questions historical, not a still-pending reply target. */
  public static Map<String, Object> latest(AiTask task, ObjectMapper mapper) {
    return task == null || task.messages.isEmpty()
        ? Map.of()
        : forMessage(task.messages.get(task.messages.size() - 1), mapper);
  }

  /** Remove only a valid top-level machine-readable block; keep questions readable in history. */
  public static String display(String output, ObjectMapper mapper) {
    if (output == null || output.isEmpty() || output.length() > MAX_OUTPUT) return output;
    var blocks = blocks(output, mapper);
    if (blocks.size() != 1) return output;
    var block = blocks.get(0);
    String prose = output.substring(0, block.start()) + output.substring(block.end());
    @SuppressWarnings("unchecked")
    var questions = (List<Map<String, Object>>) block.question().get("questions");
    var paragraphs = new ArrayList<String>();
    if (!prose.isBlank()) paragraphs.add(prose);
    for (var item : questions) {
      String text = item.get("question").toString();
      var details = new ArrayList<String>();
      if (!prose.contains(text)) details.add(text);
      @SuppressWarnings("unchecked")
      var options = (List<Map<String, Object>>) item.get("options");
      for (var option : options) {
        String label = option.get("label").toString();
        String description = Objects.toString(option.get("description"), "");
        String choice = label + (description.isEmpty() ? "" : " — " + description);
        if (!prose.contains(choice)) details.add("- " + choice);
      }
      if (!details.isEmpty()) paragraphs.add(String.join("\n", details));
    }
    return String.join("\n\n", paragraphs).replaceAll("\\n{3,}", "\n\n");
  }

  private static List<Block> blocks(String output, ObjectMapper mapper) {
    var result = new ArrayList<Block>();
    String fence = "";
    String previousNonblank = "";
    boolean question = false;
    int blockStart = 0, contentStart = 0, offset = 0;
    for (String line : output.split("\n", -1)) {
      String clean = line.endsWith("\r") ? line.substring(0, line.length() - 1) : line;
      var match = FENCE.matcher(clean);
      if (match.matches()) {
        String marker = match.group(1), info = match.group(2).trim();
        if (fence.isEmpty()) {
          fence = marker;
          question = "argus-question".equalsIgnoreCase(info) && !exampleIntro(previousNonblank);
          blockStart = offset;
          contentStart = Math.min(output.length(), offset + line.length() + 1);
        } else if (marker.charAt(0) == fence.charAt(0)
            && marker.length() >= fence.length()
            && info.isEmpty()) {
          if (question && offset - contentStart <= MAX_BLOCK)
            try {
              Object parsed =
                  mapper
                      .readerFor(Object.class)
                      .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                      .readValue(output.substring(contentStart, offset));
              if (parsed instanceof Map<?, ?> value) {
                var normalized = normalize(value, mapper, "structured");
                if (!normalized.isEmpty())
                  result.add(
                      new Block(
                          blockStart,
                          Math.min(output.length(), offset + line.length() + 1),
                          normalized));
              }
            } catch (RuntimeException ignored) {
              // Invalid/incomplete blocks remain visible; they are not actionable questions.
            }
          fence = "";
          question = false;
        }
      }
      if (!clean.isBlank()) previousNonblank = clean.trim();
      offset += line.length() + 1;
    }
    return result;
  }

  /** Only an explicit introduction to this block makes it an example, not domain vocabulary. */
  private static boolean exampleIntro(String line) {
    String label = line.replaceFirst("^#{1,6}\\s+", "");
    if (label.length() >= 4
        && ((label.startsWith("**") && label.endsWith("**"))
            || (label.startsWith("__") && label.endsWith("__"))))
      label = label.substring(2, label.length() - 2).trim();
    return EXAMPLE_INTRO.matcher(label).matches();
  }

  private static Map<String, Object> normalize(
      Map<?, ?> value, ObjectMapper mapper, String source) {
    if (!(value.get("questions") instanceof List<?> items) || items.isEmpty() || items.size() > 3)
      return Map.of();
    var questions = new ArrayList<Map<String, Object>>();
    var ids = new HashSet<String>();
    for (int index = 0; index < items.size(); index++) {
      if (!(items.get(index) instanceof Map<?, ?> item)) return Map.of();
      String question = bounded(item.get("question"), 2000);
      String id = item.containsKey("id") ? bounded(item.get("id"), 80) : "question-" + (index + 1);
      if (question.isEmpty() || !id.matches("[A-Za-z0-9_-]{1,80}") || !ids.add(id)) return Map.of();
      var normalized = new LinkedHashMap<String, Object>();
      normalized.put("id", id);
      normalized.put("question", question);
      if (item.containsKey("header")) {
        String header = bounded(item.get("header"), 80);
        if (header.isEmpty()) return Map.of();
        normalized.put("header", header);
      }
      var options = new ArrayList<Map<String, Object>>();
      if (item.containsKey("options")) {
        if (!(item.get("options") instanceof List<?> choices) || choices.size() > 6)
          return Map.of();
        var labels = new HashSet<String>();
        for (Object choice : choices) {
          if (!(choice instanceof Map<?, ?> option)) return Map.of();
          String label = bounded(option.get("label"), 160);
          if (label.isEmpty() || !labels.add(label)) return Map.of();
          var normalizedOption = new LinkedHashMap<String, Object>();
          normalizedOption.put("label", label);
          if (option.containsKey("description")) {
            String description = bounded(option.get("description"), 500);
            if (description.isEmpty()) return Map.of();
            normalizedOption.put("description", description);
          }
          options.add(normalizedOption);
        }
      }
      normalized.put("options", options);
      questions.add(normalized);
    }
    var result = new LinkedHashMap<String, Object>();
    result.put("id", digest(source + ":" + mapper.writeValueAsString(questions)));
    result.put("source", source);
    result.put("questions", questions);
    return result;
  }

  private static String bounded(Object value, int max) {
    if (!(value instanceof String text)) return "";
    text = text.trim();
    return text.isEmpty()
            || text.length() > max
            || text.matches("(?s).*[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f].*")
        ? ""
        : text;
  }

  private static Map<String, Object> suggested(String output, ObjectMapper mapper) {
    String prose = output.trim();
    // Legacy suggestions are an affordance, not proof the CLI is blocked. Never scan quotes,
    // markdown examples, logs, or general explanatory answers looking for question punctuation.
    if (prose.length() > 3000
        || prose.contains("```")
        || prose.contains("~~~")
        || prose.contains("\n\n")
        || prose.matches("(?s).*(?:^|\\n)\\s*(?:>|#|[-*] |\\d+[.)] ).*")
        || !DIRECT_ASK.matcher(prose).find()) return Map.of();
    return normalize(
        Map.of("questions", List.of(Map.of("id", "question-1", "question", prose))),
        mapper,
        "suggested");
  }

  private static String digest(String value) {
    try {
      return "question-"
          + HexFormat.of()
              .formatHex(
                  MessageDigest.getInstance("SHA-256")
                      .digest(value.getBytes(StandardCharsets.UTF_8)))
              .substring(0, 24);
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException(impossible);
    }
  }
}
