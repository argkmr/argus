package com.argus.apiclient.dto;

import java.util.Map;

public record SaveApiEnvironmentRequest(
    String id, String name, Map<String, Object> values, String valuesText) {}
