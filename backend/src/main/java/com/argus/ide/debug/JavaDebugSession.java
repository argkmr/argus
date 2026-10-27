package com.argus.ide.debug;

import static com.argus.runtime.service.RuntimeData.*;

import com.sun.jdi.*;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BiConsumer;

/**
 * Small JDI provider with DAP-shaped results. Never evaluates expressions or invokes target code.
 */
final class JavaDebugSession implements DebugSession {
  private record Frame(ThreadReference thread, int index) {}

  private static final class Breakpoint {
    final int id;
    final int line;
    boolean verified;

    Breakpoint(int id, int line) {
      this.id = id;
      this.line = line;
    }
  }

  private final VirtualMachine vm;
  private final Path root;
  private final BiConsumer<String, Map<String, Object>> events;
  private final Map<String, List<Breakpoint>> breakpoints = new LinkedHashMap<>();
  private final Map<Integer, Frame> frames = new LinkedHashMap<>();
  private final Map<Integer, Object> variables = new LinkedHashMap<>();
  private final Map<Integer, ThreadReference> threads = new LinkedHashMap<>();
  private final AtomicInteger ids = new AtomicInteger(1);
  private final Thread reader;
  private volatile boolean closed;
  // Own exactly one VM suspension while stopped. JDI's queued class-prepare/breakpoint
  // events have separate suspension counts and must always release their own EventSet.
  private boolean suspended;

  JavaDebugSession(Path root, int port, BiConsumer<String, Map<String, Object>> events) {
    this.root = root.toAbsolutePath().normalize();
    this.events = events;
    try {
      var connector =
          Bootstrap.virtualMachineManager().attachingConnectors().stream()
              .filter(item -> item.name().equals("com.sun.jdi.SocketAttach"))
              .findFirst()
              .orElseThrow(
                  () ->
                      new IllegalStateException(
                          "This Java runtime lacks the JDI socket connector"));
      var arguments = connector.defaultArguments();
      arguments.get("hostname").setValue("127.0.0.1");
      arguments.get("port").setValue(Integer.toString(port));
      arguments.get("timeout").setValue("5000");
      vm = connector.attach(arguments);
    } catch (Exception error) {
      throw new IllegalStateException(
          "Could not attach Java debugger to loopback port " + port + ": " + error.getMessage(),
          error);
    }
    var prepare = vm.eventRequestManager().createClassPrepareRequest();
    prepare.setSuspendPolicy(EventRequest.SUSPEND_ALL);
    prepare.enable();
    reader = new Thread(this::readEvents, "argus-java-debug-events");
    reader.setDaemon(true);
    reader.start();
  }

  @Override
  public synchronized Map<String, Object> command(String command, Map<String, Object> args) {
    if (closed) throw new IllegalStateException("The Java debug session has ended");
    try {
      return switch (command) {
        case "configurationDone" -> Map.of();
        case "setBreakpoints" -> setBreakpoints(args);
        case "threads" ->
            object(
                "threads",
                vm.allThreads().stream()
                    .filter(thread -> thread.status() != ThreadReference.THREAD_STATUS_ZOMBIE)
                    .map(thread -> object("id", threadId(thread), "name", thread.name()))
                    .toList());
        case "stackTrace" -> stack(args);
        case "scopes" -> scopes(args);
        case "variables" -> variables(args);
        case "continue" -> resume();
        case "next", "stepIn", "stepOut" -> step(command, args);
        case "pause" -> pause(args);
        default -> throw new IllegalArgumentException("Unsupported debugger command: " + command);
      };
    } catch (VMDisconnectedException error) {
      closed = true;
      throw new IllegalStateException("The target JVM disconnected", error);
    } catch (IncompatibleThreadStateException error) {
      throw new IllegalStateException("Pause the selected thread before inspecting it", error);
    }
  }

  private Map<String, Object> setBreakpoints(Map<String, Object> args) {
    String relative = text(map(args.get("source")), "path");
    Path file = inside(root, relative);
    if (!Files.isRegularFile(file))
      throw new IllegalArgumentException("Breakpoint source file does not exist");
    String source = root.relativize(file).toString().replace('\\', '/');
    var requested = list(args.get("breakpoints"));
    if (requested.size() > 200)
      throw new IllegalArgumentException("At most 200 breakpoints per file are supported");
    var next = new ArrayList<Breakpoint>();
    for (Object item : requested) {
      var breakpoint = map(item);
      if (breakpoint.containsKey("condition")
          || breakpoint.containsKey("hitCondition")
          || breakpoint.containsKey("logMessage"))
        throw new IllegalArgumentException(
            "The built-in Java debugger supports unconditional line breakpoints");
      long line = number(breakpoint.get("line"));
      if (line < 1 || line > 1_000_000)
        throw new IllegalArgumentException("Invalid breakpoint line");
      next.add(new Breakpoint(ids.getAndIncrement(), (int) line));
    }
    var manager = vm.eventRequestManager();
    manager.deleteEventRequests(
        new ArrayList<>(
            manager.breakpointRequests().stream()
                .filter(request -> source.equals(request.getProperty("source")))
                .toList()));
    breakpoints.put(source, next);
    for (ReferenceType type : vm.allClasses()) install(type, source, next, false);
    return object(
        "breakpoints", next.stream().map(point -> breakpointView(source, point)).toList());
  }

