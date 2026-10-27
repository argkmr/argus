package com.argus.apiclient.dto;

import tools.jackson.databind.JsonNode;

/** A private, local snapshot. It is deliberately separate from portable API collections. */
public record ApiRequestHistoryEntry(
    String id, String createdAt, String updatedAt, JsonNode snapshot) {}
