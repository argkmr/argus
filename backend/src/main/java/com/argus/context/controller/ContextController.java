package com.argus.context.controller;

import com.argus.browser.service.BrowserPairingService;
import com.argus.common.constants.ApiRoutes;
import com.argus.context.domain.ContextAttachment;
import com.argus.context.dto.SaveContextRequest;
import com.argus.context.service.ContextService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping(ApiRoutes.API)
public class ContextController {
  private final ContextService contexts;
  private final BrowserPairingService pairing;

  public ContextController(ContextService contexts, BrowserPairingService pairing) {
    this.contexts = contexts;
    this.pairing = pairing;
  }

  @PostMapping("/context")
  public ResponseEntity<ContextAttachment> save(@RequestBody SaveContextRequest request) {
    return ResponseEntity.status(HttpStatus.CREATED).body(contexts.save(request));
  }

  @PostMapping("/browser-context")
  public ResponseEntity<?> browser(
      @RequestBody SaveContextRequest request, HttpServletRequest httpRequest) throws Exception {
    String origin = httpRequest.getHeader("Origin");
    if (origin != null && origin.startsWith("chrome-extension://")) {
      String authorization = httpRequest.getHeader("Authorization");
      String token = authorization == null ? "" : authorization.replaceFirst("(?i)^Bearer\\s+", "");
      if (!pairing.verify(token))
        throw new ResponseStatusException(
            HttpStatus.UNAUTHORIZED, "Pair this Chrome extension with Argus before sharing a tab");
    }
    return save(
        new SaveContextRequest(
            "browser",
            request.title(),
            request.url(),
            request.content(),
            null,
            null,
            request.repositoryId()));
  }

  @GetMapping("/browser-context/latest")
  public ContextAttachment latest() {
    return contexts.latestBrowser();
  }
}
