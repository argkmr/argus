package com.argus.git.dto;

public record GitStashResponse(
    boolean ok,
    String status,
    GitStashEntry stash,
    boolean applied,
    boolean dropped,
    boolean stashRetained,
    String message) {}
