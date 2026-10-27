package com.argus.git.dto;

import java.util.List;

public record GitBulkRevertResponse(
    boolean ok,
    boolean partial,
    String message,
    List<Result> results,
    List<String> recoveryPaths,
    boolean refreshRequired) {
  public record Result(
      String file,
      boolean staged,
      String status,
      String revision,
      String recoveryId,
      String message) {}
}
