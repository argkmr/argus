package com.argus.ide;

import com.argus.common.error.ConflictException;
import com.argus.platform.NativeBackgroundOwner;
import com.argus.workspace.service.WorkspaceService;
import jakarta.annotation.PreDestroy;
import java.net.URI;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** Optional per-repository language workers: no process is started by status or file browsing. */
@Service
public class IdeService implements NativeBackgroundOwner {
  private final WorkspaceService workspace;
  private final IdeFiles files;
  private final IdeLanguageServers servers;
  private final ObjectMapper json;
  private final IdeJavaProjectSettings javaProjects;
  private final IdeConfigurationNavigation configurationNavigation;
  private final Map<String, Session> sessions = new ConcurrentHashMap<>();
  private final Map<String, String> failures = new ConcurrentHashMap<>();
  private final java.util.Set<String> offboarded = ConcurrentHashMap.newKeySet();
  private boolean closing;

  public record Location(String path, int line, int column, int endLine, int endColumn) {}

  public record Navigation(List<Location> locations, String notice, boolean selectionRequired) {
    public Navigation(List<Location> locations, String notice) {
      this(locations, notice, false);
    }
  }

  public IdeService(
      WorkspaceService workspace, IdeFiles files, IdeLanguageServers servers, ObjectMapper json) {
    this(workspace, files, servers, json, null);
  }

  @org.springframework.beans.factory.annotation.Autowired
  public IdeService(
      WorkspaceService workspace,
      IdeFiles files,
      IdeLanguageServers servers,
      ObjectMapper json,
      IdeJavaProjectSettings javaProjects) {
    this.workspace = workspace;
    this.files = files;
    this.servers = servers;
    this.json = json;
    this.javaProjects = javaProjects;
    this.configurationNavigation = new IdeConfigurationNavigation(files);
  }

  public Path root(String id) {
    if (offboarded.contains(id)) throw new IllegalStateException("Repository is being offboarded");
    return Path.of(workspace.requireRepository(id).path());
  }

  public Map<String, Object> status(String id) {
    root(id);
    var languages = new ArrayList<Map<String, Object>>();
    for (String language : IdeLanguageServers.LANGUAGES) {
      var command = servers.discover(id, language);
      var session = sessions.get(key(id, language));
      boolean running = session != null && session.client.alive();
      boolean trustedProject = servers.trustedProject(id, language);
      var item = new LinkedHashMap<String, Object>();
      item.put("language", language);
      item.put("label", command.label());
      item.put("available", command.available());
      item.put("running", running);
      item.put("initializing", running && !session.ready.isDone());
      item.put(
          "ready", running && session.ready.isDone() && !session.ready.isCompletedExceptionally());
      item.put("executable", command.executable());
      item.put("args", command.args());
      item.put("logDirectory", servers.logDirectory(id, command));
      item.put("trustedProject", trustedProject);
      item.put("capabilities", capabilities(session));
      item.put(
          "notice",
          running && !session.ready.isDone()
              ? session.client.serviceStatus()
              : session != null && !session.client.failure().isBlank()
                  ? session.client.failure()
                  : failures.getOrDefault(
                      key(id, language),
                      running && "java".equals(language)
                          ? session.trusted
                              ? "Java language service is ready. Trusted project import is enabled."
                              : "Java project import is disabled. Enable Java indexing in Language tools to resolve methods across project files."
                          : "java".equals(language) && trustedProject && command.available()
                              ? "This Java project is trusted. Its language server starts on demand."
                              : command.notice()));
      languages.add(item);
    }
    return Map.of(
        "available",
        true,
        "running",
        languages.stream().anyMatch(item -> Boolean.TRUE.equals(item.get("running"))),
        "languages",
        languages,
        "notice",
        "Language servers start on demand. Navigation uses saved files. Build import requires explicit project trust.");
  }

  public synchronized Map<String, Object> configure(
      String id, String language, String executable, List<String> args) {
    root(id);
    servers.configure(id, language, executable, args);
    stopLanguage(id, IdeLanguageServers.canonical(language));
    return status(id);
  }

