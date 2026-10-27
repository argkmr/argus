package com.argus.runtime.service;

/** A declared runtime must never silently fall back to a different installed version. */
public class RuntimeCompatibilityException extends IllegalArgumentException {
  public RuntimeCompatibilityException(String message) {
    super(message);
  }
}
