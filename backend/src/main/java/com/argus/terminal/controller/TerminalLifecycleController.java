package com.argus.terminal.controller;

import com.argus.terminal.service.TerminalService;
import java.util.Map;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/terminals")
public class TerminalLifecycleController {
  private final TerminalService terminals;

  public TerminalLifecycleController(TerminalService terminals) {
    this.terminals = terminals;
  }

  @PostMapping("/purge-all")
  public Map<String, Boolean> purgeAll() {
    terminals.stopAll();
    return Map.of("ok", true);
  }
}