  public Map<String, Object> start(String id, String language, boolean trustProject) {
    String canonical = IdeLanguageServers.canonical(language);
    synchronized (this) {
      root(id);
      if (closing || offboarded.contains(id))
        throw new IllegalStateException("IDE session is closing");
      servers.setTrustedProject(id, canonical, trustProject);
      Session existing = sessions.get(key(id, canonical));
      if (existing != null && existing.trusted != trustProject) stopLanguage(id, canonical);
    }
    session(id, language, trustProject);
    return status(id);
  }

  /** Reload lazily after an explicit project sync; never grant trust or launch stopped workers. */
  public synchronized Map<String, Object> refresh(String id) {
    root(id);
    closeRepository(id);
    for (String language : IdeLanguageServers.LANGUAGES) failures.remove(key(id, language));
    return status(id);
  }

  private Session session(String id, String requested, boolean trustProject) {
    String language = IdeLanguageServers.canonical(requested);
    String key = key(id, language);
    Path root = files.resolve(root(id), ".", true);
    Session selected;
    boolean created = false;
    synchronized (this) {
      if (closing || offboarded.contains(id))
        throw new IllegalStateException("IDE session is closing");
      // Reopening the IDE honors only an explicit grant for this repository's real path.
      if ("java".equals(language)) trustProject = servers.trustedProject(id, language, root);
      selected = sessions.get(key);
      if (selected != null
          && (!selected.client.alive()
              || !selected.root.equals(root)
              || ("java".equals(language)
                  ? selected.trusted != trustProject
                  : trustProject && !selected.trusted))) {
        selected.close();
        sessions.remove(key);
        selected = null;
      }
      if (selected == null) {
        if (sessions.size() >= 2)
          throw new IllegalStateException(
              "Close another language server session before starting more (maximum 2 workers)");
        var command = servers.discover(id, language);
        if (!command.available()) throw new IllegalStateException(command.notice());
        servers.prepare(id, command);
        selected =
            new Session(
                id, language, root, trustProject, new LspClient(command.argv(), root, json));
        sessions.put(key, selected);
        failures.remove(key);
        created = true;
      }
    }
    if (created) {
      try {
        selected.initialize();
      } catch (RuntimeException error) {
        selected.ready.completeExceptionally(error);
        selected.close();
        synchronized (this) {
          // A revoke/restart can replace this worker while its initialization unwinds.
          // Only the still-current worker may publish a failure for this repository.
          if (sessions.remove(key, selected)) failures.put(key, error.getMessage());
        }
        throw error;
      }
    }
    selected.awaitReady();
    return selected;
  }

  public Navigation navigate(String id, String path, int line, int column, String kind) {
    return navigate(id, path, line, column, kind, null);
  }

