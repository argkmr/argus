package com.argus.runtime.service;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.common.process.OwnedProcess;
import com.argus.workspace.service.WorkspaceService;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

/** Bounded, read-only listener discovery, separate from configured (possibly stopped) services. */
@Service
public class PortInventoryService {
  private static final Duration SCAN_TIMEOUT = Duration.ofSeconds(2);
  private static final int OUTPUT_LIMIT = 512 * 1024;
  private static final long CACHE_MILLIS = 1500;
  private static final String COVERAGE =
      "TCP listeners visible to Argus on this Mac. Configured ports are not proof that a service is listening; ports can change after this snapshot.";
  private final WorkspaceService workspace;
  private final ProcessManager processes;
  private final LocalEnvironmentService local;
  private final Supplier<ScanResult> scanner;
  private final LongSupplier clock;
  private Map<String, Object> cached;
  private long cachedAt;

  record ScanResult(boolean available, String notice, List<Map<String, Object>> listeners) {}

  private record Owner(
      ProcessManager.OwnedProcessRoot root, ProcessHandle handle, Instant startedAt) {}

  @Autowired
  public PortInventoryService(
      WorkspaceService workspace, ProcessManager processes, LocalEnvironmentService local) {
    this(workspace, processes, local, PortInventoryService::scan, System::currentTimeMillis);
  }

  PortInventoryService(
      WorkspaceService workspace,
      ProcessManager processes,
      LocalEnvironmentService local,
      Supplier<ScanResult> scanner,
      LongSupplier clock) {
    this.workspace = workspace;
    this.processes = processes;
    this.local = local;
    this.scanner = scanner;
    this.clock = clock;
  }

  public Map<String, Object> snapshot() {
    return snapshot(false);
  }

  /** A save must request a new observation, never treat an unavailable scan as a free port. */
  public Map<String, Object> snapshot(boolean refresh) {
    var roots = processes.ownedProcessRoots();
    var result = listenerSnapshot(roots, refresh);
    var configurations = new ArrayList<Map<String, Object>>();
    for (var configuration : workspace.snapshot().runConfigurations()) {
      String id = text(configuration, "id");
      var environment = new LinkedHashMap<String, Object>(map(configuration.get("env")));
      String notice = "";
      try {
        environment.putAll(local.resolve(id));
      } catch (RuntimeException error) {
        notice = "Local environment could not be read; showing saved configuration ports.";
      }
      var saved = copyMap(configuration);
      saved.putIfAbsent("portSource", "Argus configuration");
      var effective = RuntimeDetector.applyEnvironmentPorts(saved, environment);
      var entry =
          object(
              "id", id,
              "repositoryId", text(configuration, "repositoryId"),
              "name", text(configuration, "name"),
              "port", validPort(effective.get("port")),
              "managementPort", validPort(effective.get("managementPort")),
              "running",
                  roots.stream()
                      .anyMatch(root -> id.equals(root.configurationId()) && root.running()),
              "portSource", effective.get("portSource"));
      if (!notice.isEmpty()) entry.put("notice", notice);
      configurations.add(entry);
    }
    result.put("configurations", configurations);
    return result;
  }

  /**
   * Never acquire workspace, environment or ProcessManager monitors while holding this cache lock.
   */
  private synchronized Map<String, Object> listenerSnapshot(
      List<ProcessManager.OwnedProcessRoot> roots, boolean refresh) {
    long now = clock.getAsLong();
    if (refresh || cached == null || now < cachedAt || now - cachedAt >= CACHE_MILLIS) {
      var owners = owners(roots);
      ScanResult scan;
      try {
        scan = scanner.get();
      } catch (RuntimeException error) {
        scan = unavailable("Local port scan failed. Port availability is unknown.");
      }
      var listeners = new ArrayList<Map<String, Object>>();
      for (var entry : scan.listeners()) {
        var listener = copyMap(entry);
        var owner = owners.get(number(entry.get("pid")));
        if (owner != null && stillOwned(owner)) {
          listener.put("configurationId", owner.root().configurationId());
          listener.put("repositoryId", owner.root().repositoryId());
        }
        listeners.add(listener);
      }
      cachedAt = clock.getAsLong();
      cached =
          object(
              "checkedAt", Instant.ofEpochMilli(cachedAt).toString(),
              "available", scan.available(),
              "notice", scan.notice(),
              "listeners", listeners);
    }
    return copyMap(cached);
  }

  private static Integer validPort(Object value) {
    long port = number(value);
    return port > 0 && port <= 65535 ? (int) port : null;
  }

