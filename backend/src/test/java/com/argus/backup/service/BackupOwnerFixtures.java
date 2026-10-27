package com.argus.backup.service;

import static org.mockito.Mockito.*;

final class BackupOwnerFixtures {
  private BackupOwnerFixtures() {}

  static BackupOwnerAccess allowed() {
    var owner = mock(BackupOwnerAccess.class);
    when(owner.allowed()).thenReturn(true);
    return owner;
  }
}