  public Navigation navigate(
      String id, String path, int line, int column, String kind, String expectedHash) {
    if (expectedHash != null && !expectedHash.matches("[0-9a-f]{64}"))
      throw new IllegalArgumentException("expectedHash must be the contentHash of the opened file");
    String capability =
        switch (kind == null ? "" : kind) {
          case "definition" -> "definitionProvider";
          case "declaration" -> "declarationProvider";
          case "typeDefinition" -> "typeDefinitionProvider";
          case "references" -> "referencesProvider";
          case "implementation" -> "implementationProvider";
          default -> throw new IllegalArgumentException("Unsupported navigation kind");
        };
    IdeFiles.FileContent file = files.read(root(id), path);
    validateNavigationSnapshot(file, expectedHash);
    validatePosition(file.content(), line, column);
    if ("definition".equals(kind) || "declaration".equals(kind)) {
      Navigation configuration = configurationNavigation.navigate(root(id), file, line, column);
      if (configuration != null) {
        validateNavigationSnapshot(files.read(root(id), path), file.contentHash());
        return configuration;
      }
    }
    Session session;
    try {
      session = session(id, file.language(), false);
    } catch (IllegalArgumentException | IllegalStateException error) {
      return new Navigation(List.of(), error.getMessage());
    }
    synchronized (session) {
      String requestKind = kind;
      String fallbackNotice = "";
      if ("declaration".equals(kind)
          && !session.supports(capability)
          && session.supports("definitionProvider")) {
        requestKind = "definition";
        capability = "definitionProvider";
        fallbackNotice =
            "Declaration is not advertised by this language server; showing definition instead.";
      }
      if (!session.supports(capability))
        return new Navigation(
            List.of(), "This language server does not advertise " + kind + " support.");
      session.refreshDocuments();
      file = files.read(root(id), path);
      // Starting a language server can take time. Never apply a diff position to
      // a newer disk snapshot that arrived while the server was initializing.
      validateNavigationSnapshot(file, expectedHash);
      validatePosition(file.content(), line, column);
      session.open(file);
      var params = new LinkedHashMap<String, Object>();
      params.put("textDocument", Map.of("uri", session.uri(file.path())));
      params.put("position", Map.of("line", line - 1, "character", column - 1));
      if ("references".equals(kind)) params.put("context", Map.of("includeDeclaration", true));
      try {
        JsonNode result =
            session.client.request("textDocument/" + requestKind, params, Duration.ofSeconds(20));
        if ("declaration".equals(requestKind)
            && session.locations(result).isEmpty()
            && session.supports("definitionProvider")) {
          result =
              session.client.request("textDocument/definition", params, Duration.ofSeconds(20));
          fallbackNotice = "No declaration location was returned; showing definition instead.";
        }
        if (expectedHash != null)
          validateNavigationSnapshot(files.read(root(id), path), expectedHash);
        List<Location> locations = session.locations(result);
        return new Navigation(
            locations,
            locations.isEmpty()
                ? session.emptyNavigationNotice()
                : locations.size() >= IdeFiles.MAX_RESULTS
                    ? "Showing at most 200 locations; results may be truncated."
                    : fallbackNotice);
      } catch (IllegalStateException error) {
        synchronized (this) {
          if (sessions.get(key(id, session.language)) == session)
            failures.put(key(id, session.language), error.getMessage());
        }
        return new Navigation(List.of(), error.getMessage());
      }
    }
  }

  private static void validateNavigationSnapshot(IdeFiles.FileContent file, String expectedHash) {
    if (expectedHash != null && !file.contentHash().equals(expectedHash))
      throw new ConflictException("This file changed on disk. Reopen the diff before navigating.");
  }

  public IdeFiles.Search symbols(String id, String path, String query) {
    var results = new ArrayList<IdeFiles.Result>();
    var notices = new ArrayList<String>();
    if (path != null && !path.isBlank()) {
      var file = files.read(root(id), path);
      Session session;
      try {
        session = session(id, file.language(), false);
      } catch (IllegalStateException | IllegalArgumentException error) {
        return new IdeFiles.Search(List.of(), false, error.getMessage());
      }
      synchronized (session) {
        if (!session.supports("documentSymbolProvider"))
          return new IdeFiles.Search(
              List.of(), false, "Document symbols are unavailable from this language server.");
        session.refreshDocuments();
        file = files.read(root(id), path);
        session.open(file);
        try {
          collectDocumentSymbols(
              session.client.request(
                  "textDocument/documentSymbol",
                  Map.of("textDocument", Map.of("uri", session.uri(file.path()))),
                  Duration.ofSeconds(20)),
              file.path(),
              results,
              0);
        } catch (IllegalStateException error) {
          notices.add(error.getMessage());
        }
      }
    } else {
      root(id);
      if (query == null || query.isBlank())
        return new IdeFiles.Search(List.of(), false, "Enter a symbol name.");
      if (query.length() > 300) throw new IllegalArgumentException("Search query is too long");
      for (Session session : List.copyOf(sessions.values())) {
        if (!session.repositoryId.equals(id)
            || !session.client.alive()
            || !session.ready.isDone()
            || !session.supports("workspaceSymbolProvider")) continue;
        synchronized (session) {
          try {
            session.refreshDocuments();
            JsonNode result =
                session.client.request(
                    "workspace/symbol", Map.of("query", query), Duration.ofSeconds(10));
            if (result.isArray())
              for (JsonNode symbol : result) {
                Location location = session.location(symbol.path("location"));
                if (location != null)
                  results.add(
                      new IdeFiles.Result(
                          location.path(),
                          location.line(),
                          location.column(),
                          symbol.path("name").asText(),
                          symbol.path("containerName").asText("")));
                if (results.size() >= IdeFiles.MAX_RESULTS) break;
              }
          } catch (IllegalStateException error) {
            notices.add(error.getMessage());
          }
        }
        if (results.size() >= IdeFiles.MAX_RESULTS) break;
      }
      if (results.isEmpty() && notices.isEmpty())
        notices.add(
            "No symbols returned. Start the relevant language server to search its workspace index.");
    }
    return new IdeFiles.Search(
        List.copyOf(results), results.size() >= IdeFiles.MAX_RESULTS, String.join(" ", notices));
  }

