package com.argus.git.dto;

public record GitRevertAvailability(
    boolean allowed, String reason, String revision, String baseline, String target) {}
