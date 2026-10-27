package com.argus.git.dto;

public record GitBranch(
    String name, String ref, String type, boolean current, String upstream, boolean selectable) {}
