package com.argus.onboarding.service;

import static org.assertj.core.api.Assertions.*;

import com.argus.common.process.CommandFailedException;
import com.argus.common.process.CommandResult;
import java.util.List;
import org.junit.jupiter.api.Test;

class RepositoryCloneAuthTest {
  static CommandFailedException failed(String text) {
    return new CommandFailedException(text, new CommandResult("", text, 128));
  }

  @Test
  void retainsOrdinaryUsernamesAndTransportWhileRejectingCredentialsBeforeGit() {
    for (String url :
        List.of(
            "https://some.user-7@bitbucket.org/team/repo.git",
            "ssh://git@host/team/repo.git",
            "git@bitbucket.org:team/repo.git",
            "file:///tmp/repo.git",
            "/tmp/local repo")) assertThat(RepositoryCloneAuth.validate(url)).isEqualTo(url);
    for (String url :
        List.of(
            "https://user:password@bitbucket.org/team/repo.git",
            "https://user%3Apassword@bitbucket.org/team/repo.git",
            "https://ghp_fixturetoken@bitbucket.org/team/repo.git",
            "https://github_pat_fixture@github.com/team/repo.git",
            "https://ATATTfixture@bitbucket.org/team/repo.git",
            "ghp_fixture@bitbucket.org:team/repo.git",
            "https://bitbucket.org/team/repo.git?access_token=secret",
            "https://bitbucket.org/team/repo.git#secret",
            "ssh://git:secret@host/team/repo.git",
            "-upload-pack=/tmp/secret",
            "https://host/team/repo\n.git"))
      assertThatThrownBy(() -> RepositoryCloneAuth.validate(url))
          .isInstanceOf(IllegalArgumentException.class)
          .hasMessageNotContaining(url);
  }

  @Test
  void mapsOnlyExactBitbucketHttpsRepositoryToEquivalentSsh() {
    assertThat(RepositoryCloneAuth.bitbucketSsh("https://user@bitbucket.org/team/repo.git"))
        .isEqualTo("git@bitbucket.org:team/repo.git");
    assertThat(RepositoryCloneAuth.bitbucketSsh("https://bitbucket.org:443/team/repo/"))
        .isEqualTo("git@bitbucket.org:team/repo.git");
    for (String url :
        List.of(
            "https://bitbucket.org.evil/team/repo.git",
            "https://evil/bitbucket.org/team/repo.git",
            "http://bitbucket.org/team/repo.git",
            "https://bitbucket.org:8443/team/repo.git",
            "https://bitbucket.org/team/repo.git?q=1",
            "https://bitbucket.org/team/repo.git#x",
            "https://bitbucket.org/team/%72epo.git",
            "https://bitbucket.org/team/../repo.git",
            "https://bitbucket.org/../repo.git",
            "https://bitbucket.org/team/..git",
            "https://bitbucket.org/team/repo/src/main",
            "git@bitbucket.org:team/repo.git"))
      assertThat(RepositoryCloneAuth.bitbucketSsh(url)).as(url).isEmpty();
  }

  @Test
  void fallbackRequiresRealCommandAuthenticationFailureNotTransportFailure() {
    for (String message :
        List.of(
            "fatal: could not read Password for 'https://user@bitbucket.org': Device not configured",
            "fatal: could not read Username: terminal prompts disabled",
            "fatal: Authentication failed for 'https://bitbucket.org/team/repo.git'",
            "fatal: The requested URL returned error: 401"))
      assertThat(RepositoryCloneAuth.authenticationFailure(failed(message))).as(message).isTrue();
    for (String message :
        List.of(
            "Could not resolve host: bitbucket.org",
            "Connection timed out",
            "SSL certificate verification failed",
            "Could not create work tree dir: Permission denied",
            "No space left on device",
            "command interrupted",
            "Connection refused",
            "Could not read Password; SSL certificate problem",
            "Authentication failed: connection reset"))
      assertThat(RepositoryCloneAuth.authenticationFailure(failed(message))).as(message).isFalse();
    assertThat(
            RepositoryCloneAuth.authenticationFailure(
                new IllegalStateException("Authentication failed")))
        .isFalse();
    Thread.currentThread().interrupt();
    try {
      assertThat(RepositoryCloneAuth.authenticationFailure(failed("Authentication failed")))
          .isFalse();
    } finally {
      Thread.interrupted();
    }
  }

  @Test
  void clientErrorsAreActionableWithoutRawCredentialsOrCommandOutput() {
    assertThat(
            RepositoryCloneAuth.failureMessage(
                failed(
                    "fatal: could not read Password for 'https://person@host': Device not configured"),
                "https",
                false))
        .contains("credential helper")
        .doesNotContain("person", "Device not configured");
    assertThat(
            RepositoryCloneAuth.failureMessage(
                failed("Permission denied (publickey)"), "ssh", true))
        .contains("SSH retry", "SSH key");
    assertThat(
            RepositoryCloneAuth.failureMessage(failed("Host key verification failed"), "ssh", true))
        .contains("verify", "not changed known hosts");
    assertThat(
            RepositoryCloneAuth.failureMessage(
                failed("SSL certificate problem secret"), "https", false))
        .contains("certificate")
        .doesNotContain("secret");
  }
}
