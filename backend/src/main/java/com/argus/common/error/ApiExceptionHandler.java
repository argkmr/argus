package com.argus.common.error;

import com.argus.platform.RequestBodyLimitFilter;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.server.ResponseStatusException;

@RestControllerAdvice
public class ApiExceptionHandler {
  @ExceptionHandler(com.argus.backup.service.BackupService.RestoreFailure.class)
  ResponseEntity<Map<String, Object>> restoreFailed(
      com.argus.backup.service.BackupService.RestoreFailure error) {
    return ResponseEntity.status(500)
        .body(
            Map.of(
                "error",
                message(error, "Restore could not be completed"),
                "restartRequired",
                true,
                "recoveryPath",
                error.recoveryPath.toString(),
                "partialRestore",
                error.partialRestore,
                "rollbackErrors",
                error.rollbackErrors));
  }

  @ExceptionHandler({
    HttpMessageNotReadableException.class,
    RequestBodyLimitFilter.PayloadTooLargeException.class
  })
  ResponseEntity<Map<String, String>> unreadable(RuntimeException error) {
    boolean tooLarge = RequestBodyLimitFilter.causedByLimit(error);
    return ResponseEntity.status(tooLarge ? 413 : 400)
        .body(Map.of("error", tooLarge ? "Request body too large" : "Invalid JSON request body"));
  }

  @ExceptionHandler(ResponseStatusException.class)
  ResponseEntity<Map<String, String>> status(ResponseStatusException error) {
    return ResponseEntity.status(error.getStatusCode())
        .body(
            Map.of(
                "error",
                error.getReason() == null
                    ? "Argus could not process the request"
                    : error.getReason()));
  }

  private static String message(Throwable error, String fallback) {
    return error.getMessage() == null || error.getMessage().isBlank()
        ? fallback
        : error.getMessage();
  }

  @ExceptionHandler(NotFoundException.class)
  ResponseEntity<Map<String, String>> notFound(NotFoundException error) {
    return ResponseEntity.status(HttpStatus.NOT_FOUND)
        .body(Map.of("error", message(error, "The requested item was not found")));
  }

  @ExceptionHandler(ConflictException.class)
  ResponseEntity<Map<String, String>> conflict(ConflictException error) {
    return ResponseEntity.status(HttpStatus.CONFLICT)
        .body(Map.of("error", message(error, "The request conflicts with the current state")));
  }

  @ExceptionHandler({IllegalArgumentException.class, IllegalStateException.class})
  ResponseEntity<Map<String, String>> invalid(RuntimeException error) {
    return ResponseEntity.badRequest()
        .body(Map.of("error", message(error, "Argus could not process the request")));
  }
}
