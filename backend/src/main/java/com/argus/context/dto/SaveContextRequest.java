package com.argus.context.dto;

public record SaveContextRequest(
    String kind,
    String title,
    String url,
    String content,
    String contentBase64,
    String mimeType,
    String repositoryId) {}
