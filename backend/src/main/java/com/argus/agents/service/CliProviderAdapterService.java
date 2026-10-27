package com.argus.agents.service;

import com.argus.agents.domain.CliProviderAdapter;
import com.argus.agents.dto.AgentProvider;
import com.argus.agents.dto.ProviderAvailability;
import com.argus.agents.repository.CliProviderAdapterRepository;
import com.argus.agents.repository.ProviderHealthRepository;
import com.argus.common.process.CommandResult;
import com.argus.common.process.CommandRunner;
import java.time.Duration;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

@Service
public class CliProviderAdapterService {
  private final CliProviderAdapterRepository adapters;
  private final CommandRunner commands;
  private final ProviderHealthRepository health;
  private final CodexAccountAvailabilityService accounts;

  public CliProviderAdapterService(
      CliProviderAdapterRepository adapters,
      CommandRunner commands,
      ProviderHealthRepository health,
      CliProviderReadinessService readiness) {
    this(adapters, commands, health, readiness, null);
  }

  @org.springframework.beans.factory.annotation.Autowired
  public CliProviderAdapterService(
      CliProviderAdapterRepository adapters,
      CommandRunner commands,
      ProviderHealthRepository health,
      CliProviderReadinessService readiness,
      CodexAccountAvailabilityService accounts) {
    this.adapters = adapters;
    this.commands = commands;
    this.health = health;
    this.accounts = accounts;
  }

  public List<CliProviderAdapter> list() {
    return adapters.list();
  }

  public AgentProvider detect(CliProviderAdapter adapter, boolean verifyLive) {
    // Compatibility entry point: detection never spends credits on an inference probe.
    return detectMetadata(adapter, verifyLive);
  }

  public AgentProvider detectMetadata(CliProviderAdapter adapter, boolean refresh) {
    try {
      CommandResult version =
          commands.run(
              adapter.executable(), safe(adapter.versionArguments()), null, Duration.ofSeconds(8));
      String path = executablePath(adapter.executable());
      Authentication authentication = authentication(adapter);
      ProviderAvailability availability =
          authentication.authenticated()
              ? "codex".equals(adapter.id()) && accounts != null
                  ? accounts.availability(adapter.executable(), refresh)
                  : health.availability(adapter.id())
              : ProviderAvailability.authenticationRequired();
      return provider(adapter, true, version.stdout().trim(), path, authentication, availability);
    } catch (RuntimeException error) {
      return provider(
          adapter,
          false,
          "",
          "",
          new Authentication(false, ""),
          ProviderAvailability.authenticationRequired());
    }
  }

  private AgentProvider provider(
      CliProviderAdapter adapter,
      boolean installed,
      String version,
      String path,
      Authentication authentication,
      ProviderAvailability availability) {
    return new AgentProvider(
        adapter.id(),
        adapter.name(),
        installed,
        version,
        path,
        authentication.authenticated(),
        authentication.method(),
        availability,
        installed && authentication.authenticated() && availability.canRun(),
        false,
        !"not-exposed".equals(availability.source()),
        "cli",
        safe(adapter.models()),
        value(adapter.defaultModel(), ""),
        true,
        adapter.toolCapable(),
        adapter.effortArguments() != null && !adapter.effortArguments().isEmpty(),
        adapter.fastArguments() != null && !adapter.fastArguments().isEmpty(),
        safe(adapter.contextCapabilities()),
        List.of(),
        "unavailable");
  }

  private Authentication authentication(CliProviderAdapter adapter) {
    if (adapter.authenticationArguments() == null || adapter.authenticationArguments().isEmpty())
      return new Authentication(true, "CLI-managed authentication");
    try {
      CommandResult result =
          commands.run(
              adapter.executable(), adapter.authenticationArguments(), null, Duration.ofSeconds(8));
      String output = result.stdout() + "\n" + result.stderr();
      String successPattern = value(adapter.authenticationSuccessPattern(), "");
      boolean authenticated =
          successPattern.isBlank() || Pattern.compile(successPattern).matcher(output).find();
      return new Authentication(
          authenticated,
          authenticated ? captured(adapter.authenticationMethodPattern(), output) : "");
    } catch (RuntimeException error) {
      return new Authentication(false, "");
    }
  }

  private String executablePath(String executable) {
    if (executable.contains("/")) return executable;
    try {
      return commands
          .run("which", List.of(executable), null, Duration.ofSeconds(5))
          .stdout()
          .trim();
    } catch (RuntimeException ignored) {
      return "";
    }
  }

  private static String captured(String expression, String output) {
    if (expression == null || expression.isBlank()) return "CLI-managed authentication";
    Matcher matcher = Pattern.compile(expression).matcher(output);
    if (!matcher.find()) return "CLI-managed authentication";
    return matcher.groupCount() > 0 ? matcher.group(1).trim() : matcher.group().trim();
  }

  private static List<String> safe(List<String> value) {
    return value == null ? List.of() : value;
  }

  private static String value(String preferred, String fallback) {
    return preferred != null && !preferred.isBlank()
        ? preferred.trim()
        : fallback == null ? "" : fallback;
  }

  private record Authentication(boolean authenticated, String method) {}
}
