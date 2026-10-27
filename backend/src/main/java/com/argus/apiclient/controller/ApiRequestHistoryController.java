package com.argus.apiclient.controller;

import com.argus.apiclient.dto.ApiRequestHistoryEntry;
import com.argus.apiclient.dto.ApiRequestHistorySummary;
import com.argus.apiclient.service.ApiRequestHistoryService;
import com.argus.common.constants.ApiRoutes;
import java.util.List;
import java.util.Map;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import tools.jackson.databind.JsonNode;

@RestController
@RequestMapping(ApiRoutes.API_REQUEST_HISTORY)
public class ApiRequestHistoryController {
  private final ApiRequestHistoryService history;

  public ApiRequestHistoryController(ApiRequestHistoryService history) {
    this.history = history;
  }

  @GetMapping
  public ResponseEntity<List<ApiRequestHistorySummary>> list() {
    return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(history.list());
  }

  @PostMapping
  public ResponseEntity<ApiRequestHistorySummary> save(@RequestBody JsonNode payload) {
    return ResponseEntity.status(HttpStatus.CREATED)
        .cacheControl(CacheControl.noStore())
        .body(history.save(payload));
  }

  @GetMapping("/{id}")
  public ResponseEntity<ApiRequestHistoryEntry> get(@PathVariable String id) {
    return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(history.get(id));
  }

  @DeleteMapping("/{id}")
  public Map<String, Object> delete(@PathVariable String id) {
    return history.delete(id);
  }
}
