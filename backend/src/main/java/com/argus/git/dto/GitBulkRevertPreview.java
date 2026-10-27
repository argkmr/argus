package com.argus.git.dto;

import java.util.List;

public record GitBulkRevertPreview(
    boolean allowed, String reason, List<File> files, String recoveryDirectory, int maxFiles) {
  public record File(
      String file,
      boolean staged,
      boolean allowed,
      String reason,
      String revision,
      String baseline,
      String target) {}
}
