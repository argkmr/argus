package com.argus.platform;

import java.time.Duration;
import org.springframework.stereotype.Component;

/** An irreversible, process-local gate: restoring disk state requires a fresh JVM afterward. */
@Component
public class RestoreMaintenanceGate {
  public static final String RESTORE = "/api/internal/maintenance/restore";
  public static final String HEALTH = "/api/internal/maintenance/health";
  public static final String SHUTDOWN = "/api/internal/maintenance/shutdown";

  public enum Admission {
    TRACKED,
    UNTRACKED,
    RESTORE_INITIATOR,
    MAINTENANCE,
    CONCURRENT_RESTORE
  }

  private boolean maintenance;
  private boolean restoreRequestActive;
  private int activeRequests;

  public static boolean internalRoute(String route) {
    return route.equals(RESTORE) || route.equals(SHUTDOWN) || route.equals(HEALTH);
  }

  public static boolean apiRoute(String route) {
    return route.equals("/api")
        || route.startsWith("/api/")
        || route.equals("/mcp")
        || route.startsWith("/mcp/");
  }

  public synchronized Admission beginRequest(String method, String route) {
    if (!apiRoute(route) || internalRoute(route)) return Admission.UNTRACKED;
    if (maintenance) return Admission.MAINTENANCE;
    if ("POST".equals(method) && "/api/backup/restore".equals(route)) {
      if (restoreRequestActive) return Admission.CONCURRENT_RESTORE;
      restoreRequestActive = true;
      // The restore initiator invokes Java quiescence directly; it cannot wait on itself.
      return Admission.RESTORE_INITIATOR;
    }
    activeRequests++;
    return Admission.TRACKED;
  }

  public synchronized void endRequest(Admission admission) {
    if (admission == Admission.TRACKED) activeRequests--;
    if (admission == Admission.RESTORE_INITIATOR) restoreRequestActive = false;
    notifyAll();
  }

  public synchronized boolean beginRestore() {
    if (maintenance) return false;
    maintenance = true;
    return true;
  }

  public synchronized boolean isMaintenance() {
    return maintenance;
  }

  public synchronized int activeRequests() {
    return activeRequests;
  }

  public synchronized boolean restoreRequestActive() {
    return restoreRequestActive;
  }

  public synchronized boolean awaitDrained(Duration timeout) {
    long deadline = System.nanoTime() + timeout.toNanos();
    while (activeRequests > 0) {
      long remaining = deadline - System.nanoTime();
      if (remaining <= 0) return false;
      try {
        wait(Math.max(1, Math.min(100, remaining / 1_000_000)));
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        return false;
      }
    }
    return true;
  }
}