  private void collectDocumentSymbols(
      JsonNode values, String path, List<IdeFiles.Result> results, int depth) {
    if (!values.isArray() || depth > 32) return;
    for (JsonNode symbol : values) {
      if (results.size() >= IdeFiles.MAX_RESULTS) return;
      JsonNode range =
          symbol.has("selectionRange")
              ? symbol.path("selectionRange")
              : symbol.has("range") ? symbol.path("range") : symbol.path("location").path("range");
      if (range.has("start"))
        results.add(
            new IdeFiles.Result(
                path,
                range.path("start").path("line").asInt() + 1,
                range.path("start").path("character").asInt() + 1,
                symbol.path("name").asText(),
                symbol.path("detail").asText("")));
      collectDocumentSymbols(symbol.path("children"), path, results, depth + 1);
    }
  }

  private static void validatePosition(String content, int line, int column) {
    String[] lines = content.split("\n", -1);
    if (line < 1 || line > lines.length || column < 1 || column > lines[line - 1].length() + 1)
      throw new IllegalArgumentException("Cursor position is outside the saved file");
  }

  private static Map<String, Boolean> capabilities(Session session) {
    return Map.of(
        "definition",
        session != null && session.supports("definitionProvider"),
        "declaration",
        session != null
            && (session.supports("declarationProvider") || session.supports("definitionProvider")),
        "typeDefinition",
        session != null && session.supports("typeDefinitionProvider"),
        "references",
        session != null && session.supports("referencesProvider"),
        "implementation",
        session != null && session.supports("implementationProvider"),
        "documentSymbols",
        session != null && session.supports("documentSymbolProvider"),
        "workspaceSymbols",
        session != null && session.supports("workspaceSymbolProvider"));
  }

  public void stopRepository(String id) {
    disconnectRepository(id);
    servers.purgeRepository(id);
  }

  /** Disconnect runtime sessions while preserving language-server settings and caches. */
  public void disconnectRepository(String id) {
    synchronized (this) {
      offboarded.add(id);
    }
    closeRepository(id);
  }

  public synchronized void releaseRepository(String id) {
    offboarded.remove(id);
  }

  /** Closing the editor is reversible; offboarding permanently rejects new work for this id. */
  public void closeRepository(String id) {
    synchronized (this) {
      for (Session session : List.copyOf(sessions.values()))
        if (session.repositoryId.equals(id)) {
          session.close();
          sessions.remove(key(id, session.language), session);
        }
    }
  }

  private synchronized void stopLanguage(String id, String language) {
    Session session = sessions.remove(key(id, language));
    if (session != null) session.close();
    failures.remove(key(id, language));
  }

  private static String key(String id, String language) {
    return id + ":" + language;
  }

  @Override
  public String ownerName() {
    return "repository-ide-language-servers";
  }

  @Override
  public int shutdownOrder() {
    return 24;
  }

  @PreDestroy
  @Override
  public synchronized void quiesce() {
    closing = true;
    var errors = new ArrayList<RuntimeException>();
    for (Session session : List.copyOf(sessions.values())) {
      try {
        session.close();
        sessions.remove(key(session.repositoryId, session.language), session);
      } catch (RuntimeException error) {
        errors.add(error);
      }
    }
    if (!errors.isEmpty()) throw errors.get(0);
  }

  private final class Session {
    final String repositoryId;
    final String language;
    final Path root;
    final boolean trusted;
    final LspClient client;
    final CompletableFuture<Void> ready = new CompletableFuture<>();
    final LinkedHashMap<String, IdeFiles.FileContent> documents = new LinkedHashMap<>();
    volatile JsonNode capabilities = json.createObjectNode();
    int version;

    Session(String repositoryId, String language, Path root, boolean trusted, LspClient client) {
      this.repositoryId = repositoryId;
      this.language = language;
      this.root = root;
      this.trusted = trusted;
      this.client = client;
    }

