package com.argus.codediscussions.controller;

import com.argus.codediscussions.service.CodeDiscussionService;
import com.argus.common.constants.ApiRoutes;
import java.util.Map;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(ApiRoutes.REPOSITORIES + "/{repositoryId}/code-discussions")
public class CodeDiscussionController {
  private final CodeDiscussionService discussions;

  public CodeDiscussionController(CodeDiscussionService discussions) {
    this.discussions = discussions;
  }

  @GetMapping
  public Map<String, Object> index(@PathVariable String repositoryId) {
    return discussions.index(repositoryId);
  }

  @GetMapping("/{discussionId}")
  public Map<String, Object> detail(
      @PathVariable String repositoryId, @PathVariable String discussionId) {
    return discussions.detail(repositoryId, discussionId);
  }

  @PostMapping("/ask")
  public Map<String, Object> ask(
      @PathVariable String repositoryId, @RequestBody Map<String, Object> request) {
    return discussions.ask(repositoryId, request);
  }
}
