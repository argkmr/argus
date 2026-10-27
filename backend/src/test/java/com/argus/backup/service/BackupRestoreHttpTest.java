package com.argus.backup.service;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.argus.backup.controller.BackupController;
import com.argus.common.error.ApiExceptionHandler;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.ObjectMapper;

class BackupRestoreHttpTest {
  @TempDir Path temporary;

  @Test
  void partialRestoreFailureReturnsRecoveryLocationAndMandatoryRestart() throws Exception {
    Path recovery = temporary.resolve(".restore-recovery/fixture");
    var coordinator = mock(BackupCoordinator.class);
    var storage = mock(DataStorageService.class);
    when(coordinator.restore(anyMap()))
        .thenThrow(
            new BackupService.RestoreFailure(
                "Restore failed; verify retained recovery before restarting.",
                recovery,
                true,
                List.of("Keychain environments rollback did not complete"),
                new IllegalStateException("private underlying details")));
    var mvc =
        MockMvcBuilders.standaloneSetup(new BackupController(coordinator, storage))
            .setControllerAdvice(new ApiExceptionHandler())
            .build();
    var response =
        mvc.perform(
                post("/api/backup/restore").contentType(MediaType.APPLICATION_JSON).content("{}"))
            .andReturn()
            .getResponse();
    assertThat(response.getStatus()).isEqualTo(500);
    Map<String, Object> body =
        new ObjectMapper().readValue(response.getContentAsByteArray(), Map.class);
    assertThat(body)
        .containsEntry("restartRequired", true)
        .containsEntry("partialRestore", true)
        .containsEntry("recoveryPath", recovery.toString())
        .containsEntry(
            "rollbackErrors", List.of("Keychain environments rollback did not complete"));
    assertThat(body.get("error").toString())
        .contains("Restore failed")
        .doesNotContain("private underlying details");
    verifyNoInteractions(storage);
  }
}
