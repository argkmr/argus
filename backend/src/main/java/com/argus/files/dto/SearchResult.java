package com.argus.files.dto;

public record SearchResult(String file, Integer line, Integer column, String preview) {}
