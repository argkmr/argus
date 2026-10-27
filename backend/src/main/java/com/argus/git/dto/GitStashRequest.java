package com.argus.git.dto;

public record GitStashRequest(String message, Boolean includeUntracked) {
  public GitStashRequest {
    // Jackson 3 rejects a missing primitive creator value before the controller can apply defaults.
    // Only an explicit true opts into moving untracked files; missing/null stays tracked-only.
    includeUntracked = Boolean.TRUE.equals(includeUntracked);
  }
}
