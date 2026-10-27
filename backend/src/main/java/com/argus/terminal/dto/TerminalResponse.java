package com.argus.terminal.dto;

import com.argus.terminal.domain.TerminalChunk;
import java.util.List;

public record TerminalResponse(
    String id,
    String repositoryId,
    String repositoryName,
    String cwd,
    String shell,
    boolean running,
    long cursor,
    List<TerminalChunk> chunks,
    boolean pty) {}
