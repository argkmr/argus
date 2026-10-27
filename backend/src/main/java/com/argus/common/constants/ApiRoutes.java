package com.argus.common.constants;

public final class ApiRoutes {
  public static final String API = "/api";
  public static final String AGENT_PROVIDERS = API + "/agents/providers";
  public static final String API_ENVIRONMENTS = API + "/api-environments";
  public static final String API_REQUESTS = API + "/api-requests";
  public static final String API_REQUEST_HISTORY = API + "/api-request-history";
  public static final String HEALTH = "/internal/health";
  public static final String REPOSITORIES = API + "/repositories";
  public static final String REPOSITORY_GIT = REPOSITORIES + "/{repositoryId}/git";
  public static final String REPOSITORY_TERMINAL = REPOSITORIES + "/{repositoryId}/terminal";
  public static final String SPA_AI_CONNECTIONS = "/ai-connections";
  public static final String SPA_DAILY_TASKS = "/daily-tasks";
  public static final String SPA_DIAGRAM_STUDIO = "/diagram-studio";
  public static final String SPA_API_CLIENT = "/api-client";
  public static final String SPA_GLOBAL_AI = "/global-ai/**";
  public static final String SPA_REPOSITORIES = "/repositories/**";
  public static final String SPA_SERVICES = "/services";
  public static final String TASKS = API + "/ai-tasks";

  private ApiRoutes() {}
}
