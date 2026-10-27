package com.argus.files.controller;

import com.argus.common.constants.ApiRoutes;
import com.argus.files.dto.RepositoryFileResponse;
import com.argus.files.dto.SearchResult;
import com.argus.files.dto.WriteFileRequest;
import com.argus.files.service.RepositoryFileService;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(ApiRoutes.API)
public class RepositoryFileController {
  private final RepositoryFileService files;
  private final WorkspaceService workspace;

  public RepositoryFileController(RepositoryFileService files, WorkspaceService workspace) {
    this.files = files;
    this.workspace = workspace;
  }

  private Path root(String id) {
    return Path.of(workspace.requireRepository(id).path());
  }

  @GetMapping("/repositories/{id}/files")
  public List<String> list(@PathVariable String id) {
    return files.list(root(id), 2000);
  }

  @GetMapping("/repositories/{id}/file")
  public RepositoryFileResponse read(@PathVariable String id, @RequestParam("path") String path) {
    return files.read(root(id), path);
  }

  @PutMapping("/repositories/{id}/file")
  public RepositoryFileResponse write(
      @PathVariable String id, @RequestBody WriteFileRequest request) {
    return files.write(root(id), request.path(), request.content(), request.expectedHash());
  }

  @GetMapping("/repositories/{id}/search")
  public List<SearchResult> search(@PathVariable String id, @RequestParam("q") String query) {
    return files.search(root(id), query, 200);
  }

  @GetMapping("/search")
  public List<Map<String, Object>> global(@RequestParam("q") String query) {
    return workspace.snapshot().repositories().stream()
        .map(
            repository ->
                Map.<String, Object>of(
                    "repository",
                    repository,
                    "results",
                    files.search(Path.of(repository.path()), query, 60)))
        .toList();
  }
}
