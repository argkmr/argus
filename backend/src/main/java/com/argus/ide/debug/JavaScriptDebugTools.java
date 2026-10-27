package com.argus.ide.debug;

import com.argus.common.config.ArgusProperties;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashSet;

/**
 * Metadata-only discovery; tooling is packaged separately and never read from repository scripts.
 */
final class JavaScriptDebugTools {
  record Available(String node, Path server, String reason) {
    boolean available() {
      return !node.isBlank() && server != null;
    }
  }

  static Available discover(ArgusProperties properties) {
    Path server = null;
    String configured = System.getenv().getOrDefault("ARGUS_IDE_JS_DEBUG_SERVER", "");
    if (!configured.isBlank()) {
      Path candidate = Path.of(configured);
      if (candidate.isAbsolute() && Files.isRegularFile(candidate)) server = candidate;
    } else if (properties.sourceRoot() != null) {
      Path candidate =
          properties
              .sourceRoot()
              .toAbsolutePath()
              .resolve("build/ide-tools/js-debug/src/dapDebugServer.js");
      if (Files.isRegularFile(candidate)) server = candidate;
    }
    var candidates = new LinkedHashSet<Path>();
    String explicit = System.getenv().getOrDefault("ARGUS_IDE_NODE", "");
    if (!explicit.isBlank()) candidates.add(Path.of(explicit));
    for (String entry :
        com.argus.common.process.ExecutableDiscovery.pathDirectories(
            System.getenv(), Path.of(System.getProperty("user.home")))) {
      try {
        if (Path.of(entry).isAbsolute()) candidates.add(Path.of(entry).resolve("node"));
      } catch (RuntimeException ignored) {
      }
    }
    String node =
        candidates.stream()
            .filter(Path::isAbsolute)
            .filter(Files::isRegularFile)
            .filter(Files::isExecutable)
            .map(Path::toString)
            .findFirst()
            .orElse("");
    return new Available(
        node,
        server,
        server == null
            ? "Bundled JavaScript debugger is missing; run npm run build:ide-tools or set ARGUS_IDE_JS_DEBUG_SERVER"
            : node.isBlank()
                ? "Install Node.js 22.22.2+ or set ARGUS_IDE_NODE to its executable"
                : "Bundled Microsoft JavaScript debugger; starts on demand");
  }
}
