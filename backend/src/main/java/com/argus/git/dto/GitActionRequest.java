package com.argus.git.dto;

import java.util.List;

public record GitActionRequest(
    List<String> files, String message, String branch, String name, String startPoint) {}
