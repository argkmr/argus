package com.argus.git.dto;

public record GitActionResponse(boolean ok, String output, String error, String pullRequestUrl) {
  public static GitActionResponse of(String output, String error) {
    return new GitActionResponse(true, output, error, "");
  }
}
