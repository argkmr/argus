package com.argus.context.domain;

public record ContextAttachment(
    String id,
    String kind,
    String title,
    String url,
    String path,
    long size,
    String mimeType,
    String repositoryId,
    String createdAt) {}
