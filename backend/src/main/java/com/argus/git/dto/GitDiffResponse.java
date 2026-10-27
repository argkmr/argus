package com.argus.git.dto;

public record GitDiffResponse(
    String diff,
    String beforeContent,
    String afterContent,
    boolean binary,
    GitRevertAvailability revert,
    java.util.List<GitDiffChange> changes) {
  public GitDiffResponse(
      String diff,
      String beforeContent,
      String afterContent,
      boolean binary,
      GitRevertAvailability revert) {
    this(diff, beforeContent, afterContent, binary, revert, java.util.List.of());
  }

  public GitDiffResponse(String diff, String beforeContent, String afterContent, boolean binary) {
    this(diff, beforeContent, afterContent, binary, null);
  }
}
