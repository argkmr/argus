package com.argus.agents.service;

import static com.argus.agents.domain.AgentValues.*;

import com.argus.agents.domain.CliProviderAdapter;
import java.util.*;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/** Expands product-owned argv templates without a shell. */
@Service
public class CliInvocationService {
  public record Invocation(
      String executable, List<String> arguments, String stdin, boolean structuredOutput) {}

  public Map<String, Object> settings(
      CliProviderAdapter adapter, Map<String, Object> catalog, Map<String, Object> input) {
    var models = CliInvocationService.<Map<String, Object>>list(catalog.get("models"));
    String defaultModel =
        models.stream()
            .filter(item -> truth(item.get("isDefault")))
            .findFirst()
            .orElse(models.isEmpty() ? Map.of() : models.get(0))
            .getOrDefault("id", adapter.builtin() ? "" : adapter.defaultModel())
            .toString();
    String model = value(input, "model", defaultModel);
    var metadata =
        models.stream().filter(item -> model.equals(item.get("id"))).findFirst().orElse(null);
    if (model.isEmpty()
        || (metadata == null
            && (adapter.builtin()
                || adapter.models() == null
                || !adapter.models().contains(model))))
      invalid(
          "The selected "
              + adapter.name()
              + " model is not available. Refresh the model catalogue and choose a model.");
    String effort = value(input, "effort", "auto");
    if (effort.equals("auto") && metadata != null)
      effort = value(metadata, "defaultReasoningEffort", "auto");
    List<String> supported =
        metadata != null
            ? CliInvocationService.<Map<String, Object>>list(
                    metadata.get("supportedReasoningEfforts"))
                .stream()
                .map(item -> text(item.get("effort")))
                .toList()
            : adapter.effortArguments() != null && !adapter.effortArguments().isEmpty()
                ? List.of("low", "medium", "high", "xhigh", "max")
                : List.of();
    if (!effort.equals("auto") && !supported.contains(effort))
      invalid(
          "Reasoning level '"
              + effort
              + "' is not supported by "
              + (metadata == null ? model : value(metadata, "displayName", model))
              + ". Choose one of the available levels.");
    boolean fast =
        adapter.fastArguments() != null
            && !adapter.fastArguments().isEmpty()
            && (adapter.builtin() && "codex".equals(adapter.id())
                ? metadata != null && Boolean.TRUE.equals(metadata.get("supportsFastMode"))
                : metadata == null || !Boolean.FALSE.equals(metadata.get("supportsFastMode")));
    String speed = value(input, "speed", "standard");
    if (!Set.of("standard", "fast").contains(speed))
      invalid("Unknown request speed. Choose Standard or Fast.");
    if ("fast".equals(speed) && !fast)
      invalid(
          "Fast mode is not supported by "
              + (metadata == null ? model : value(metadata, "displayName", model))
              + ".");
    return fields("model", model, "effort", effort, "speed", speed);
  }

  private static <T> List<T> list(Object value) {
    return com.argus.agents.domain.AgentValues.list(value);
  }

