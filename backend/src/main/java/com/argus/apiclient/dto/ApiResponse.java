package com.argus.apiclient.dto;

import java.util.Map;

public record ApiResponse(
    int status,
    String statusText,
    boolean ok,
    long durationMs,
    int sizeBytes,
    Map<String, String> headers,
    String body,
    String url) {}