    void initialize() {
      // JDT cold startup includes Eclipse plug-in loading and asynchronous project import.
      // One deadline covers both phases; no global lock is held while waiting.
      long startupDeadline = System.nanoTime() + Duration.ofSeconds(90).toNanos();
      Map<String, Object> settings =
          Map.of(
              "java",
                  javaProjects != null && "java".equals(language)
                      ? javaProjects.settings(repositoryId, trusted)
                      : IdeJavaProjectSettings.defaults(trusted),
              "rust-analyzer",
                  Map.of(
                      "checkOnSave",
                      false,
                      "cargo",
                      Map.of("buildScripts", Map.of("enable", false), "autoreload", false),
                      "procMacro",
                      Map.of("enable", false)),
              "gopls",
                  Map.of("env", Map.of("GOPROXY", "off", "GOSUMDB", "off", "GOTOOLCHAIN", "local")),
              "typescript", Map.of("disableAutomaticTypeAcquisition", true));
      client.settings(settings);
      var options = new LinkedHashMap<String, Object>();
      options.put("settings", settings);
      // These servers consume their initial settings directly, before didChangeConfiguration.
      if ("rust".equals(language)) {
        options.put("checkOnSave", false);
        options.put("cargo", Map.of("buildScripts", Map.of("enable", false), "autoreload", false));
        options.put("procMacro", Map.of("enable", false));
      }
      if ("go".equals(language))
        options.put("env", Map.of("GOPROXY", "off", "GOSUMDB", "off", "GOTOOLCHAIN", "local"));
      options.put("disableAutomaticTypingAcquisition", true);
      options.put("allowLocalPluginLoads", trusted);
      options.put("maxTsServerMemory", 512);
      String tsserver = System.getenv("ARGUS_IDE_TYPESCRIPT_SDK");
      if ("typescript".equals(language)) {
        var tsOptions = new LinkedHashMap<String, Object>();
        tsOptions.put("useSyntaxServer", "never");
        if (tsserver != null && !tsserver.isBlank()) tsOptions.put("path", tsserver);
        options.put("tsserver", tsOptions);
      }
      var params = new LinkedHashMap<String, Object>();
      params.put("processId", ProcessHandle.current().pid());
      params.put("rootUri", root.toUri().toString());
      params.put("clientInfo", Map.of("name", "Argus IDE", "version", "1"));
      params.put(
          "workspaceFolders",
          List.of(Map.of("uri", root.toUri().toString(), "name", root.getFileName().toString())));
      params.put(
          "capabilities",
          Map.of(
              "general",
              Map.of("positionEncodings", List.of("utf-16")),
              "workspace",
              Map.of("configuration", true, "workspaceFolders", true, "applyEdit", false),
              "textDocument",
              Map.of(
                  "documentSymbol",
                  Map.of("hierarchicalDocumentSymbolSupport", true),
                  "definition",
                  Map.of("linkSupport", true),
                  "declaration",
                  Map.of("linkSupport", true),
                  "typeDefinition",
                  Map.of("linkSupport", true),
                  "implementation",
                  Map.of("linkSupport", true))));
      params.put("initializationOptions", options);
      JsonNode response =
          client.request(
              "initialize", params, Duration.ofSeconds("java".equals(language) ? 90 : 45));
      capabilities = response.path("capabilities");
      String encoding = capabilities.path("positionEncoding").asText("utf-16");
      if (!"utf-16".equals(encoding))
        throw new IllegalStateException(
            "Language server selected an unsupported position encoding");
      client.notify("initialized", Map.of());
      client.notify("workspace/didChangeConfiguration", Map.of("settings", settings));
      // JDT advertises its Java command namespace. Its initialize response alone does not
      // mean the project model is usable: wait for the documented ServiceReady notification.
      if ("java".equals(language)) {
        for (JsonNode command : capabilities.path("executeCommandProvider").path("commands")) {
          if ("java.project.getAll".equals(command.asText())) {
            client.awaitJavaServiceReady(
                Duration.ofNanos(Math.max(1, startupDeadline - System.nanoTime())));
            break;
          }
        }
      }
      ready.complete(null);
    }