  private Map<String, Object> breakpointView(String source, Breakpoint point) {
    return object(
        "id",
        point.id,
        "verified",
        point.verified,
        "line",
        point.line,
        "source",
        object("path", source),
        "message",
        point.verified ? "" : "Waiting for a loaded class with executable code on this line");
  }

  private void install(ReferenceType type, String source, List<Breakpoint> points, boolean notify) {
    try {
      boolean matches =
          type.sourcePaths(null).stream()
              .map(path -> path.replace('\\', '/'))
              .anyMatch(path -> source.equals(path) || source.endsWith("/" + path));
      if (!matches) return;
      for (Breakpoint point : points) {
        boolean wasVerified = point.verified;
        for (Location location : type.locationsOfLine(point.line)) {
          var request = vm.eventRequestManager().createBreakpointRequest(location);
          request.putProperty("source", source);
          request.putProperty("breakpointId", point.id);
          request.setSuspendPolicy(EventRequest.SUSPEND_ALL);
          request.enable();
          point.verified = true;
        }
        if (notify && point.verified && !wasVerified)
          events.accept(
              "breakpoint",
              object("reason", "changed", "breakpoint", breakpointView(source, point)));
      }
    } catch (AbsentInformationException | ClassNotPreparedException ignored) {
      // Pending breakpoints remain explicitly unverified until executable line metadata exists.
    }
  }

  private int threadId(ThreadReference thread) {
    for (var entry : threads.entrySet()) if (entry.getValue().equals(thread)) return entry.getKey();
    int id = ids.getAndIncrement();
    threads.put(id, thread);
    return id;
  }

  private ThreadReference thread(Map<String, Object> args) {
    ThreadReference result = threads.get((int) number(args.get("threadId")));
    if (result == null) throw new IllegalArgumentException("Select a current debugger thread");
    return result;
  }

  private Map<String, Object> stack(Map<String, Object> args)
      throws IncompatibleThreadStateException {
    ThreadReference thread = thread(args);
    int start = (int) Math.max(0, number(args.get("startFrame")));
    int levels =
        (int) Math.min(100, number(args.get("levels")) > 0 ? number(args.get("levels")) : 50);
    var result = new ArrayList<Map<String, Object>>();
    int count = thread.frameCount();
    for (int index = start; index < Math.min(count, start + levels); index++) {
      Location location = thread.frame(index).location();
      int id = reference(frames, new Frame(thread, index));
      var frame =
          object(
              "id",
              id,
              "name",
              location.declaringType().name() + "." + location.method().name(),
              "line",
              Math.max(1, location.lineNumber()),
              "column",
              1);
      String source = source(location);
      if (!source.isBlank())
        frame.put(
            "source", object("path", source, "name", Path.of(source).getFileName().toString()));
      result.add(frame);
    }
    return object("stackFrames", result, "totalFrames", count);
  }

  private String source(Location location) {
    try {
      String path = location.sourcePath().replace('\\', '/');
      for (String known : breakpoints.keySet())
        if (known.equals(path) || known.endsWith("/" + path)) return known;
      for (String prefix : List.of("", "src/main/java/", "src/test/java/", "src/")) {
        Path candidate = inside(root, prefix + path);
        if (Files.isRegularFile(candidate))
          return root.relativize(candidate).toString().replace('\\', '/');
      }
    } catch (AbsentInformationException | IllegalArgumentException ignored) {
    }
    return "";
  }

  private <T> int reference(Map<Integer, T> references, T value) {
    if (references.size() >= 10000)
      throw new IllegalStateException("Debugger reference limit reached; resume and pause again");
    int id = ids.getAndIncrement();
    references.put(id, value);
    return id;
  }

  private Map<String, Object> scopes(Map<String, Object> args) {
    Frame frame = frames.get((int) number(args.get("frameId")));
    if (frame == null)
      throw new IllegalArgumentException("Stack frame expired; refresh the paused stack");
    return object(
        "scopes",
        List.of(
            object(
                "name",
                "Locals",
                "variablesReference",
                reference(variables, frame),
                "expensive",
                false)));
  }

