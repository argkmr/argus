package com.argus.terminal.dto;

public record TerminalResizeRequest(String sessionId, int cols, int rows) {}
