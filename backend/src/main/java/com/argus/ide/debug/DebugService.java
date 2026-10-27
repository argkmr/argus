package com.argus.ide.debug;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.common.config.ArgusProperties;
import com.argus.platform.NativeBackgroundOwner;
import com.argus.runtime.service.ProcessManager;
import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

@Service
public class DebugService implements NativeBackgroundOwner {
  private static final Set<String> COMMANDS =
      Set.of(
          "setBreakpoints",
          "configurationDone",
          "threads",
          "stackTrace",
          "scopes",
          "variables",
          "continue",
          "next",
          "stepIn",
          "stepOut",
          "pause");
  private static final Set<String> SHELLS =
      Set.of("sh", "bash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "pwsh");
  private final WorkspaceService workspace;
  private final ProcessManager processes;
  private final ObjectMapper json;
  private final Path adaptersFile;
  private final ArgusProperties properties;
  private final Map<String, Session> sessions = new ConcurrentHashMap<>();
  private final Set<String> retired = ConcurrentHashMap.newKeySet();
  private final AtomicLong cursor = new AtomicLong();
  private volatile boolean closing;

  private static final class Session {
    final String id = UUID.randomUUID().toString();
    final String adapterId;
    final int port;
    final String processId;
    final Path root;
    final List<Map<String, Object>> events = new ArrayList<>();
    volatile DebugSession debugger;
    volatile String state = "attaching";
    volatile Object threadId;
    volatile Map<String, Object> capabilities = Map.of();
    long cursor;

    Session(String adapterId, int port, String processId, Path root) {
      this.adapterId = adapterId;
      this.port = port;
      this.processId = processId;
      this.root = root;
    }
  }

  public DebugService(
      WorkspaceService workspace,
      ProcessManager processes,
      ArgusProperties properties,
      ObjectMapper json) {
    this.workspace = workspace;
    this.processes = processes;
    this.json = json;
    this.properties = properties;
    this.adaptersFile = properties.dataDirectory().resolve("ide-debug-adapters.json");
  }

  public Map<String, Object> status(String repositoryId) {
    workspace.requireRepository(repositoryId);
    var adapters = new ArrayList<Map<String, Object>>();
    boolean java = ModuleLayer.boot().findModule("jdk.jdi").isPresent();
    adapters.add(
        object(
            "id",
            "java-jdi",
            "name",
            "Built-in Java debugger",
            "runtime",
            "java",
            "available",
            java,
            "reason",
            java ? "" : "The bundled Java runtime needs the jdk.jdi module"));
    var javascript = JavaScriptDebugTools.discover(properties);
    adapters.add(
        object(
            "id",
            "node-js-debug",
            "name",
            "JavaScript / TypeScript debugger",
            "runtime",
            "node",
            "available",
            javascript.available(),
            "reason",
            javascript.reason()));
    String configurationError = "";
    try {
      for (var adapter : configuredAdapters()) {
        boolean available = executableAvailable(strings(adapter.get("command")));
        adapters.add(
            object(
                "id",
                adapter.get("id"),
                "name",
                adapter.getOrDefault("name", adapter.get("id")),
                "runtime",
                adapter.get("runtime"),
                "available",
                available,
                "reason",
                available ? "" : "Configured adapter executable is unavailable"));
      }
    } catch (RuntimeException error) {
      configurationError = error.getMessage();
    }
    if (adapters.stream().noneMatch(adapter -> "node".equals(adapter.get("runtime"))))
      adapters.add(
          object(
              "id",
              "node-dap",
              "name",
              "JavaScript debug adapter",
              "runtime",
              "node",
              "available",
              false,
              "reason",
              "Configure a stdio DAP adapter in " + adaptersFile));
    return object(
        "adapters",
        adapters,
        "adapterConfigFile",
        adaptersFile.toString(),
        "configurationError",
        configurationError,
        "targets",
        targets(repositoryId),
        "session",
        sessionView(sessions.get(repositoryId)),
        "launchSupport",
        "Direct java, Gradle bootRun/run (including module tasks), Maven spring-boot:run and direct node commands. JavaScript uses the bundled Microsoft debug adapter.");
  }

  private List<Map<String, Object>> targets(String repositoryId) {
    return processes.list().stream()
        .filter(
            process ->
                repositoryId.equals(process.get("repositoryId"))
                    && Boolean.TRUE.equals(process.get("running"))
                    && !map(process.get("debug")).isEmpty())
        .map(
            process -> {
              var target = copyMap(map(process.get("debug")));
              target.putAll(
                  object(
                      "processId",
                      process.get("id"),
                      "configurationId",
                      process.get("configurationId"),
                      "name",
                      process.get("name")));
              return target;
            })
        .toList();
  }

  public synchronized Map<String, Object> attach(String repositoryId, Map<String, Object> input) {
    Repository repository = workspace.requireRepository(repositoryId);
    if (closing || retired.contains(repositoryId))
      throw new IllegalStateException("Debugger admission is closed for this repository");
    if (!Set.of("adapterId", "port").containsAll(input.keySet()))
      throw new IllegalArgumentException(
          "Attach accepts only adapterId and a local Argus debug port");
    int port = port(input.get("port"));
    var target =
        targets(repositoryId).stream()
            .filter(
                item -> number(item.get("port")) == port && "listening".equals(item.get("state")))
            .findFirst()
            .orElseThrow(
                () ->
                    new IllegalArgumentException(
                        "Start this repository's service with Debug and wait for its loopback listener before attaching"));
    String adapterId = text(input, "adapterId");
    Map<String, Object> adapter = Map.of();
    if (adapterId.equals("java-jdi")) {
      if (!"java".equals(target.get("runtime")))
        throw new IllegalArgumentException("The built-in Java debugger requires a Java target");
      if (ModuleLayer.boot().findModule("jdk.jdi").isEmpty())
        throw new IllegalStateException("Java debugging requires the jdk.jdi runtime module");
    } else if (adapterId.equals("node-js-debug")) {
      if (!"node".equals(target.get("runtime")))
        throw new IllegalArgumentException("The JavaScript debugger requires a Node target");
      var javascript = JavaScriptDebugTools.discover(properties);
      if (!javascript.available()) throw new IllegalStateException(javascript.reason());
    } else {
      adapter =
          configuredAdapters().stream()
              .filter(item -> adapterId.equals(item.get("id")))
              .findFirst()
              .orElseThrow(
                  () -> new IllegalArgumentException("Debug adapter is not configured locally"));
      if (!adapter.get("runtime").equals(target.get("runtime")))
        throw new IllegalArgumentException("Debug adapter runtime does not match the service");
      if (!executableAvailable(strings(adapter.get("command"))))
        throw new IllegalArgumentException("Debug adapter executable is unavailable");
    }
    var existing = sessions.get(repositoryId);
    if (existing != null && existing.debugger != null && existing.debugger.alive())
      throw new IllegalStateException("Detach the current debug session before attaching another");
    if (existing != null && existing.debugger != null) existing.debugger.close();
    Session session =
        new Session(adapterId, port, text(target, "processId"), Path.of(repository.path()));
    sessions.put(repositoryId, session);
    try {
      if (adapterId.equals("java-jdi")) {
        session.debugger =
            new JavaDebugSession(
                Path.of(repository.path()), port, (event, body) -> event(session, event, body));
        session.capabilities =
            object(
                "supportsConfigurationDoneRequest",
                true,
                "supportsConditionalBreakpoints",
                false,
                "supportsEvaluateForHovers",
                false);
      } else if (adapterId.equals("node-js-debug")) {
        var tools = JavaScriptDebugTools.discover(properties);
        var debugger =
            new JavaScriptDebugSession(
                tools.node(),
                tools.server(),
                Path.of(repository.path()),
                port,
                json,
                (event, body) -> event(session, event, body));
        session.debugger = debugger;
        session.capabilities = debugger.capabilities();
      } else {
        var debugger =
            new DapDebugSession(
                strings(adapter.get("command")),
                Path.of(repository.path()),
                adapterId,
                text(adapter, "runtime"),
                port,
                json,
                (event, body) -> event(session, event, body));
        session.debugger = debugger;
        session.capabilities = debugger.capabilities();
      }
      if (session.state.equals("attaching")) session.state = "attached";
      return sessionView(session);
    } catch (RuntimeException error) {
      session.state = "terminated";
      event(session, "output", object("category", "stderr", "output", error.getMessage()));
      throw error;
    }
  }

  public Map<String, Object> command(String repositoryId, Map<String, Object> input) {
    Repository repository = workspace.requireRepository(repositoryId);
    String command = text(input, "command");
    if (!COMMANDS.contains(command))
      throw new IllegalArgumentException("Unsupported debugger command: " + command);
    Session session = sessions.get(repositoryId);
    if (session == null || session.debugger == null || !session.debugger.alive())
      throw new IllegalStateException("Attach a debugger first");
    var arguments = copyMap(map(input.get("arguments")));
    validateArguments(command, arguments, Path.of(repository.path()));
    Map<String, Object> result = session.debugger.command(command, arguments);
    return normalizeSources(result, Path.of(repository.path()));
  }

  static void validateArguments(String command, Map<String, Object> args, Path root) {
    Set<String> keys =
        switch (command) {
          case "setBreakpoints" -> Set.of("source", "breakpoints");
          case "threads", "configurationDone" -> Set.of();
          case "stackTrace" -> Set.of("threadId", "startFrame", "levels");
          case "scopes" -> Set.of("frameId");
          case "variables" -> Set.of("variablesReference", "start", "count", "filter");
          default -> Set.of("threadId");
        };
    if (!keys.containsAll(args.keySet()))
      throw new IllegalArgumentException("Unsupported arguments for " + command);
    if (command.equals("setBreakpoints")) {
      String path = text(map(args.get("source")), "path");
      Path source = inside(root, path);
      if (!Files.isRegularFile(source))
        throw new IllegalArgumentException("Breakpoint source file does not exist");
      args.put("source", object("path", source.toString()));
      if (list(args.get("breakpoints")).size() > 200)
        throw new IllegalArgumentException("At most 200 breakpoints per file are supported");
      for (Object item : list(args.get("breakpoints"))) {
        var point = map(item);
        if (!Set.of("line").containsAll(point.keySet())
            || number(point.get("line")) < 1
            || number(point.get("line")) > 1_000_000)
          throw new IllegalArgumentException(
              "Only positive unconditional line breakpoints are supported");
      }
    }
    for (String key : List.of("threadId", "frameId", "variablesReference"))
      if (args.containsKey(key)
          && (!text(args.get(key)).matches("[0-9]{1,10}")
              || number(args.get(key)) < (key.equals("variablesReference") ? 1 : 0)
              || number(args.get(key)) > Integer.MAX_VALUE))
        throw new IllegalArgumentException("Invalid debugger reference: " + key);
    for (String key : List.of("startFrame", "start", "count", "levels"))
      if (args.containsKey(key) && (number(args.get(key)) < 0 || number(args.get(key)) > 10000))
        throw new IllegalArgumentException("Invalid debugger paging argument: " + key);
    if (command.equals("variables"))
      args.put("count", Math.min(200, Math.max(1, number(args.getOrDefault("count", 100)))));
    if (command.equals("stackTrace"))
      args.put("levels", Math.min(100, Math.max(1, number(args.getOrDefault("levels", 50)))));
  }

  static Map<String, Object> normalizeSources(Map<String, Object> response, Path root) {
    var result = copyMap(response);
    var items = new ArrayList<Map<String, Object>>();
    for (String field : List.of("stackFrames", "breakpoints"))
      for (Object item : list(result.get(field))) items.add(map(item));
    if (result.get("breakpoint") instanceof Map<?, ?>) items.add(map(result.get("breakpoint")));
    for (var item : items) {
      var source = map(item.get("source"));
      String path = text(source, "path");
      if (path.isBlank()) continue;
      try {
        Path realRoot = root.toRealPath();
        Path realSource = root.resolve(path).toRealPath();
        if (!realSource.startsWith(realRoot) || !Files.isRegularFile(realSource))
          throw new IllegalArgumentException("Debugger source is outside the repository");
        source.put("path", realRoot.relativize(realSource).toString().replace('\\', '/'));
      } catch (IOException | RuntimeException error) {
        item.remove("source");
      }
    }
    return result;
  }

  public Map<String, Object> events(String repositoryId, long after) {
    workspace.requireRepository(repositoryId);
    Session session = sessions.get(repositoryId);
    if (session == null) return object("cursor", 0, "events", List.of(), "session", null);
    synchronized (session) {
      return object(
          "cursor",
          session.cursor,
          "events",
          session.events.stream()
              .filter(event -> number(event.get("seq")) > after)
              .map(com.argus.runtime.service.RuntimeData::copyMap)
              .toList(),
          "session",
          sessionView(session));
    }
  }

  private void event(Session session, String name, Map<String, Object> body) {
    body = normalizeSources(body, session.root);
    if (json.writeValueAsBytes(body).length > 16384)
      body = object("message", "Debugger event exceeded the 16 KB event limit");
    synchronized (session) {
      if (name.equals("stopped")) {
        session.state = "stopped";
        session.threadId = body.get("threadId");
      } else if (name.equals("continued")) {
        session.state = "attached";
        session.threadId = null;
      } else if (name.equals("terminated") || name.equals("exited")) {
        session.state = "terminated";
        session.threadId = null;
      }
      session.cursor = cursor.incrementAndGet();
      session.events.add(object("seq", session.cursor, "event", name, "body", copyMap(body)));
      if (session.events.size() > 256) session.events.remove(0);
    }
  }

  private Map<String, Object> sessionView(Session session) {
    if (session == null || session.state.equals("detached")) return null;
    return object(
        "id",
        session.id,
        "adapterId",
        session.adapterId,
        "state",
        session.state,
        "port",
        session.port,
        "host",
        "127.0.0.1",
        "processId",
        session.processId,
        "threadId",
        session.threadId,
        "capabilities",
        session.capabilities);
  }

  public synchronized void detach(String repositoryId) {
    workspace.requireRepository(repositoryId);
    detachSession(repositoryId);
  }

  private void detachSession(String repositoryId) {
    Session session = sessions.get(repositoryId);
    if (session == null) return;
    if (session.debugger != null) session.debugger.close();
    session.state = "detached";
    session.threadId = null;
  }

  public synchronized void stopRepository(String repositoryId) {
    disconnectRepository(repositoryId);
    sessions.remove(repositoryId);
  }

  public synchronized void disconnectRepository(String repositoryId) {
    retired.add(repositoryId);
    detachSession(repositoryId);
  }

  public synchronized void releaseRepository(String repositoryId) {
    retired.remove(repositoryId);
  }

  @Override
  public String ownerName() {
    return "IDE debugger sessions";
  }

  @Override
  public int shutdownOrder() {
    return 75;
  }

  @Override
  @PreDestroy
  public synchronized void quiesce() {
    closing = true;
    RuntimeException failure = null;
    for (String repositoryId : List.copyOf(sessions.keySet()))
      try {
        detachSession(repositoryId);
      } catch (RuntimeException error) {
        if (failure == null) failure = error;
        else failure.addSuppressed(error);
      }
    if (failure != null) throw failure;
  }

  private int port(Object value) {
    long port = number(value);
    if (!text(value).matches("[0-9]{4,5}") || port < 1024 || port > 65535)
      throw new IllegalArgumentException("Debug port must be between 1024 and 65535");
    return (int) port;
  }

  private boolean executableAvailable(List<String> command) {
    return !command.isEmpty()
        && Path.of(command.get(0)).isAbsolute()
        && Files.isRegularFile(Path.of(command.get(0)))
        && Files.isExecutable(Path.of(command.get(0)))
        && !SHELLS.contains(Path.of(command.get(0)).getFileName().toString());
  }

  private List<Map<String, Object>> configuredAdapters() {
    if (!Files.exists(adaptersFile)) return List.of();
    try {
      if (Files.size(adaptersFile) > 65536)
        throw new IllegalArgumentException("Debug adapter configuration exceeds 64 KB");
      var adapters =
          list(map(json.readValue(Files.readString(adaptersFile), Map.class)).get("adapters"));
      if (adapters.size() > 16)
        throw new IllegalArgumentException("At most 16 local debug adapters are supported");
      var result = new ArrayList<Map<String, Object>>();
      var ids = new java.util.HashSet<String>();
      for (Object value : adapters) {
        var adapter = map(value);
        String id = text(adapter, "id");
        List<String> command = strings(adapter.get("command"));
        if (!id.matches("[a-zA-Z0-9_-]{1,64}")
            || id.equals("java-jdi")
            || id.equals("node-js-debug")
            || !ids.add(id)
            || !Set.of("java", "node").contains(text(adapter, "runtime"))
            || command.isEmpty()
            || command.size() > 64
            || command.stream().anyMatch(arg -> arg.contains("\0") || arg.length() > 8192)
            || !Path.of(command.get(0)).isAbsolute()
            || SHELLS.contains(Path.of(command.get(0)).getFileName().toString()))
          throw new IllegalArgumentException("Invalid local debug adapter configuration");
        result.add(copyMap(adapter));
      }
      return result;
    } catch (IOException error) {
      throw new IllegalStateException("Could not read local debug adapter configuration", error);
    }
  }
}
