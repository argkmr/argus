package com.argus.backup.service;

import java.nio.file.*;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

@Service
public class GoogleDriveDetector {
  public Map<String, Object> detect() {
    return detect(
        Path.of(System.getProperty("user.home")),
        System.getProperty("os.name", "").toLowerCase().contains("mac"));
  }

  Map<String, Object> detect(Path home, boolean mac) {
    List<Map<String, String>> candidates = List.of();
    Path cloud = home.resolve("Library/CloudStorage");
    if (mac && Files.isDirectory(cloud, LinkOption.NOFOLLOW_LINKS))
      try (var paths = Files.list(cloud)) {
        candidates =
            paths
                .filter(
                    path ->
                        path.getFileName().toString().startsWith("GoogleDrive-")
                            && Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS))
                .filter(
                    path -> Files.isDirectory(path.resolve("My Drive"), LinkOption.NOFOLLOW_LINKS))
                .sorted()
                .map(
                    path ->
                        Map.of(
                            "path",
                            path.resolve("My Drive").toString(),
                            "account",
                            path.getFileName().toString().substring("GoogleDrive-".length())))
                .toList();
      } catch (java.io.IOException ignored) {
      }
    return Map.of(
        "path",
        candidates.size() == 1 ? candidates.get(0).get("path") : "",
        "account",
        candidates.size() == 1 ? candidates.get(0).get("account") : "",
        "detected",
        candidates.size() == 1,
        "ambiguous",
        candidates.size() > 1,
        "candidates",
        candidates);
  }
}
