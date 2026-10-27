package com.argus.platform;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class RequestBodyLimitFilterTest {
  @Test
  void normalRequestsRejectOverflowWithoutConsumingUnboundedMemory() throws Exception {
    var request = request("/api/preferences", "x".repeat(2_000_001));
    var response = new MockHttpServletResponse();
    new RequestBodyLimitFilter()
        .doFilter(
            request,
            response,
            (req, res) -> req.getInputStream().transferTo(java.io.OutputStream.nullOutputStream()));
    assertEquals(413, response.getStatus());
    assertTrue(response.getContentAsString().contains("Request body too large"));
  }

  @Test
  void preservesDecodedUnicodeBudget() throws Exception {
    var request = request("/api/preferences", "😀".repeat(1_000_000));
    var response = new MockHttpServletResponse();
    new RequestBodyLimitFilter()
        .doFilter(
            request,
            response,
            (req, res) ->
                assertEquals(
                    4_000_000,
                    req.getInputStream().transferTo(java.io.OutputStream.nullOutputStream())));
    assertEquals(200, response.getStatus());
  }

  @Test
  void attachmentsAllowLargeStringsButOrdinaryRoutesDoNot() throws Exception {
    var request = request("/api/context", "a".repeat(21_000_000));
    var response = new MockHttpServletResponse();
    new RequestBodyLimitFilter()
        .doFilter(
            request,
            response,
            (req, res) ->
                assertEquals(
                    21_000_000,
                    req.getInputStream().transferTo(java.io.OutputStream.nullOutputStream())));
    assertEquals(200, response.getStatus());
  }

  @Test
  void apiHistoryCanKeepLargeResponsesWithoutRaisingOtherRouteBudgets() throws Exception {
    for (String method : new String[] {"POST", "PUT"}) {
      var request = request("/api/api-request-history", "x".repeat(5_100_000));
      request.setMethod(method);
      var response = new MockHttpServletResponse();
      new RequestBodyLimitFilter()
          .doFilter(
              request,
              response,
              (req, res) ->
                  req.getInputStream().transferTo(java.io.OutputStream.nullOutputStream()));
      assertEquals(method.equals("POST") ? 200 : 413, response.getStatus());
    }
  }

  @Test
  void sourceFileBudgetIsRouteAndMethodSpecific() throws Exception {
    var request = request("/api/repositories/demo/file", "x".repeat(4_500_000));
    request.setMethod("PUT");
    var response = new MockHttpServletResponse();
    new RequestBodyLimitFilter()
        .doFilter(
            request,
            response,
            (req, res) -> req.getInputStream().transferTo(java.io.OutputStream.nullOutputStream()));
    assertEquals(200, response.getStatus());
    request = request("/api/repositories/demo/file", "x".repeat(4_500_000));
    response = new MockHttpServletResponse();
    new RequestBodyLimitFilter()
        .doFilter(
            request,
            response,
            (req, res) -> req.getInputStream().transferTo(java.io.OutputStream.nullOutputStream()));
    assertEquals(413, response.getStatus());
  }

  @Test
  void diagramSnapshotsHaveAnExactTenMegabyteBudgetOnlyOnCreateAndUpdate() throws Exception {
    String id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    for (String[] endpoint :
        new String[][] {
          {"POST", "/api/diagrams", "200"},
          {"PUT", "/api/diagrams/" + id, "200"},
          {"PUT", "/api/diagrams", "413"},
          {"POST", "/api/diagrams/" + id, "413"},
          {"POST", "/api/diagrams/" + id + "/restore", "413"},
          {"PUT", "/api/diagrams/not-a-uuid", "413"},
          {"POST", "/api/diagrams-extra", "413"}
        }) {
      var request = request(endpoint[1], "x".repeat(RequestBodyLimitFilter.DIAGRAM_LIMIT));
      request.setMethod(endpoint[0]);
      var response = new MockHttpServletResponse();
      new RequestBodyLimitFilter()
          .doFilter(
              request,
              response,
              (req, res) ->
                  req.getInputStream().transferTo(java.io.OutputStream.nullOutputStream()));
      assertEquals(Integer.parseInt(endpoint[2]), response.getStatus(), endpoint[0] + endpoint[1]);
    }
    var oversized = request("/api/diagrams", "x".repeat(RequestBodyLimitFilter.DIAGRAM_LIMIT + 1));
    var response = new MockHttpServletResponse();
    new RequestBodyLimitFilter()
        .doFilter(
            oversized, response, (req, res) -> fail("Oversized Content-Length must be rejected"));
    assertEquals(413, response.getStatus());
  }

  @Test
  void unknownLengthDiagramRequestsAreLimitedByUtf8BytesInsteadOfCharacters() throws Exception {
    var request =
        new MockHttpServletRequest("POST", "/api/diagrams") {
          @Override
          public long getContentLengthLong() {
            return -1;
          }

          @Override
          public int getContentLength() {
            return -1;
          }
        };
    // Three million supplementary characters fit the old character budget but exceed 10 MB.
    request.setContent("😀".repeat(3_000_000).getBytes(StandardCharsets.UTF_8));
    var response = new MockHttpServletResponse();
    new RequestBodyLimitFilter()
        .doFilter(
            request,
            response,
            (req, res) -> req.getInputStream().transferTo(java.io.OutputStream.nullOutputStream()));
    assertEquals(413, response.getStatus());
  }

  private MockHttpServletRequest request(String path, String body) {
    var request = new MockHttpServletRequest("POST", path);
    request.setContent(body.getBytes(StandardCharsets.UTF_8));
    return request;
  }
}
