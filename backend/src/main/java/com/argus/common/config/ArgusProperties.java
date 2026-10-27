package com.argus.common.config;

import java.nio.file.Path;
import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "argus")
public record ArgusProperties(
    Path dataDirectory, Path sourceRoot, String buildId, String mcpToken) {}
