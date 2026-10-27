package com.argus.git.dto;

/** One adjacent +/- block. Starts are one-based; zero count denotes an insertion gap. */
public record GitDiffChange(
    String id, int beforeStart, int beforeCount, int afterStart, int afterCount) {}
