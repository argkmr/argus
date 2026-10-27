package com.argus.git.dto;

public record GitFileStatus(
    String file,
    String index,
    String worktree,
    boolean staged,
    boolean changed,
    boolean untracked,
    String status) {}
