package com.argus.terminal.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.argus.common.error.ConflictException;
import com.argus.terminal.dto.TerminalResponse;
import com.argus.workspace.domain.Repository;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class TerminalPtyIntegrationTest {
  @TempDir Path temporary;
  private final List<TerminalService> services = new ArrayList<>();
  private final List<Process> processes = new ArrayList<>();
  private final List<Path> integrations = new ArrayList<>();
  private Repository repository;
  private Map<String, String> environment;

  @BeforeEach
  void prepareIsolatedRepositoryAndHome() throws Exception {
    assumeTrue(Files.isExecutable(Path.of("/bin/zsh")));
    Path home = Files.createDirectory(temporary.resolve("home"));
    Path repo = Files.createDirectory(temporary.resolve("fixture-repo"));
    git(repo, "init", "-b", "main");
    repository = new Repository("terminal-fixture", "Fixture", repo.toString(), "now", "main");
    environment =
        new HashMap<>(
            Map.of(
                "HOME",
                home.toString(),
                "PATH",
                "/usr/bin:/bin:/usr/sbin:/sbin",
                "LANG",
                "en_US.UTF-8",
                "LC_ALL",
                "en_US.UTF-8"));
  }

  @AfterEach
  void cleanupAllOwnedProcessesAndTemporaryIntegrationFiles() {
    services.forEach(TerminalService::stopAll);
    assertThat(processes).allMatch(process -> !process.isAlive());
    assertThat(integrations).allMatch(path -> !Files.exists(path));
  }

  @Test
  void realZshShowsBranchRefreshesAfterSwitchAndCdAndNeverEvaluatesNames() throws Exception {
    TerminalService service = service();
    var started = service.start(repository);
    assertThat(started.pty()).isTrue();
    assertThat(await(service, state -> plain(state).contains("git:(main)")))
        .satisfies(state -> assertThat(state.running()).isTrue());
    command(service, started, "git switch -c feature/terminal");
    await(service, state -> plain(state).contains("git:(feature/terminal)"));
    Path other = Files.createDirectory(temporary.resolve("other repository"));
    git(other, "init", "-b", "other-branch");
    command(service, started, "cd '" + other + "'");
    var changed =
        await(
            service,
            state ->
                state.cwd().equals(other.toString())
                    && plain(state).contains("git:(other-branch)"));
    assertThat(changed.cwd()).isEqualTo(other.toString());
    command(service, started, "git switch -c 'branch-$(touch${IFS}injected)-%F{red}'");
    await(service, state -> plain(state).contains("git:(branch-$(touch${IFS}injected)-%F{red})"));
    assertThat(Files.exists(other.resolve("injected"))).isFalse();
    command(service, started, "cd ..");
    await(service, state -> state.cwd().equals(temporary.toString()));
  }

  @Test
  void streamsPartialUtf8AnsiAndSupportsRawEditingControlCAndResize() throws Exception {
    TerminalService service = service();
    var started = service.start(repository);
    await(service, state -> plain(state).contains("git:(main)"));
    service.resize(repository.id(), started.id(), 93, 24);
    command(service, started, "stty size");
    await(service, state -> plain(state).contains("24 93"));
    command(service, started, "printf '\\033[31mनमस्ते café 🦊\\033[0m'; sleep 0.4");
    var partial = await(service, state -> raw(state).contains("\u001b[31mनमस्ते café 🦊\u001b[0m"));
    assertThat(raw(partial)).doesNotContain("\ufffd");
    service.write(repository.id(), started.id(), "echo editX\u007fY\r");
    await(service, state -> plain(state).contains("editY\r\n"));
    command(service, started, "sleep 30");
    TimeUnit.MILLISECONDS.sleep(100);
    service.write(repository.id(), started.id(), "\u0003");
    command(service, started, "printf 'CONTROL_C_OK\\n'");
    await(service, state -> plain(state).contains("\r\nCONTROL_C_OK\r\n"));
    assertThat(service.status(repository, 0).running()).isTrue();
  }

  @Test
  void preservesUserLoginFilesThemeAliasesZdotdirAndChildShellStartup() throws Exception {
    Path dotdir = Files.createDirectory(temporary.resolve("custom dotfiles"));
    environment.put("ZDOTDIR", dotdir.toString());
    Files.writeString(dotdir.resolve(".zshenv"), "export FIXTURE_ENV='env-ok'\n");
    Files.writeString(dotdir.resolve(".zprofile"), "export FIXTURE_PROFILE='profile-ok'\n");
    String userRc =
        "PROMPT='CUSTOM-THEME> '\nalias fixture_alias='print alias-ok'\ntypeset FIXTURE_TOP_LEVEL='top-level-ok'\n";
    Files.writeString(dotdir.resolve(".zshrc"), userRc);
    Files.writeString(dotdir.resolve(".zlogin"), "export FIXTURE_LOGIN='login-ok'\n");
    var service = service();
    var started = service.start(repository);
    await(service, state -> plain(state).contains("CUSTOM-THEME> "));
    command(
        service,
        started,
        "print $FIXTURE_ENV $FIXTURE_PROFILE $FIXTURE_LOGIN $FIXTURE_TOP_LEVEL; fixture_alias; print -r -- $ZDOTDIR");
    await(
        service,
        state ->
            plain(state).contains("env-ok profile-ok login-ok top-level-ok")
                && plain(state).contains("alias-ok\r\n")
                && plain(state).contains(dotdir.toString()));
    command(
        service,
        started,
        "/bin/zsh -ilc 'print CHILD-$FIXTURE_ENV-$FIXTURE_PROFILE-$FIXTURE_LOGIN'");
    var state = await(service, value -> plain(value).contains("CHILD-env-ok-profile-ok-login-ok"));
    assertThat(plain(state)).doesNotContain("git:(main)");
    assertThat(Files.readString(dotdir.resolve(".zshrc"))).isEqualTo(userRc);
  }

  @Test
  void honoursZdotdirChangesAndDoesNotLeakPrivateDirectoryWhenRcsDisabled() throws Exception {
    Path initial = Files.createDirectory(temporary.resolve("initial-dotfiles"));
    Path changed = Files.createDirectory(temporary.resolve("changed-dotfiles"));
    environment.put("ZDOTDIR", initial.toString());
    Files.writeString(initial.resolve(".zshenv"), "export ZDOTDIR='" + changed + "'\n");
    Files.writeString(
        changed.resolve(".zshrc"),
        "PROMPT='CHANGED-DOTDIR> '\ntypeset DOTDIR_VALUE='loaded-new-rc'\n");
    var service = service();
    var first = service.start(repository);
    await(service, state -> plain(state).contains("CHANGED-DOTDIR> "));
    command(service, first, "print $DOTDIR_VALUE; print -r -- $ZDOTDIR");
    await(
        service,
        state ->
            plain(state).contains("\r\nloaded-new-rc\r\n")
                && plain(state).contains(changed.toString()));
    service.stop(repository.id(), first.id());
    Files.writeString(initial.resolve(".zshenv"), "unsetopt RCS\n");
    var second = service.start(repository);
    command(service, second, "print -r -- RESTORED-$ZDOTDIR");
    await(service, state -> plain(state).contains("RESTORED-" + initial));
  }

  @Test
  void clearDoesNotSendInputAndFinalOutputIsDrainedBeforeStoppedStatus() throws Exception {
    var service = service();
    var started = service.start(repository);
    await(service, state -> plain(state).contains("git:(main)"));
    command(service, started, "read -r 'answer?ANSWER_PROMPT> '; print -r -- RECEIVED-$answer");
    await(service, state -> plain(state).contains("ANSWER_PROMPT> "));
    service.clear(repository.id(), started.id());
    service.write(repository.id(), started.id(), "clean-value\r");
    await(service, state -> plain(state).contains("RECEIVED-clean-value\r\n"));
    command(service, started, "printf 'FINAL-%s\\n' {1..1000}; print FINAL-END; exit");
    var stopped = await(service, state -> !state.running());
    String transcript = plain(stopped);
    assertThat(transcript).contains("FINAL-1\r\n", "FINAL-1000\r\n", "FINAL-END\r\n");
    assertThat(transcript.indexOf("Terminal stopped with exit code"))
        .isGreaterThan(transcript.lastIndexOf("FINAL-END"));
  }

  @Test
  void staleMutationsCannotAffectRestartedSessionAndCleanupStopsChildren() throws Exception {
    var service = service();
    var first = service.start(repository);
    await(service, state -> plain(state).contains("git:(main)"));
    command(service, first, "sleep 60 &");
    TimeUnit.MILLISECONDS.sleep(100);
    List<ProcessHandle> children =
        ProcessHandle.of(processes.get(0).pid()).orElseThrow().descendants().toList();
    assertThat(children).isNotEmpty();
    service.stop(repository.id(), first.id());
    assertThat(children).allMatch(handle -> !handle.isAlive());
    var second = service.start(repository);
    assertThat(second.id()).isNotEqualTo(first.id());
    assertThatThrownBy(() -> service.write(repository.id(), first.id(), "exit\r"))
        .isInstanceOf(ConflictException.class);
    assertThatThrownBy(() -> service.resize(repository.id(), first.id(), 80, 20))
        .isInstanceOf(ConflictException.class);
    assertThatThrownBy(() -> service.clear(repository.id(), first.id()))
        .isInstanceOf(ConflictException.class);
    assertThatThrownBy(() -> service.stop(repository.id(), first.id()))
        .isInstanceOf(ConflictException.class);
    assertThatThrownBy(() -> service.write(repository.id(), null, "exit\r"))
        .isInstanceOf(ConflictException.class);
    assertThat(service.status(repository, 0).running()).isTrue();
    assertThatThrownBy(() -> service.resize(repository.id(), second.id(), 0, 0))
        .isInstanceOf(IllegalArgumentException.class);
  }

  private TerminalService service() {
    var service =
        new TerminalService(
            "/bin/zsh",
            builder -> {
              integrations.add(Path.of(builder.environment().get("ZDOTDIR")));
              var process = TerminalService.startPty(builder);
              processes.add(process);
              return process;
            },
            environment,
            Duration.ofMillis(500),
            Duration.ofSeconds(1));
    services.add(service);
    return service;
  }

  private void command(TerminalService service, TerminalResponse state, String input) {
    service.write(repository.id(), state.id(), input + "\r");
  }

  private TerminalResponse await(TerminalService service, Predicate<TerminalResponse> predicate)
      throws InterruptedException {
    long deadline = System.nanoTime() + Duration.ofSeconds(8).toNanos();
    TerminalResponse last;
    do {
      last = service.status(repository, 0);
      if (predicate.test(last)) return last;
      TimeUnit.MILLISECONDS.sleep(20);
    } while (System.nanoTime() < deadline);
    throw new AssertionError("Terminal did not reach expected state: " + plain(last));
  }

  private static String raw(TerminalResponse state) {
    return state.chunks().stream().map(chunk -> chunk.data()).reduce("", String::concat);
  }

  private static String plain(TerminalResponse state) {
    return raw(state).replaceAll("\\x1b\\[[0-?]*[ -/]*[@-~]", "");
  }

  private static void git(Path cwd, String... arguments) throws Exception {
    var command = new ArrayList<>(List.of("/usr/bin/git"));
    command.addAll(List.of(arguments));
    var process =
        new ProcessBuilder(command).directory(cwd.toFile()).redirectErrorStream(true).start();
    String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
    assertThat(process.waitFor()).as(output).isZero();
  }
}
