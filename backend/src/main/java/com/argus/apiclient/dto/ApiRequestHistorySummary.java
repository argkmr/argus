package com.argus.apiclient.dto;

/** Only lightweight display fields; full headers and bodies are loaded on explicit restore. */
public record ApiRequestHistorySummary(
    String id,
    String createdAt,
    String updatedAt,
    String kind,
    String name,
    String method,
    String url,
    Integer status) {}
