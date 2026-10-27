package com.argus.ide.debug;

import java.util.Map;

interface DebugSession extends AutoCloseable {
  Map<String, Object> command(String command, Map<String, Object> arguments);

  boolean alive();

  @Override
  void close();
}
