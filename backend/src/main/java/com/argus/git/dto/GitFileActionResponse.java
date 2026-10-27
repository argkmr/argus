package com.argus.git.dto;

import java.util.List;

/** A partial success is never represented as a failed request that invites replay. */
public record GitFileActionResponse(
    boolean ok,
    String file,
    String action,
    boolean refreshRequired,
    String message,
    List<String> recoveryIds,
    List<String> recoveryPaths) {}
