package com.argus.agents.service;

/** A rejected delivery is retryable by the user; an uncertain delivery must never be replayed. */
public final class SteerDeliveryException extends IllegalStateException {
  private final boolean outcomeUnknown;

  public SteerDeliveryException(String message, boolean outcomeUnknown) {
    super(message);
    this.outcomeUnknown = outcomeUnknown;
  }

  public boolean outcomeUnknown() {
    return outcomeUnknown;
  }
}
