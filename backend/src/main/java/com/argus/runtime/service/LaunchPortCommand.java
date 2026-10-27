package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import tools.jackson.databind.ObjectMapper;

/** Only rewrites known development-server arguments, never evaluates a package script. */
record LaunchPortCommand(List<String> arguments, String metadataFile, String fingerprint) {
  static LaunchPortCommand inspect(Path root, Map<String, Object> configuration, int port) {
    String executable = text(configuration, "executable");
    var args = strings(configuration.get("args"));
    if (!List.of("", ".", "./").contains(text(configuration, "cwd")))
      throw new IllegalArgumentException(
          "Use Configure service to edit a custom working-directory launch.");
    if (!List.of("npm", "pnpm", "yarn", "bun").contains(executable)
        || args.size() < 2
        || !args.get(0).equals("run"))
      throw new IllegalArgumentException(
          "Use Configure service to edit this launch command and its port.");
    if (executable.equals("npm") && args.size() > 2 && !args.get(2).equals("--"))
      throw new IllegalArgumentException(
          "Package-manager options may select another workspace. Edit this launch in Configure service.");
    String source = read(inside(root, "package.json"));
    String script =
        new ObjectMapper().readTree(source).path("scripts").path(args.get(1)).asText("").trim();
    // Shell wrappers, substitutions and script-owned ports cannot safely be overridden
    // by appending another flag. Keep them available in the full configuration editor.
    if (!script.matches(
            "(?:next (?:dev|start)|vite(?: (?:serve|preview))?|nuxt (?:dev|start)|ng serve|vue-cli-service serve|react-scripts start)(?: [A-Za-z0-9_./= -]+)?")
        || java.util.regex.Pattern.compile("(?:^|\\s)(?:--port(?:[=\\s]|$)|-p(?:[=\\s0-9]|$))")
            .matcher(script)
            .find())
      throw new IllegalArgumentException(
          "This package script controls its own launch. Use Configure service to edit its arguments and port.");
    var updated = new ArrayList<String>(args.subList(0, 2));
    var forwarded = new ArrayList<String>();
    for (int index = 2; index < args.size(); index++) {
      String argument = args.get(index);
      if (argument.equals("--")) {
        if (index != 2)
          throw new IllegalArgumentException(
              "Multiple argument boundaries require Configure service.");
        continue;
      }
      if (argument.equals("--port") || argument.equals("-p")) {
        if (++index >= args.size() || RuntimeDetector.validPort(args.get(index)) == null)
          throw new IllegalArgumentException(
              "The existing port argument is invalid. Correct it in Configure service.");
      } else if (argument.startsWith("--port=") || argument.startsWith("-p=")) {
        if (RuntimeDetector.validPort(argument.substring(argument.indexOf('=') + 1)) == null)
          throw new IllegalArgumentException(
              "The existing port argument is invalid. Correct it in Configure service.");
      } else if (argument.matches("-p[0-9]+")) {
        if (RuntimeDetector.validPort(argument.substring(2)) == null)
          throw new IllegalArgumentException(
              "The existing port argument is invalid. Correct it in Configure service.");
      } else forwarded.add(argument);
    }
    if (!script.startsWith("react-scripts ")) {
      forwarded.add("--port");
      forwarded.add(Integer.toString(port));
    }
    if (!forwarded.isEmpty()) {
      if (executable.equals("npm")) updated.add("--");
      updated.addAll(forwarded);
    }
    return new LaunchPortCommand(
        updated, "package.json", ApplicationConfigService.contentHash(source));
  }
}
