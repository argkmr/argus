package com.argus.context.controller;

import com.argus.context.service.ContextPreviewService;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/context")
public class ContextPreviewController {
  private final ContextPreviewService previews;

  public ContextPreviewController(ContextPreviewService previews) {
    this.previews = previews;
  }

  @GetMapping("/{id}/preview")
  public ResponseEntity<Map<String, Object>> preview(@PathVariable String id) {
    return ResponseEntity.ok().header("Cache-Control", "no-store").body(previews.preview(id));
  }

  @GetMapping("/{id}/content")
  public ResponseEntity<byte[]> content(
      @PathVariable String id,
      @RequestParam(defaultValue = "false") boolean download,
      @RequestParam(required = false) String preview) {
    var content = previews.content(id, download, preview);
    var response = ResponseEntity.ok();
    content.headers().forEach(response::header);
    return response.body(content.bytes());
  }
}
