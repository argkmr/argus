package com.argus.platform;

import com.argus.common.error.ConflictException;
import java.time.Duration;
import org.springframework.stereotype.Service;

@Service
public class RestoreMaintenanceService {
  private final RestoreMaintenanceGate gate;
  private final BackendQuiescence nativeWork;

  public RestoreMaintenanceService(RestoreMaintenanceGate gate, BackendQuiescence nativeWork) {
    this.gate = gate;
    this.nativeWork = nativeWork;
  }

  public Result enter() {
    if (!gate.beginRestore()) throw new ConflictException("Restore maintenance is already active");
    return drain();
  }

  public Result shutdown() {
    gate.beginRestore();
    if (gate.restoreRequestActive())
      return new Result(
          false,
          true,
          "A backup restore is still in progress; wait for it to finish before quitting");
    return drain();
  }

  private Result drain() {
    boolean drained = gate.awaitDrained(Duration.ofSeconds(5));
    String error = drained ? "" : "Java requests have not finished; restore was not authorized";
    // Quiesce every independent producer even after a failure. The gate never reopens:
    // partially quiesced services and restored in-memory caches require a restart.
    try {
      nativeWork.quiesce();
    } catch (RuntimeException failure) {
      if (error.isEmpty())
        error = "A Java background operation could not be stopped; restore was not authorized";
    }
    return new Result(error.isEmpty(), true, error);
  }

  public record Result(boolean ok, boolean restartRequired, String error) {}
}
