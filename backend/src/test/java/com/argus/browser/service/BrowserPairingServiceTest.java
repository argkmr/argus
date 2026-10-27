package com.argus.browser.service;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.common.security.KeychainSecretStore;
import java.time.Clock;
import org.junit.jupiter.api.Test;

class BrowserPairingServiceTest {
  @Test
  void codesAreExpiringSingleUseAndBoundedByAttemptCount() {
    var secrets = mock(KeychainSecretStore.class);
    var clock = mock(Clock.class);
    when(clock.millis()).thenReturn(1000L);
    when(secrets.getLocal("browser-extension", "pairing-token")).thenReturn("existing-token");
    var service = new BrowserPairingService(secrets, clock);
    String code = service.start().get("code").toString();
    assertThat(service.complete(code)).containsEntry("token", "existing-token");
    String used = code;
    assertThatThrownBy(() -> service.complete(used)).hasMessageContaining("expired");
    verify(secrets, never()).setLocal(anyString(), anyString(), anyString());
    code = service.start().get("code").toString();
    for (int i = 0; i < 5; i++)
      assertThatThrownBy(() -> service.complete("wrong")).hasMessageContaining("incorrect");
    String correct = code;
    assertThatThrownBy(() -> service.complete(correct)).hasMessageContaining("expired");
    code = service.start().get("code").toString();
    when(clock.millis()).thenReturn(301001L);
    String expired = code;
    assertThatThrownBy(() -> service.complete(expired)).hasMessageContaining("expired");
    assertThat(service.verify("wrong")).isFalse();
    assertThat(service.verify("existing-token")).isTrue();
    assertThat(service.status()).doesNotContainKey("token");
  }
}
