package com.argus.diagrams.domain;

/** Listing documents never transfers canvas snapshots or embedded image data. */
public record DiagramSummary(
    String id,
    String name,
    long revision,
    int schemaVersion,
    String createdAt,
    String updatedAt,
    boolean archived) {}
