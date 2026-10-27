package com.argus.git.dto;

public record GitFileActionPreview(
    String file,
    String action,
    boolean allowed,
    String reason,
    String revision,
    boolean staged,
    boolean workingFileExists,
    String recoveryDirectory) {}