    void awaitReady() {
      try {
        ready.get("java".equals(language) ? 95 : 50, TimeUnit.SECONDS);
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        throw new IllegalStateException("Language server initialization interrupted", error);
      } catch (Exception error) {
        throw new IllegalStateException("Language server initialization failed", error);
      }
    }

    boolean supports(String capability) {
      JsonNode value = capabilities.path(capability);
      return ready.isDone()
          && !ready.isCompletedExceptionally()
          && client.alive()
          && (value.isObject() || value.asBoolean(false));
    }

    String emptyNavigationNotice() {
      if ("java".equals(language) && !trusted)
        return "Java project import is disabled. Open Language tools and enable Java indexing for this repository; cross-file methods need the project's classpath.";
      return "No repository-local locations returned by the language server. The symbol may be external, unresolved, or still indexing. Try again after indexing completes.";
    }

    String uri(String path) {
      return files.resolve(root, path, false).toUri().toString();
    }

    void refreshDocuments() {
      for (var previous : List.copyOf(documents.values())) {
        try {
          open(files.read(root, previous.path()));
        } catch (IllegalArgumentException | IllegalStateException error) {
          if (!client.alive()) throw error;
          client.notify(
              "textDocument/didClose",
              Map.of(
                  "textDocument", Map.of("uri", root.resolve(previous.path()).toUri().toString())));
          documents.remove(previous.path());
        }
      }
    }

    void open(IdeFiles.FileContent file) {
      IdeFiles.FileContent old = documents.get(file.path());
      if (old != null && old.contentHash().equals(file.contentHash())) return;
      if (old != null) {
        // Close/open also works with servers that advertise incremental-only synchronization.
        client.notify(
            "textDocument/didClose", Map.of("textDocument", Map.of("uri", uri(old.path()))));
        documents.remove(file.path());
      }
      if (documents.size() >= 16) {
        String eldest = documents.keySet().iterator().next();
        client.notify(
            "textDocument/didClose",
            Map.of("textDocument", Map.of("uri", root.resolve(eldest).toUri().toString())));
        documents.remove(eldest);
      }
      client.notify(
          "textDocument/didOpen",
          Map.of(
              "textDocument",
              Map.of(
                  "uri",
                  uri(file.path()),
                  "languageId",
                  file.language(),
                  "version",
                  ++version,
                  "text",
                  file.content())));
      documents.put(file.path(), file);
    }

    List<Location> locations(JsonNode result) {
      var locations = new ArrayList<Location>();
      if (result.isArray()) {
        for (JsonNode item : result) {
          Location location = location(item);
          if (location != null && !locations.contains(location)) locations.add(location);
          if (locations.size() >= IdeFiles.MAX_RESULTS) break;
        }
      } else {
        Location location = location(result);
        if (location != null) locations.add(location);
      }
      return List.copyOf(locations);
    }

    Location location(JsonNode item) {
      try {
        String target =
            item.has("targetUri") ? item.path("targetUri").asText() : item.path("uri").asText();
        URI uri = URI.create(target);
        if (!"file".equals(uri.getScheme())) return null;
        Path path = Path.of(uri).normalize();
        if (!path.startsWith(root)) return null;
        String relative = IdeFiles.relative(root, path);
        files.resolve(root, relative, false);
        JsonNode range =
            item.has("targetSelectionRange")
                ? item.path("targetSelectionRange")
                : item.has("targetRange") ? item.path("targetRange") : item.path("range");
        if (!range.has("start") || !range.has("end")) return null;
        int line = range.path("start").path("line").asInt(-1),
            column = range.path("start").path("character").asInt(-1),
            endLine = range.path("end").path("line").asInt(-1),
            endColumn = range.path("end").path("character").asInt(-1);
        if (line < 0 || column < 0 || endLine < line || endColumn < 0) return null;
        return new Location(relative, line + 1, column + 1, endLine + 1, endColumn + 1);
      } catch (RuntimeException ignored) {
        return null;
      }
    }

    void close() {
      boolean initialized = ready.isDone() && !ready.isCompletedExceptionally();
      ready.completeExceptionally(new IllegalStateException("Language server stopped"));
      if (initialized) client.shutdown();
      else client.close();
    }
  }
}
