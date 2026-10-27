package com.argus.tasks.domain;

/** A user-owned navigation marker whose saved message remains readable after history compaction. */
public record TaskCheckpoint(String messageId, String markedAt, TaskMessage message) {}
