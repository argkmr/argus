package com.argus.common.process;

public record CommandResult(String stdout, String stderr, int exitCode) {}
