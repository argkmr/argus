package com.argus.files.dto;

public record WriteFileRequest(String path, String content, String expectedHash) {}
