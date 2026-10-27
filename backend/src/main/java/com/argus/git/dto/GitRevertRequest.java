package com.argus.git.dto;

public record GitRevertRequest(
    String file, boolean staged, String expectedRevision, String changeId) {
  public GitRevertRequest(String file, boolean staged, String expectedRevision) {
    this(file, staged, expectedRevision, null);
  }
}
