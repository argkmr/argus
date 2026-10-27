package com.argus.agents.dto;

public record AgentProvider(
    String id,
    String name,
    boolean installed,
    String version,
    String executablePath,
    boolean authenticated,
    String authMethod,
    ProviderAvailability availability,
    boolean canRun,
    boolean accountIdentityAvailable,
    boolean usageInformationAvailable,
    String type,
    java.util.List<String> models,
    String defaultModel,
    boolean local,
    boolean toolCapable,
    boolean supportsEffort,
    boolean supportsFastMode,
    java.util.List<String> contextCapabilities,
    java.util.List<AgentModel> modelCatalog,
    String modelCatalogSource) {}
