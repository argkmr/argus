package com.argus.documents.controller;

import com.argus.documents.service.SourceReferenceRevealService;
import com.argus.documents.service.SourceReferenceService;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/source-reference")
public class SourceReferenceController {
  private final SourceReferenceService sources;
  private final SourceReferenceRevealService reveal;

  public SourceReferenceController(
      SourceReferenceService sources, SourceReferenceRevealService reveal) {
    this.sources = sources;
    this.reveal = reveal;
  }

  @GetMapping
  public Map<String, Object> read(
      @RequestParam String target, @RequestParam(required = false) String repositoryId) {
    return sources.read(target, repositoryId);
  }

  public record RevealRequest(String target, String repositoryId) {}

  @PostMapping(value = "/reveal", consumes = "application/json")
  public Map<String, Object> reveal(@RequestBody RevealRequest request) {
    return reveal.reveal(request.target(), request.repositoryId());
  }

  @GetMapping("/content")
  public ResponseEntity<byte[]> content(
      @RequestParam String target,
      @RequestParam(required = false) String repositoryId,
      @RequestParam(defaultValue = "false") boolean download,
      @RequestParam(required = false) String preview) {
    var content = sources.content(target, repositoryId, download, preview);
    var response = ResponseEntity.ok();
    content.headers().forEach(response::header);
    return response.body(content.bytes());
  }
}
