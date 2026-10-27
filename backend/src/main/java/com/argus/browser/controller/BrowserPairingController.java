package com.argus.browser.controller;

import com.argus.browser.service.BrowserPairingService;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/browser-extension")
public class BrowserPairingController {
  private final BrowserPairingService pairing;

  public BrowserPairingController(BrowserPairingService pairing) {
    this.pairing = pairing;
  }

  @GetMapping("/status")
  public Map<String, Object> status() {
    return pairing.status();
  }

  @PostMapping("/pair/start")
  @ResponseStatus(HttpStatus.CREATED)
  public Map<String, Object> start() {
    return pairing.start();
  }

  @PostMapping("/pair/complete")
  public Map<String, String> complete(@RequestBody Map<String, Object> input) {
    return pairing.complete(String.valueOf(input.getOrDefault("code", "")));
  }
}