  private static Map<Long, Owner> owners(List<ProcessManager.OwnedProcessRoot> roots) {
    var owners = new LinkedHashMap<Long, Owner>();
    for (var root : roots) {
      try {
        rememberOwner(owners, root, root.handle());
        try (var descendants = root.handle().descendants()) {
          descendants.limit(4096).forEach(handle -> rememberOwner(owners, root, handle));
        }
      } catch (RuntimeException ignored) {
        // Process visibility is optional. A configured port alone never establishes ownership.
      }
    }
    return owners;
  }

  private static void rememberOwner(
      Map<Long, Owner> owners, ProcessManager.OwnedProcessRoot root, ProcessHandle handle) {
    if (!handle.isAlive()) return;
    handle
        .info()
        .startInstant()
        .ifPresent(start -> owners.put(handle.pid(), new Owner(root, handle, start)));
  }

  private static boolean stillOwned(Owner owner) {
    try {
      return owner.root().handle().isAlive()
          && owner.handle().isAlive()
          && owner.handle().info().startInstant().map(owner.startedAt()::equals).orElse(false);
    } catch (RuntimeException ignored) {
      return false;
    }
  }

  private static ScanResult unavailable(String notice) {
    return new ScanResult(false, notice, List.of());
  }

  private static ScanResult scan() {
    String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
    if (!os.contains("mac") && !os.contains("darwin"))
      return unavailable(
          "Local listener discovery is supported on macOS. Port availability is unknown on this platform.");
    Path executable = Path.of("/usr/sbin/lsof");
    if (!Files.isExecutable(executable))
      return unavailable("Local port scanner is unavailable. Port availability is unknown.");
    // Only process name, PID and socket address. No shell, command arguments, paths or environment.
    var builder =
        new ProcessBuilder(executable.toString(), "-nP", "-iTCP", "-sTCP:LISTEN", "-F0pcn");
    builder.environment().put("LC_ALL", "C");
    try (var child = new OwnedProcess(builder, null, OUTPUT_LIMIT)) {
      child.closeInput();
      var output = child.await(SCAN_TIMEOUT);
      boolean clean = output.stderr().isBlank();
      if (output.exitCode() == 1 && output.stdout().isBlank() && clean)
        return new ScanResult(true, COVERAGE, List.of());
      if (output.exitCode() != 0)
        return unavailable("Local port scan did not complete. Port availability is unknown.");
      var parsed = parse(output.stdout());
      return new ScanResult(
          clean && parsed.available(),
          clean && parsed.available()
              ? COVERAGE
              : "Local port scan is incomplete. Listed listeners are known to be in use; other ports remain unknown.",
          parsed.listeners());
    } catch (Exception error) {
      return unavailable("Local port scan failed or timed out. Port availability is unknown.");
    }
  }

  /** lsof's NUL-delimited machine output; do not parse its truncated human-readable table. */
  static ScanResult parse(String source) {
    var found = new LinkedHashMap<String, Map<String, Object>>();
    long pid = 0;
    String command = "";
    boolean complete = true;
    for (String part : source.split("\u0000", -1)) {
      String field = part.replaceFirst("^[\\r\\n]+", "");
      if (field.isEmpty()) continue;
      char kind = field.charAt(0);
      String value = field.substring(1);
      if (kind == 'p') {
        pid = number(value);
        command = "";
        if (pid <= 0) complete = false;
      } else if (kind == 'c') {
        command = value.replaceAll("[\\p{Cntrl}]", "");
        if (command.length() > 120) command = command.substring(0, 120);
      } else if (kind == 'n') {
        int colon = value.lastIndexOf(':');
        Integer port = colon > 0 ? validPort(value.substring(colon + 1)) : null;
        String host = colon > 0 ? value.substring(0, colon) : "";
        if (pid <= 0 || port == null || !host.matches("\\*|[0-9a-fA-F:.%\\[\\]]+")) {
          complete = false;
          continue;
        }
        if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
        found.putIfAbsent(
            pid + ":" + host + ":" + port,
            object("port", port, "host", host, "pid", pid, "command", command));
      } else if (kind != 'f') {
        complete = false;
      }
    }
    var listeners = new ArrayList<>(found.values());
    listeners.sort(
        Comparator.comparingLong((Map<String, Object> entry) -> number(entry.get("port")))
            .thenComparingLong(entry -> number(entry.get("pid"))));
    return new ScanResult(
        complete, complete ? COVERAGE : "Local port scan is incomplete.", listeners);
  }
}
