package com.argus.runtime.controller;

import com.argus.runtime.service.PortInventoryService;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class PortInventoryController {
  private final PortInventoryService ports;

  public PortInventoryController(PortInventoryService ports) {
    this.ports = ports;
  }

  @GetMapping("/api/runtime-ports")
  public Map<String, Object> ports() {
    return ports.snapshot();
  }
}