  private Map<String, Object> variables(Map<String, Object> args)
      throws IncompatibleThreadStateException {
    Object value = variables.get((int) number(args.get("variablesReference")));
    if (value == null)
      throw new IllegalArgumentException("Variable reference expired; refresh the paused stack");
    var result = new ArrayList<Map<String, Object>>();
    if (value instanceof Frame entry) {
      StackFrame frame = entry.thread.frame(entry.index);
      if (frame.thisObject() != null) result.add(variable("this", frame.thisObject()));
      try {
        for (LocalVariable local : frame.visibleVariables().stream().limit(200).toList())
          result.add(variable(local.name(), frame.getValue(local)));
      } catch (AbsentInformationException ignored) {
        result.add(
            object(
                "name",
                "(locals unavailable)",
                "value",
                "Compile with debug variable information (-g)",
                "variablesReference",
                0));
      }
    } else if (value instanceof ArrayReference array) {
      int start = (int) Math.min(array.length(), Math.max(0, number(args.get("start"))));
      int count =
          (int) Math.min(200, number(args.get("count")) > 0 ? number(args.get("count")) : 100);
      for (int index = start; index < Math.min(array.length(), start + count); index++)
        result.add(variable("[" + index + "]", array.getValue(index)));
    } else if (value instanceof ObjectReference object) {
      for (Field field : object.referenceType().allFields().stream().limit(200).toList())
        result.add(variable(field.name(), object.getValue(field)));
    }
    return object("variables", result);
  }

  private Map<String, Object> variable(String name, Value value) {
    String display;
    int children = 0;
    if (value == null) display = "null";
    else if (value instanceof StringReference string) display = '"' + string.value() + '"';
    else if (value instanceof ArrayReference array) {
      display = array.type().name() + " (" + array.length() + ")";
      children = reference(variables, array);
    } else if (value instanceof ObjectReference object) {
      display = object.referenceType().name() + " @" + object.uniqueID();
      children = reference(variables, object);
    } else display = value.toString();
    if (display.length() > 8000) display = display.substring(0, 8000) + "…";
    return object(
        "name",
        name,
        "value",
        display,
        "type",
        value == null ? "null" : value.type().name(),
        "variablesReference",
        children);
  }

  private Map<String, Object> resume() {
    frames.clear();
    variables.clear();
    if (suspended) {
      suspended = false;
      vm.resume();
    }
    events.accept("continued", object("allThreadsContinued", true));
    return object("allThreadsContinued", true);
  }

  private Map<String, Object> step(String command, Map<String, Object> args) {
    ThreadReference thread = thread(args);
    if (!suspended) throw new IllegalStateException("Pause the thread before stepping");
    var manager = vm.eventRequestManager();
    manager.deleteEventRequests(new ArrayList<>(manager.stepRequests()));
    int depth =
        command.equals("stepIn")
            ? StepRequest.STEP_INTO
            : command.equals("stepOut") ? StepRequest.STEP_OUT : StepRequest.STEP_OVER;
    var request = manager.createStepRequest(thread, StepRequest.STEP_LINE, depth);
    request.addCountFilter(1);
    request.setSuspendPolicy(EventRequest.SUSPEND_ALL);
    request.enable();
    return resume();
  }

  private Map<String, Object> pause(Map<String, Object> args) {
    ThreadReference selected = thread(args);
    suspend();
    events.accept(
        "stopped",
        object("reason", "pause", "threadId", threadId(selected), "allThreadsStopped", true));
    return Map.of();
  }

  private void suspend() {
    if (!suspended) {
      vm.suspend();
      suspended = true;
    }
  }

  private void readEvents() {
    try {
      while (!closed) {
        EventSet set = vm.eventQueue().remove(500);
        if (set == null) continue;
        synchronized (this) {
          var stops = new ArrayList<Map<String, Object>>();
          for (Event event : set) {
            if (event instanceof ClassPrepareEvent prepare)
              breakpoints.forEach(
                  (source, points) -> install(prepare.referenceType(), source, points, true));
            else if (event instanceof LocatableEvent location
                && (event instanceof BreakpointEvent || event instanceof StepEvent)) {
              suspend();
              frames.clear();
              variables.clear();
              var body =
                  object(
                      "reason",
                      event instanceof BreakpointEvent ? "breakpoint" : "step",
                      "threadId",
                      threadId(location.thread()),
                      "allThreadsStopped",
                      true);
              if (event instanceof BreakpointEvent)
                body.put("hitBreakpointIds", List.of(event.request().getProperty("breakpointId")));
              stops.add(body);
            } else if (event instanceof VMDeathEvent || event instanceof VMDisconnectEvent)
              closed = true;
          }
          if (!closed) {
            set.resume();
            for (var body : stops) events.accept("stopped", body);
          }
        }
      }
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
    } catch (VMDisconnectedException ignored) {
    } finally {
      closed = true;
      events.accept("terminated", Map.of());
    }
  }

  @Override
  public boolean alive() {
    return !closed;
  }

  @Override
  public void close() {
    synchronized (this) {
      if (!closed) {
        closed = true;
        try {
          vm.dispose();
        } catch (VMDisconnectedException ignored) {
        }
      }
    }
    reader.interrupt();
    if (Thread.currentThread() != reader)
      try {
        reader.join(1500);
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
      }
    if (reader.isAlive()) throw new IllegalStateException("Java debug event reader did not stop");
  }
}
