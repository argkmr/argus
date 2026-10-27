package com.argus.terminal.domain;

public record TerminalChunk(long cursor, String stream, String data) {}
