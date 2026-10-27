package com.argus.common.config;

import com.argus.platform.RequestBodyLimitFilter;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.jackson.autoconfigure.JsonMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Scope;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.json.JsonMapper;

@Configuration(proxyBeanMethods = false)
public class JsonLimitsConfiguration {
  /** A 50MB attachment's base64 exceeds Jackson's default 20M string limit. */
  @Bean
  @Scope("prototype")
  JsonMapper.Builder jsonMapperBuilder(ObjectProvider<JsonMapperBuilderCustomizer> customizers) {
    var factory =
        JsonFactory.builder()
            .streamReadConstraints(
                StreamReadConstraints.builder()
                    .maxStringLength(RequestBodyLimitFilter.ATTACHMENT_LIMIT)
                    .build())
            .build();
    var builder = JsonMapper.builder(factory);
    customizers.orderedStream().forEach(customizer -> customizer.customize(builder));
    return builder;
  }
}
