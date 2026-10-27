package com.argus.git.dto;

public record GitRevertResponse(
    boolean ok,
    String file,
    boolean staged,
    String restoredFrom,
    String target,
    String revision,
    String recoveryId,
    boolean refreshRequired) {
  public GitRevertResponse(
      boolean ok,
      String file,
      boolean staged,
      String restoredFrom,
      String target,
      String revision,
      String recoveryId) {
    this(ok, file, staged, restoredFrom, target, revision, recoveryId, false);
  }
}
