package com.argus.documents.service;

import com.argus.common.process.CommandRunner;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/** An explicit local UI action, separate from side-effect-free reference metadata reads. */
@Service
public class SourceReferenceRevealService {
  private final SourceReferenceService sources;
  private final CommandRunner commands;

  public SourceReferenceRevealService(SourceReferenceService sources, CommandRunner commands) {
    this.sources = sources;
    this.commands = commands;
  }

  public Map<String, Object> reveal(String target, String repositoryId) {
    var directory = sources.directory(target, repositoryId);
    if (!supportsFinder())
      throw new ResponseStatusException(
          HttpStatus.NOT_IMPLEMENTED,
          "Show in Finder is available on macOS. Copy the folder path to open it in your file manager.");
    try {
      if (!directory.equals(directory.toRealPath())
          || !Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS))
        throw new IOException("Directory changed");
    } catch (IOException error) {
      throw new ResponseStatusException(
          HttpStatus.CONFLICT, "This folder changed location. Open the reference again.");
    }
    try {
      // Reveal rather than open: even a directory named *.app must never launch code.
      // Pass an absolute canonical path as a single argument, never through a shell.
      var result =
          commands.run(
              "/usr/bin/open",
              List.of("-R", "--", directory.toString()),
              null,
              Duration.ofSeconds(10));
      if (result == null || result.exitCode() != 0)
        throw new IllegalStateException("Finder failed");
    } catch (RuntimeException error) {
      throw new ResponseStatusException(
          HttpStatus.BAD_GATEWAY,
          "Finder could not show this folder. Try again or copy the folder path.");
    }
    return Map.of("opened", true, "path", directory.toString());
  }

  protected boolean supportsFinder() {
    return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("mac");
  }
}
