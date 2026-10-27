package com.argus.agents.domain;

import static org.assertj.core.api.Assertions.*;

import org.junit.jupiter.api.Test;

class PersonalCancellationTest {
  @Test
  void cancellationKeepsJobAndPreparationIdentity() {
    var request =
        CancellationRequest.preparationRequest("repository-composer-stop")
            .withPreparationId("prep-1");
    var metadata = request.provenance("job-1", "");
    assertThat(metadata)
        .containsEntry("jobId", "job-1")
        .containsEntry("preparationId", "prep-1")
        .containsEntry("reportedControl", "repository-composer-stop");
    assertThat(CancellationRequest.jobRequest("untrusted").reportedControl())
        .isEqualTo("unspecified");
  }
}
