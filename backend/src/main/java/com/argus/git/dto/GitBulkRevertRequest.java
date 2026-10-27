package com.argus.git.dto;

import java.util.List;

/** Revisions are optional for preview, required for apply; patches are never client supplied. */
public record GitBulkRevertRequest(List<File> files) {
  public record File(String file, Boolean staged, String expectedRevision) {
    public File(String file, boolean staged) {
      this(file, staged, null);
    }
  }
}
