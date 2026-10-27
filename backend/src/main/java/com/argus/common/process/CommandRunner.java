package com.argus.common.process;

import java.nio.file.Path;
import java.time.Duration;
import java.util.List;

public interface CommandRunner {
  CommandResult run(
      String executable, List<String> arguments, Path workingDirectory, Duration timeout);
}
