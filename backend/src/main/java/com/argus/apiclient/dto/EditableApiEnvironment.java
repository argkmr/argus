package com.argus.apiclient.dto;

import java.util.Map;

public record EditableApiEnvironment(
    String id,
    String name,
    Map<String, String> values,
    String createdAt,
    String updatedAt,
    String valuesText) {}
