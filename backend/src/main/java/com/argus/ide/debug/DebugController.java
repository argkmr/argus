package com.argus.ide.debug;

import java.util.Map;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/repositories/{id}/ide/debug")
public class DebugController {
  private final DebugService debugger;

  public DebugController(DebugService debugger) {
    this.debugger = debugger;
  }

  @GetMapping("/status")
  public Map<String, Object> status(@PathVariable String id) {
    return debugger.status(id);
  }

  @PostMapping("/attach")
  public Map<String, Object> attach(
      @PathVariable String id, @RequestBody Map<String, Object> input) {
    return debugger.attach(id, input);
  }

  @PostMapping("/command")
  public Map<String, Object> command(
      @PathVariable String id, @RequestBody Map<String, Object> input) {
    return debugger.command(id, input);
  }

  @GetMapping("/events")
  public Map<String, Object> events(
      @PathVariable String id, @RequestParam(defaultValue = "0") long after) {
    return debugger.events(id, Math.max(0, after));
  }

  @DeleteMapping("/session")
  public Map<String, Object> detach(@PathVariable String id) {
    debugger.detach(id);
    return Map.of("ok", true);
  }
}