  private static void invalid(String message) {
    throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, message);
  }

  public Invocation invocation(CliProviderAdapter adapter, Map<String, Object> input, int port) {
    String mode = value(input, "mode", "edit"),
        model = value(input, "model", adapter.defaultModel()),
        effort = value(input, "effort", "auto"),
        speed = value(input, "speed", "standard"),
        session = text(input.get("sessionId"));
    var values =
        fields(
            "prompt",
            text(input.get("prompt")),
            "model",
            model,
            "effort",
            effort,
            "speed",
            speed,
            "mode",
            mode,
            "workingDirectory",
            input.get("workingDirectory"),
            "sandbox",
            mode.equals("plan") ? "read-only" : "danger-full-access",
            "permissionMode",
            mode.equals("plan") ? "plan" : "bypassPermissions",
            "sessionId",
            session);
    var optional = new LinkedHashMap<String, List<String>>();
    optional.put(
        "{modelArguments}", model.isEmpty() ? List.of() : expand(adapter.modelArguments(), values));
    optional.put(
        "{effortArguments}",
        effort.equals("auto") ? List.of() : expand(adapter.effortArguments(), values));
    optional.put(
        "{fastArguments}",
        speed.equals("fast") ? expand(adapter.fastArguments(), values) : List.of());
    // Built-in providers must explicitly turn Fast off as well as on: otherwise user-level
    // CLI defaults can silently disagree with the setting saved and priced by Argus.
    optional.put(
        "{speedArguments}",
        speed.equals("fast")
            ? expand(adapter.fastArguments(), values)
            : adapter.builtin() && "codex".equals(adapter.id())
                ? List.of("--config", "service_tier=\"default\"")
                : adapter.builtin() && "claude".equals(adapter.id())
                    ? List.of("--settings", "{\"fastMode\":false}")
                    : List.of());
    var directories = new ArrayList<String>();
    for (Object directory : list(input.get("additionalDirectories"))) {
      var selected = new LinkedHashMap<>(values);
      selected.put("path", directory);
      directories.addAll(expand(adapter.directoryArguments(), selected));
    }
    optional.put("{directories}", directories);
    List<String> template =
        !session.isEmpty() && !adapter.resumeArguments().isEmpty()
            ? adapter.resumeArguments()
            : truth(input.get("conversationOnly")) && !adapter.conversationArguments().isEmpty()
                ? adapter.conversationArguments()
                : adapter.runArguments();
    var args = new ArrayList<String>();
    for (String token : template) {
      if (optional.containsKey(token)) args.addAll(optional.get(token));
      else if (!(token.equals("{prompt}") && adapter.promptViaStdin()))
        args.add(replace(token, values));
    }
    return new Invocation(
        adapter.executable(),
        args,
        adapter.promptViaStdin() ? text(input.get("prompt")) : "",
        structuredOutput(template));
  }

  /** Keep the authenticated executable and product-owned configuration, not exec-only flags. */
  public Invocation codexAppServer(
      CliProviderAdapter adapter, Map<String, Object> input, int port) {
    if (!adapter.builtin() || !"codex".equals(adapter.id()) || truth(input.get("conversationOnly")))
      throw new IllegalArgumentException(
          "This request does not support the native Codex transport");
    // Extract configuration from a template expansion with non-config operands removed. A
    // prompt, session id, or path spelled "--config" must never become a CLI option here.
    var configInput = new LinkedHashMap<>(input);
    configInput.putAll(
        fields(
            "prompt",
            "",
            "sessionId",
            "",
            "workingDirectory",
            "",
            "additionalDirectories",
            List.of(),
            "model",
            "argus-native-model"));
    var exec = invocation(adapter, configInput, port);
    var arguments = new ArrayList<String>();
    arguments.add("app-server");
    for (int index = 0; index < exec.arguments().size(); index++) {
      String token = exec.arguments().get(index);
      if ((token.equals("--config") || token.equals("-c")) && index + 1 < exec.arguments().size()) {
        arguments.add("--config");
        arguments.add(exec.arguments().get(++index));
      }
    }
    return new Invocation(exec.executable(), arguments, "", true);
  }

  public Map<String, Object> codexThreadParameters(Map<String, Object> input) {
    var config = new LinkedHashMap<String, Object>();
    String effort = value(input, "effort", "auto");
    if (!effort.equals("auto")) config.put("model_reasoning_effort", effort);
    var directories = CliInvocationService.<String>list(input.get("additionalDirectories"));
    if (!directories.isEmpty()) config.put("sandbox_workspace_write.writable_roots", directories);
    return fields(
        "cwd",
        input.get("workingDirectory"),
        "model",
        input.get("model"),
        "approvalPolicy",
        "never",
        "sandbox",
        "plan".equals(input.get("mode")) ? "read-only" : "danger-full-access",
        "serviceTier",
        "fast".equals(input.get("speed")) ? "fast" : "default",
        "config",
        config);
  }

  public Map<String, Object> codexTurnParameters(Map<String, Object> input) {
    var params =
        fields(
            "cwd",
            input.get("workingDirectory"),
            "model",
            input.get("model"),
            "approvalPolicy",
            "never",
            "sandboxPolicy",
            fields("type", "plan".equals(input.get("mode")) ? "readOnly" : "dangerFullAccess"),
            "serviceTier",
            "fast".equals(input.get("speed")) ? "fast" : "default");
    if (!value(input, "effort", "auto").equals("auto")) params.put("effort", input.get("effort"));
    return params;
  }

  private static boolean structuredOutput(List<String> template) {
    // Inspect the selected invocation contract, not expanded prompt/model/path operands.
    for (int index = 0; index < template.size(); index++) {
      String argument = template.get(index);
      if (argument.equals("--")) break;
      if (argument.equals("--json")) return true;
      String format =
          argument.startsWith("--output-format=")
              ? argument.substring("--output-format=".length())
              : argument.equals("--output-format") && index + 1 < template.size()
                  ? template.get(index + 1)
                  : "";
      if (Set.of("json", "stream-json", "ndjson", "jsonl").contains(format)) return true;
    }
    return false;
  }

  private List<String> expand(List<String> template, Map<String, Object> values) {
    return template == null
        ? List.of()
        : template.stream().map(item -> replace(item, values)).toList();
  }

  private String replace(String template, Map<String, Object> values) {
    var matcher = Pattern.compile("\\{([A-Za-z][A-Za-z0-9]*)}").matcher(template);
    var result = new StringBuilder();
    while (matcher.find())
      matcher.appendReplacement(
          result,
          java.util.regex.Matcher.quoteReplacement(
              values.containsKey(matcher.group(1))
                  ? text(values.get(matcher.group(1)))
                  : matcher.group()));
    matcher.appendTail(result);
    return result.toString();
  }
}
