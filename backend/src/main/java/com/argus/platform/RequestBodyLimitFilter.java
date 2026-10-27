package com.argus.platform;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.UrlPathHelper;

/** Streaming limits matching the former listener's decoded UTF-16 character budgets. */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 1)
public class RequestBodyLimitFilter extends OncePerRequestFilter {
  static final int NORMAL_LIMIT = 2_000_000;
  public static final int ATTACHMENT_LIMIT = 128_000_000;
  // API responses may contain 5 MB. JSON escaping plus the original request/editor can be larger.
  static final int API_HISTORY_LIMIT = 48_000_000;
  static final int DIAGRAM_LIMIT = 10_000_000;
  private static final Set<String> ATTACHMENT_ROUTES =
      Set.of("/api/context", "/api/browser-context");

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    String route = UrlPathHelper.defaultInstance.getPathWithinApplication(request);
    if (!route.startsWith("/api/") && !route.startsWith("/mcp/")) {
      chain.doFilter(request, response);
      return;
    }
    boolean diagramMutation =
        request.getMethod().equals("POST") && route.equals("/api/diagrams")
            || request.getMethod().equals("PUT")
                && route.matches(
                    "/api/diagrams/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");
    int limit =
        diagramMutation
            ? DIAGRAM_LIMIT
            : ATTACHMENT_ROUTES.contains(route)
                ? ATTACHMENT_LIMIT
                : request.getMethod().equals("POST") && route.equals("/api/api-request-history")
                    ? API_HISTORY_LIMIT
                    : request.getMethod().equals("PUT")
                            && route.matches("/api/repositories/[^/]+/(?:ide/)?file")
                        ? 4_500_000
                        : NORMAL_LIMIT;
    if (request.getContentLengthLong() > (long) limit * (diagramMutation ? 1 : 4)) {
      reject(response);
      return;
    }
    HttpServletRequestWrapper limited =
        new HttpServletRequestWrapper(request) {
          private ServletInputStream stream;

          @Override
          public ServletInputStream getInputStream() throws IOException {
            if (stream == null) stream = bounded(super.getInputStream(), limit, diagramMutation);
            return stream;
          }

          @Override
          public BufferedReader getReader() throws IOException {
            return new BufferedReader(
                new InputStreamReader(getInputStream(), StandardCharsets.UTF_8));
          }
        };
    try {
      chain.doFilter(limited, response);
    } catch (RuntimeException | ServletException error) {
      if (causedByLimit(error) && !response.isCommitted()) reject(response);
      else throw error;
    }
  }

  static ServletInputStream bounded(ServletInputStream source, int limit) {
    return bounded(source, limit, false);
  }

  private static ServletInputStream bounded(
      ServletInputStream source, int limit, boolean byteBudget) {
    return new ServletInputStream() {
      private long characters;

      private void account(int value) {
        // Each UTF-8 leading byte is one UTF-16 code unit, or two for supplementary characters.
        // Continuation bytes contribute none; invalid UTF-8 is rejected by the JSON parser.
        // Diagram snapshots have a byte budget, including chunked/unknown-length requests.
        if (byteBudget) characters++;
        else if ((value & 0xc0) != 0x80) characters += (value & 0xf8) == 0xf0 ? 2 : 1;
        if (characters > limit) throw new PayloadTooLargeException();
      }

      @Override
      public int read() throws IOException {
        int value = source.read();
        if (value >= 0) account(value);
        return value;
      }

      @Override
      public int read(byte[] bytes, int offset, int length) throws IOException {
        int count = source.read(bytes, offset, length);
        for (int i = 0; i < count; i++) account(bytes[offset + i] & 0xff);
        return count;
      }

      @Override
      public void close() throws IOException {
        source.close();
      }

      @Override
      public boolean isFinished() {
        return source.isFinished();
      }

      @Override
      public boolean isReady() {
        return source.isReady();
      }

      @Override
      public void setReadListener(ReadListener listener) {
        source.setReadListener(listener);
      }
    };
  }

  public static boolean causedByLimit(Throwable error) {
    for (int depth = 0; error != null && depth < 16; depth++, error = error.getCause())
      if (error instanceof PayloadTooLargeException) return true;
    return false;
  }

  private static void reject(HttpServletResponse response) throws IOException {
    response.resetBuffer();
    response.setStatus(413);
    response.setContentType("application/json");
    response.setCharacterEncoding("UTF-8");
    response.getWriter().write("{\"error\":\"Request body too large\"}");
  }

  public static final class PayloadTooLargeException extends RuntimeException {
    public PayloadTooLargeException() {
      super("Request body too large");
    }
  }
}
