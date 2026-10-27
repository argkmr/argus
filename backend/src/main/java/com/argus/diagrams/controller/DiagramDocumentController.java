package com.argus.diagrams.controller;

import com.argus.diagrams.domain.DiagramDocument;
import com.argus.diagrams.domain.DiagramSummary;
import com.argus.diagrams.service.DiagramDocumentService;
import java.util.List;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import tools.jackson.databind.JsonNode;

@RestController
@RequestMapping("/api/diagrams")
public class DiagramDocumentController {
  private final DiagramDocumentService diagrams;

  public DiagramDocumentController(DiagramDocumentService diagrams) {
    this.diagrams = diagrams;
  }

  @GetMapping
  public ResponseEntity<List<DiagramSummary>> list(
      @RequestParam(defaultValue = "false") boolean archived) {
    return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(diagrams.list(archived));
  }

  @GetMapping("/{id}")
  public ResponseEntity<DiagramDocument> get(@PathVariable String id) {
    return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(diagrams.get(id));
  }

  @PostMapping
  public ResponseEntity<DiagramDocument> create(@RequestBody JsonNode request) {
    return ResponseEntity.status(HttpStatus.CREATED)
        .cacheControl(CacheControl.noStore())
        .body(diagrams.create(request));
  }

  @PutMapping("/{id}")
  public ResponseEntity<DiagramDocument> update(
      @PathVariable String id, @RequestBody JsonNode request) {
    return ResponseEntity.ok()
        .cacheControl(CacheControl.noStore())
        .body(diagrams.update(id, request));
  }

  @DeleteMapping("/{id}")
  public ResponseEntity<DiagramSummary> archive(
      @PathVariable String id, @RequestParam(required = false) Long revision) {
    return ResponseEntity.ok()
        .cacheControl(CacheControl.noStore())
        .body(diagrams.archive(id, revision));
  }

  @PostMapping("/{id}/restore")
  public ResponseEntity<DiagramDocument> restore(
      @PathVariable String id, @RequestBody JsonNode request) {
    return ResponseEntity.ok()
        .cacheControl(CacheControl.noStore())
        .body(diagrams.restore(id, request));
  }

  @DeleteMapping("/{id}/permanent")
  public ResponseEntity<Void> deletePermanently(
      @PathVariable String id, @RequestParam(required = false) Long revision) {
    diagrams.deletePermanently(id, revision);
    return ResponseEntity.noContent().cacheControl(CacheControl.noStore()).build();
  }
}
