package com.argus.repositorycontext.service;

import static com.argus.runtime.service.RuntimeData.*;
import static org.assertj.core.api.Assertions.*;

import com.argus.workspace.domain.Repository;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class AiKitCoverageServiceTest {
  @TempDir Path root;

  @Test
  void nativeInventoryCoversCommonJsEsModulesAndIgnoresGeneratedOrEscapingFiles() throws Exception {
    Path repo = Files.createDirectories(root.resolve("source"));
    Files.writeString(
        repo.resolve("routes.mjs"),
        "app.get('/route', handler);\ncron.schedule('* * * * *', work);\n");
    Files.writeString(repo.resolve("commands.cjs"), "program.command('run');\n");
    Path generated = Files.createDirectories(repo.resolve("node_modules"));
    Files.writeString(generated.resolve("vendor.js"), "app.get('/ignored', handler);\n");
    Path outside = root.resolve("outside.java");
    Files.writeString(outside, "@GetMapping(\"/outside\")\n");
    Files.createSymbolicLink(repo.resolve("escape.java"), outside);
    var coverage = new AiKitCoverageService(new ObjectMapper());
    var repository = new Repository("fixture", "fixture", repo.toString(), "now", "main");
    var inventory = coverage.inventory(repository);
    assertThat(
            list(inventory.get("entryPoints")).stream()
                .map(
                    value ->
                        text(map(value), "type")
                            + ":"
                            + text(map(map(value).get("source")), "path"))
                .toList())
        .containsExactly("command:commands.cjs", "http:routes.mjs", "scheduled-job:routes.mjs");
    assertThat(coverage.inventory(repository).get("fingerprint"))
        .isEqualTo(inventory.get("fingerprint"));
  }
}
