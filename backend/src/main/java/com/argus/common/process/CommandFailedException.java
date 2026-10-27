package com.argus.common.process;

public final class CommandFailedException extends IllegalStateException {
  private final CommandResult result;

  public CommandFailedException(String message, CommandResult result) {
    super(message);
    this.result = result;
  }

  public CommandResult result() {
    return result;
  }
}
