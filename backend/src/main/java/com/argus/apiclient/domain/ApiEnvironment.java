package com.argus.apiclient.domain;

import java.util.Map;

public record ApiEnvironment(
    String id, String name, Map<String, String> values, String createdAt, String updatedAt) {}
