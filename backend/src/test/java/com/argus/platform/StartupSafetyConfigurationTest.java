package com.argus.platform;

import static org.junit.jupiter.api.Assertions.*;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.core.env.MapPropertySource;

class StartupSafetyConfigurationTest {
  @TempDir Path root;

  @Test
  void interruptedRestoreBlocksBeforeAnyCachedStoreIsCreated() throws Exception {
    var record = root.resolve("maintenance/.restore-recovery/01234567-89ab-4cde-8fab-0123456789ab");
    Files.createDirectories(record);
    Files.writeString(record.resolve("status.json"), "{\"version\":1,\"status\":\"applying\"}");
    var created = new AtomicBoolean();
    try (var context = new AnnotationConfigApplicationContext()) {
      context
          .getEnvironment()
          .getPropertySources()
          .addFirst(
              new MapPropertySource(
                  "isolated",
                  java.util.Map.of(
                      "argus.data-directory",
                      root.toString(),
                      "ARGUS_MAINTENANCE_DATA_DIR",
                      root.resolve("maintenance").toString())));
      context.register(StartupSafetyConfiguration.class);
      context.registerBean(
          "cachedStore",
          Object.class,
          () -> {
            created.set(true);
            return new Object();
          });
      assertThrows(RuntimeException.class, context::refresh);
      assertFalse(created.get());
      assertTrue(Files.exists(record.resolve("status.json")));
    }
  }
}
