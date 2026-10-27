package com.argus.common.process;

import java.util.Map;
import java.util.Set;

/** Explicit repository operations must not inherit another Git invocation's repository/config. */
public final class GitEnvironment {
  private static final Set<String> REPOSITORY_OVERRIDES =
      Set.of(
          "GIT_DIR",
          "GIT_COMMON_DIR",
          "GIT_WORK_TREE",
          "GIT_INDEX_FILE",
          "GIT_OBJECT_DIRECTORY",
          "GIT_ALTERNATE_OBJECT_DIRECTORIES",
          "GIT_CONFIG",
          "GIT_CONFIG_COUNT",
          "GIT_CONFIG_PARAMETERS",
          "GIT_NAMESPACE",
          "GIT_PREFIX",
          "GIT_CEILING_DIRECTORIES",
          "GIT_DISCOVERY_ACROSS_FILESYSTEM",
          "GIT_SHALLOW_FILE",
          "GIT_GRAFT_FILE",
          "GIT_REPLACE_REF_BASE",
          "GIT_LITERAL_PATHSPECS",
          "GIT_GLOB_PATHSPECS",
          "GIT_NOGLOB_PATHSPECS",
          "GIT_ICASE_PATHSPECS");

  private GitEnvironment() {}

  public static void sanitize(Map<String, String> environment) {
    // Preserve SSH/auth, author identity and explicit global/system config isolation.
    // Only inherited repository selection, injected config, pathspec modes and output redirections
    // are unsafe for an operation whose repository was explicitly selected by Argus.
    environment
        .keySet()
        .removeIf(
            key ->
                REPOSITORY_OVERRIDES.contains(key)
                    || key.startsWith("GIT_CONFIG_KEY_")
                    || key.startsWith("GIT_CONFIG_VALUE_")
                    || key.startsWith("GIT_TRACE")
                    || key.startsWith("GIT_REDIRECT_STD"));
    environment.put("GIT_TERMINAL_PROMPT", "0");
  }
}
