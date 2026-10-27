package com.argus.platform;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.*;

import com.argus.common.config.ArgusProperties;
import jakarta.servlet.ServletException;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class RestoreMaintenanceTest {
  private final RestoreMaintenanceGate gate = new RestoreMaintenanceGate();
  private final LocalApiBoundaryFilter filter =
      new LocalApiBoundaryFilter(new ArgusProperties(null, null, "test", "fixture-token"), gate);

  @Test
  void gateWaitsForExistingHandlersButNotTheRestoreInitiatorAndCannotReopen() throws Exception {
    var active = gate.beginRequest("PATCH", "/api/workspace/preferences");
    var initiating = gate.beginRequest("POST", "/api/backup/restore");
    assertThat(gate.beginRequest("POST", "/api/backup/restore"))
        .isEqualTo(RestoreMaintenanceGate.Admission.CONCURRENT_RESTORE);
    assertThat(gate.beginRestore()).isTrue();
    assertThat(gate.activeRequests()).isEqualTo(1);
    assertThat(gate.awaitDrained(Duration.ZERO)).isFalse();
    var draining = CompletableFuture.supplyAsync(() -> gate.awaitDrained(Duration.ofSeconds(2)));
    gate.endRequest(active);
    assertThat(draining.get(3, TimeUnit.SECONDS)).isTrue();
    gate.endRequest(initiating);
    assertThat(gate.beginRestore()).isFalse();
    assertThat(gate.beginRequest("POST", "/api/backup/restore"))
        .isEqualTo(RestoreMaintenanceGate.Admission.MAINTENANCE);
  }

  @Test
  void filterDrainsRealInFlightHandlerAndAlwaysReleasesFailedHandlers() throws Exception {
    var entered = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    var request =
        CompletableFuture.runAsync(
            () -> {
              try {
                filter.doFilter(
                    request("GET", "/api/workspace"),
                    new MockHttpServletResponse(),
                    (req, res) -> {
                      entered.countDown();
                      try {
                        if (!release.await(2, TimeUnit.SECONDS))
                          throw new ServletException("fixture timeout");
                      } catch (InterruptedException error) {
                        throw new ServletException(error);
                      }
                    });
              } catch (Exception error) {
                throw new RuntimeException(error);
              }
            });
    assertThat(entered.await(2, TimeUnit.SECONDS)).isTrue();
    assertThat(gate.activeRequests()).isEqualTo(1);
    gate.beginRestore();
    assertThat(gate.awaitDrained(Duration.ZERO)).isFalse();
    release.countDown();
    request.get(3, TimeUnit.SECONDS);
    assertThat(gate.awaitDrained(Duration.ZERO)).isTrue();

    var otherGate = new RestoreMaintenanceGate();
    var otherFilter =
        new LocalApiBoundaryFilter(new ArgusProperties(null, null, "test", "token"), otherGate);
    assertThatThrownBy(
            () ->
                otherFilter.doFilter(
                    request("GET", "/api/workspace"),
                    new MockHttpServletResponse(),
                    (req, res) -> {
                      throw new ServletException("fixture");
                    }))
        .isInstanceOf(ServletException.class);
    assertThat(otherGate.activeRequests()).isZero();
  }

  @Test
  void maintenanceBlocksEveryOrdinaryApiAndMcpButKeepsAuthenticatedBackupAndHealth()
      throws Exception {
    gate.beginRestore();
    for (String route :
        List.of(
            "/api/workspace",
            "/api/backup/restore",
            "/api/context",
            "/api/repositories/r/terminal/start",
            "/mcp")) {
      var response = new MockHttpServletResponse();
      var chain = new MockFilterChain();
      filter.doFilter(request("POST", route), response, chain);
      assertThat(response.getStatus()).isEqualTo(503);
      assertThat(chain.getRequest()).isNull();
    }
    for (String route : List.of(RestoreMaintenanceGate.HEALTH)) {
      var unauthorized = new MockHttpServletResponse();
      filter.doFilter(request("POST", route), unauthorized, new MockFilterChain());
      assertThat(unauthorized.getStatus()).isEqualTo(401);
      var authorized = request("POST", route);
      authorized.addHeader("Authorization", "Bearer fixture-token");
      var chain = new MockFilterChain();
      filter.doFilter(authorized, new MockHttpServletResponse(), chain);
      assertThat(chain.getRequest()).isSameAs(authorized);
    }
  }

  @Test
  void serviceQuiescesAllProducersAndReportsRestartEvenWhenOneFails() {
    var work = mock(BackendQuiescence.class);
    doThrow(new IllegalStateException("fixture failure")).when(work).quiesce();
    var service = new RestoreMaintenanceService(gate, work);
    var controller = new RestoreMaintenanceController(service, gate);
    var response = controller.restore();
    assertThat(response.getStatusCode().value()).isEqualTo(503);
    assertThat(response.getBody().restartRequired()).isTrue();
    assertThat(response.getBody().ok()).isFalse();
    assertThat(gate.isMaintenance()).isTrue();
    assertThat(controller.restore().getStatusCode().value()).isEqualTo(409);
    verify(work, times(1)).quiesce();
  }

  @Test
  void successfulRestorePreparationLeavesMaintenanceUntilRestart() {
    var service = new RestoreMaintenanceService(gate, mock(BackendQuiescence.class));
    var controller = new RestoreMaintenanceController(service, gate);
    var response = controller.restore();
    assertThat(response.getStatusCode().value()).isEqualTo(200);
    assertThat(response.getBody().ok()).isTrue();
    assertThat(response.getBody().restartRequired()).isTrue();
    assertThat(controller.health())
        .containsEntry("maintenance", true)
        .containsEntry("activeRequests", 0);
  }

  private static MockHttpServletRequest request(String method, String path) {
    var request = new MockHttpServletRequest(method, path);
    request.setRemoteAddr("127.0.0.1");
    request.setLocalPort(4173);
    request.addHeader("Host", "127.0.0.1:4173");
    return request;
  }
}
