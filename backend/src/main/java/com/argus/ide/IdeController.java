package com.argus.ide;

import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/repositories/{id}/ide")
public class IdeController {
  private final IdeService ide;
  private final IdeFiles files;

  public record Save(String path, String content, String expectedHash) {}

  public record Navigate(String path, int line, int column, String kind, String expectedHash) {}

  public record StartLanguage(String language, boolean trustProject) {}

  public record ConfigureLanguage(String language, String executable, List<String> args) {}

  public IdeController(IdeService ide, IdeFiles files) {
    this.ide = ide;
    this.files = files;
  }

  @GetMapping("/status")
  public Map<String, Object> status(@PathVariable String id) {
    return ide.status(id);
  }

  @GetMapping("/tree")
  public IdeFiles.Tree tree(
      @PathVariable String id, @RequestParam(defaultValue = ".") String path) {
    return files.tree(ide.root(id), path);
  }

  @GetMapping("/file")
  public IdeFiles.FileContent read(@PathVariable String id, @RequestParam String path) {
    return files.read(ide.root(id), path);
  }

  @PutMapping("/file")
  public IdeFiles.FileContent write(@PathVariable String id, @RequestBody Save request) {
    return files.write(ide.root(id), request.path(), request.content(), request.expectedHash());
  }

  @GetMapping("/search")
  public IdeFiles.Search search(
      @PathVariable String id,
      @RequestParam String q,
      @RequestParam(defaultValue = "text") String kind) {
    return "symbols".equals(kind) ? ide.symbols(id, null, q) : files.search(ide.root(id), q, kind);
  }

  @GetMapping("/symbols")
  public IdeFiles.Search symbols(@PathVariable String id, @RequestParam String path) {
    return ide.symbols(id, path, "");
  }

  @PostMapping("/navigate")
  public IdeService.Navigation navigate(@PathVariable String id, @RequestBody Navigate request) {
    return ide.navigate(
        id,
        request.path(),
        request.line(),
        request.column(),
        request.kind(),
        request.expectedHash());
  }

  @PostMapping("/language/start")
  public Map<String, Object> start(@PathVariable String id, @RequestBody StartLanguage request) {
    return ide.start(id, request.language(), request.trustProject());
  }

  @PutMapping("/language/config")
  public Map<String, Object> configure(
      @PathVariable String id, @RequestBody ConfigureLanguage request) {
    return ide.configure(id, request.language(), request.executable(), request.args());
  }

  @PostMapping("/language/refresh")
  public Map<String, Object> refresh(@PathVariable String id) {
    return ide.refresh(id);
  }

  @DeleteMapping("/session")
  public Map<String, Object> close(@PathVariable String id) {
    ide.root(id);
    ide.closeRepository(id);
    return Map.of("stopped", true);
  }
}
