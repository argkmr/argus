package com.argus.agents.domain;

import java.util.List;

public record CliProviderAdapter(
    String id,
    String name,
    String executable,
    List<String> versionArguments,
    List<String> authenticationArguments,
    String authenticationSuccessPattern,
    String authenticationMethodPattern,
    List<String> capabilityArguments,
    String capabilitySuccessPattern,
    List<String> runArguments,
    List<String> resumeArguments,
    List<String> conversationArguments,
    String conversationDefaultModel,
    String conversationDefaultEffort,
    List<String> modelArguments,
    List<String> effortArguments,
    List<String> fastArguments,
    List<String> directoryArguments,
    boolean promptViaStdin,
    List<String> models,
    String defaultModel,
    boolean builtin,
    boolean toolCapable,
    List<String> contextCapabilities,
    String createdAt,
    String updatedAt) {
  public CliProviderAdapter {
    resumeArguments = resumeArguments == null ? List.of() : List.copyOf(resumeArguments);
    conversationArguments =
        conversationArguments == null ? List.of() : List.copyOf(conversationArguments);
    conversationDefaultModel = conversationDefaultModel == null ? "" : conversationDefaultModel;
    conversationDefaultEffort = conversationDefaultEffort == null ? "" : conversationDefaultEffort;
    contextCapabilities =
        contextCapabilities == null
            ? builtin ? List.of("image", "browser", "file") : List.of()
            : List.copyOf(contextCapabilities);
  }
}
