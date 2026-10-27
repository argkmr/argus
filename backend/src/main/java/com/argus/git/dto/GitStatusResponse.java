package com.argus.git.dto;

import java.util.List;

public record GitStatusResponse(
    String branch,
    String remote,
    int ahead,
    int behind,
    List<GitFileStatus> files,
    boolean detached) {
  public GitStatusResponse(
      String branch, String remote, int ahead, int behind, List<GitFileStatus> files) {
    this(branch, remote, ahead, behind, files, false);
  }
}
