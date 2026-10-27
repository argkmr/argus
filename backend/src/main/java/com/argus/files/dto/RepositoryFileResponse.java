package com.argus.files.dto;

public record RepositoryFileResponse(String file, String content, String contentHash, long size) {}
