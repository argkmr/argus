package com.argus.platform;

import com.argus.common.config.ArgusProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Set;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.UrlPathHelper;

/** Enforces the single Java listener's loopback, browser-origin and internal-token boundary. */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class LocalApiBoundaryFilter extends OncePerRequestFilter {
  private static final Set<String> EXTENSION_ROUTES =
      Set.of("/api/browser-context", "/api/browser-extension/pair/complete");
  private final byte[] internalToken;
  private final RestoreMaintenanceGate maintenance;

  public LocalApiBoundaryFilter(ArgusProperties properties) {
    this(properties, new RestoreMaintenanceGate());
  }

  @Autowired
  public LocalApiBoundaryFilter(ArgusProperties properties, RestoreMaintenanceGate maintenance) {
    this.maintenance = maintenance;
    internalToken =
        String.valueOf(properties.mcpToken() == null ? "" : properties.mcpToken())
            .getBytes(StandardCharsets.UTF_8);
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    String peer = request.getRemoteAddr();
    String host = request.getHeader("Host");
    int port = request.getLocalPort();
    if (!isLoopback(peer)
        || host == null
        || !host.matches("(?i)(?:127\\.0\\.0\\.1|localhost):" + port)) {
      reject(response, 403, "Argus only accepts requests addressed to its local server");
      return;
    }
    String route = UrlPathHelper.defaultInstance.getPathWithinApplication(request);
    // Match Spring's decoded/matrix-parameter-free routing. Privileged routes
    // have no encoded path fields, so require their canonical spelling as well.
    boolean privileged = route.startsWith("/api/internal/") || route.startsWith("/mcp/");
    if (privileged && !route.equals(request.getRequestURI())) {
      reject(response, 400, "Internal and MCP routes require canonical paths");
      return;
    }
    String origin = request.getHeader("Origin");
    boolean hasOrigin = origin != null && !origin.isEmpty();
    boolean extension = hasOrigin && origin.matches("chrome-extension://[a-z0-9-]+");
    boolean extensionRoute = extension && EXTENSION_ROUTES.contains(route);
    if (RestoreMaintenanceGate.apiRoute(route)) {
      boolean localOrigin =
          hasOrigin && origin.matches("(?i)http://(?:127\\.0\\.0\\.1|localhost):" + port);
      if ((hasOrigin && !localOrigin && !extensionRoute)
          || (!hasOrigin && "cross-site".equalsIgnoreCase(request.getHeader("Sec-Fetch-Site")))) {
        reject(response, 403, "Websites cannot access the private Argus API");
        return;
      }
    }
    // Maintenance operates on privileged managed files. Only internal callers
    // get this narrow per-launch token boundary; ordinary local UI APIs remain
    // compatible and the existing MCP filter continues protecting MCP routes.
    if (route.startsWith("/api/internal/")) {
      if (origin != null) {
        reject(response, 403, "This operation is internal only");
        return;
      }
      String authorization = request.getHeader("Authorization");
      byte[] supplied =
          authorization != null && authorization.startsWith("Bearer ")
              ? authorization.substring(7).getBytes(StandardCharsets.UTF_8)
              : new byte[0];
      if (internalToken.length == 0 || !MessageDigest.isEqual(internalToken, supplied)) {
        reject(response, 401, "Argus internal authorization is required");
        return;
      }
    }
    if (extensionRoute) {
      if (!Set.of("POST", "OPTIONS").contains(request.getMethod())) {
        reject(response, 403, "The Chrome extension can only pair or share a tab");
        return;
      }
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
      response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      if ("OPTIONS".equals(request.getMethod())) {
        response.setStatus(204);
        return;
      }
      // ContextController verifies the pairing token before the native attachment writer runs.
    }
    var admission = maintenance.beginRequest(request.getMethod(), route);
    if (admission == RestoreMaintenanceGate.Admission.MAINTENANCE) {
      reject(response, 503, "Argus is restoring a backup; restart is required");
      return;
    }
    if (admission == RestoreMaintenanceGate.Admission.CONCURRENT_RESTORE) {
      reject(response, 409, "Another backup restore request is already in progress");
      return;
    }
    try {
      chain.doFilter(request, response);
    } finally {
      maintenance.endRequest(admission);
    }
  }

  private static boolean isLoopback(String address) {
    return address != null
        && (address.matches("127(?:\\.[0-9]{1,3}){3}")
            || address.equals("::1")
            || address.equals("0:0:0:0:0:0:0:1"));
  }

  private static void reject(HttpServletResponse response, int status, String message)
      throws IOException {
    response.setStatus(status);
    response.setContentType("application/json");
    response.setCharacterEncoding(StandardCharsets.UTF_8.name());
    response.getWriter().write("{\"error\":\"" + message + "\"}");
  }
}
