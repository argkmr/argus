package com.argus.platform;

import com.argus.backup.service.RestoreRecoveryGuard;
import java.nio.file.Path;
import org.springframework.beans.factory.config.BeanFactoryPostProcessor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import tools.jackson.databind.json.JsonMapper;

@Configuration(proxyBeanMethods = false)
public class StartupSafetyConfiguration {
  /** Runs before singleton construction, so no cached store opens an interrupted restore. */
  @Bean
  static BeanFactoryPostProcessor verifyRestoreRecoveryBeforeOpeningStores(
      Environment environment) {
    return ignored -> {
      Path data =
          Path.of(
              environment.getProperty(
                  "argus.data-directory",
                  Path.of(
                          System.getProperty("user.home"),
                          "Library",
                          "Application Support",
                          "Argus Personal")
                      .toString()));
      String configured = environment.getProperty("ARGUS_MAINTENANCE_DATA_DIR", "");
      Path maintenance =
          configured.isBlank()
              ? data.resolveSibling("Argus Personal Maintenance")
              : Path.of(configured);
      RestoreRecoveryGuard.assertSafe(maintenance, JsonMapper.builder().build());
    };
  }
}
