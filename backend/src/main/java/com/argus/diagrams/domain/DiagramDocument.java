package com.argus.diagrams.domain;

import tools.jackson.databind.JsonNode;

/** The snapshot is inert local JSON; no embedded asset or URL is evaluated by the server. */
public record DiagramDocument(
    String id,
    String name,
    long revision,
    int schemaVersion,
    String createdAt,
    String updatedAt,
    boolean archived,
    JsonNode snapshot) {}
