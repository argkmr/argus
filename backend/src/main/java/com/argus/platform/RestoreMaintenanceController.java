package com.argus.platform;

import com.argus.common.error.ConflictException;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class RestoreMaintenanceController {
  private final RestoreMaintenanceService service;
  private final RestoreMaintenanceGate gate;

  public RestoreMaintenanceController(
      RestoreMaintenanceService service, RestoreMaintenanceGate gate) {
    this.service = service;
    this.gate = gate;
  }

  @PostMapping(RestoreMaintenanceGate.RESTORE)
  public ResponseEntity<RestoreMaintenanceService.Result> restore() {
    try {
      var result = service.enter();
      return ResponseEntity.status(result.ok() ? 200 : 503).body(result);
    } catch (ConflictException error) {
      return ResponseEntity.status(409)
          .body(new RestoreMaintenanceService.Result(false, true, error.getMessage()));
    }
  }

  @PostMapping(RestoreMaintenanceGate.SHUTDOWN)
  public ResponseEntity<RestoreMaintenanceService.Result> shutdown() {
    var result = service.shutdown();
    return ResponseEntity.status(result.ok() ? 200 : 503).body(result);
  }

  @GetMapping(RestoreMaintenanceGate.HEALTH)
  public Map<String, Object> health() {
    return Map.of(
        "maintenance",
        gate.isMaintenance(),
        "restartRequired",
        gate.isMaintenance(),
        "activeRequests",
        gate.activeRequests());
  }
}
