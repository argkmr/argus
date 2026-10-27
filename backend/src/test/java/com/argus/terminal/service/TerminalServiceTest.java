package com.argus.terminal.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.argus.common.error.ConflictException;
import com.argus.workspace.domain.Repository;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

class TerminalServiceTest {
  private final Repository repository =
      new Repository("repo-a", "Fixture", "/fixture", "now", "main");

  @Test
  void rawInputHasNoSyntheticEchoNewlineOrWhitespaceFilteringAndClearDoesNotWrite() {
    var fixture = fixture(false, false);
    var service = service(fixture);
    var started = service.start(repository);
    var output = (ByteArrayOutputStream) fixture.process.getOutputStream();
    service.write(repository.id(), started.id(), " \t\u0003नमस्ते");
    assertThat(output.toString(StandardCharsets.UTF_8)).isEqualTo(" \t\u0003नमस्ते");
    assertThat(service.status(repository, 0).chunks()).isEmpty();
    service.clear(repository.id(), started.id());
    assertThat(output.toString(StandardCharsets.UTF_8)).isEqualTo(" \t\u0003नमस्ते");
    assertThatThrownBy(() -> service.write(repository.id(), started.id(), "x".repeat(64_001)))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> service.stop(repository.id(), "stale"))
        .isInstanceOf(ConflictException.class);
    assertThat(fixture.rootAlive).isTrue();
    service.stopAll();
  }

  @Test
  void blockedPtyInputCannotPreventStatusOrStopFromDrainingTheSession() throws Exception {
    var fixture = fixture(false, false);
    var writing = new CountDownLatch(1);
    var release = new CountDownLatch(1);
    Mockito.when(fixture.process.getOutputStream())
        .thenReturn(
            new OutputStream() {
              @Override
              public void write(int value) {
                writing.countDown();
                try {
                  release.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException error) {
                  Thread.currentThread().interrupt();
                }
              }

              @Override
              public void close() {
                release.countDown();
              }
            });
    var service = service(fixture);
    var started = service.start(repository);
    var pending =
        CompletableFuture.supplyAsync(() -> service.write(repository.id(), started.id(), "x"));
    assertThat(writing.await(2, TimeUnit.SECONDS)).isTrue();
    assertThat(service.status(repository, 0).running()).isTrue();
    service.stop(repository.id(), started.id());
    assertThat(pending.get(2, TimeUnit.SECONDS).running()).isFalse();
  }

  @Test
  void stopsCapturedChildrenBeforeTheShellAndPurgeDropsAllSessionMetadata() {
    var fixture = fixture(false, false);
    var service = service(fixture);
    service.start(repository);
    service.stop(repository.id());
    assertThat(fixture.events).containsExactly("child:term", "root:term");
    assertThat(service.status(repository, 0).running()).isFalse();
    service.purge(repository.id());
    service.purge(repository.id());
    var cleared = service.status(repository, 0);
    assertThat(cleared.id()).isNull();
    assertThat(cleared.chunks()).isEmpty();
    assertThat(fixture.events).containsExactly("child:term", "root:term");
    assertThatThrownBy(() -> service.start(repository))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("being removed");
  }

  @Test
  void forcesProcessesThatIgnoreGracefulTermination() {
    var fixture = fixture(true, false);
    var service = service(fixture);
    service.start(repository);
    service.purge(repository.id());
    assertThat(fixture.events)
        .containsExactly("child:term", "root:term", "child:kill", "root:kill");
    assertThat(fixture.childAlive).isFalse();
    assertThat(fixture.rootAlive).isFalse();
  }

  @Test
  void cleansRememberedChildrenAfterTheShellAlreadyExited() {
    var fixture = fixture(false, false);
    var service = service(fixture);
    service.start(repository); // The initial snapshot captures this child's handle.
    fixture.rootAlive.set(false);
    service.purge(repository.id());
    assertThat(fixture.events).containsExactly("child:term");
    assertThat(fixture.childAlive).isFalse();
  }

  @Test
  void failedTerminationDoesNotPretendSuccessOrDiscardTheSession() {
    var fixture = fixture(true, true);
    var service = service(fixture);
    var started = service.start(repository);
    assertThatThrownBy(() -> service.purge(repository.id())).isInstanceOf(ConflictException.class);
    assertThat(service.status(repository, 0).id()).isEqualTo(started.id());
    assertThat(service.status(repository, 0).running()).isTrue();
    assertThatThrownBy(() -> service.start(repository))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("being removed");
    fixture.rootAlive.set(false);
    fixture.childAlive.set(false);
    service.purge(repository.id());
    assertThat(service.status(repository, 0).id()).isNull();
  }

  @Test
  void purgingAnAbsentSessionStillPreventsAnOffboardingStartRace() {
    var fixture = fixture(false, false);
    var service = service(fixture);
    service.purge(repository.id());
    assertThatThrownBy(() -> service.start(repository)).isInstanceOf(ConflictException.class);
    var reconnected = new Repository("new-repo-id", "Fixture", "/fixture", "now", "main");
    assertThat(service.start(reconnected).running()).isTrue();
  }

  @Test
  void shutdownAttemptsEverySessionEvenWhenOneCannotStop() {
    var stuck = fixture(true, true);
    var healthy = fixture(false, false);
    var processes = new ArrayList<>(List.of(stuck.process, healthy.process));
    var service =
        new TerminalService(
            "/fixture-shell", builder -> processes.remove(0), Duration.ZERO, Duration.ZERO);
    service.start(repository);
    service.start(new Repository("repo-b", "Second", "/fixture-b", "now", "main"));
    assertThatThrownBy(service::stopAll).isInstanceOf(ConflictException.class);
    assertThat(healthy.rootAlive).isFalse();
    assertThat(healthy.childAlive).isFalse();
    assertThatThrownBy(() -> service.start(repository))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("shutting down");
  }

  @Test
  void successfulShutdownAlsoRejectsNewStartsAfterThePurgeReturns() {
    var fixture = fixture(false, false);
    var service = service(fixture);
    service.start(repository);
    service.stopAll();
    assertThatThrownBy(() -> service.start(repository))
        .isInstanceOf(ConflictException.class)
        .hasMessageContaining("shutting down");
    assertThat(service.status(repository, 0).id()).isNull();
  }

  private static TerminalService service(Fixture fixture) {
    return new TerminalService(
        "/fixture-shell", builder -> fixture.process, Duration.ZERO, Duration.ZERO);
  }

  private static Fixture fixture(boolean ignoreGraceful, boolean ignoreForce) {
    var events = new ArrayList<String>();
    var rootAlive = new AtomicBoolean(true);
    var childAlive = new AtomicBoolean(true);
    Process process = Mockito.mock(Process.class);
    ProcessHandle root = handle(1, "root", rootAlive, events, ignoreGraceful, ignoreForce);
    ProcessHandle child = handle(2, "child", childAlive, events, ignoreGraceful, ignoreForce);
    Mockito.when(root.descendants())
        .thenAnswer(call -> rootAlive.get() ? Stream.of(child) : Stream.empty());
    Mockito.when(process.toHandle()).thenReturn(root);
    Mockito.when(process.isAlive()).thenAnswer(call -> rootAlive.get());
    Mockito.when(process.getInputStream()).thenReturn(InputStream.nullInputStream());
    Mockito.when(process.getErrorStream()).thenReturn(InputStream.nullInputStream());
    Mockito.when(process.getOutputStream()).thenReturn(new ByteArrayOutputStream());
    Mockito.when(process.onExit()).thenReturn(new CompletableFuture<>());
    return new Fixture(process, rootAlive, childAlive, events);
  }

  private static ProcessHandle handle(
      long pid,
      String name,
      AtomicBoolean alive,
      List<String> events,
      boolean ignoreGraceful,
      boolean ignoreForce) {
    ProcessHandle handle = Mockito.mock(ProcessHandle.class);
    Mockito.when(handle.pid()).thenReturn(pid);
    Mockito.when(handle.isAlive()).thenAnswer(call -> alive.get());
    Mockito.when(handle.destroy())
        .thenAnswer(
            call -> {
              events.add(name + ":term");
              if (!ignoreGraceful) alive.set(false);
              return true;
            });
    Mockito.when(handle.destroyForcibly())
        .thenAnswer(
            call -> {
              events.add(name + ":kill");
              if (!ignoreForce) alive.set(false);
              return true;
            });
    return handle;
  }

  private record Fixture(
      Process process, AtomicBoolean rootAlive, AtomicBoolean childAlive, List<String> events) {}
}
