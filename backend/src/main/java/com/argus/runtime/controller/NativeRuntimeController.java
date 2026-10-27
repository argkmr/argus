package com.argus.runtime.controller;

import com.argus.runtime.service.*;
import com.argus.workspace.service.WorkspaceService;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class NativeRuntimeController {
  private final RuntimeConfigurationService runtime;
  private final ProcessManager processes;
  private final WorkspaceService workspace;
  private final JavaProjectService javaProjects;
  private final ProjectStructureService structures;
  private final RuntimePortService portEditor;

  public NativeRuntimeController(
      RuntimeConfigurationService runtime,
      ProcessManager processes,
      WorkspaceService workspace,
      JavaProjectService javaProjects,
      ProjectStructureService structures) {
    this(runtime, processes, workspace, javaProjects, structures, null);
  }

  @org.springframework.beans.factory.annotation.Autowired
  public NativeRuntimeController(
      RuntimeConfigurationService runtime,
      ProcessManager processes,
      WorkspaceService workspace,
      JavaProjectService javaProjects,
      ProjectStructureService structures,
      RuntimePortService portEditor) {
    this.runtime = runtime;
    this.processes = processes;
    this.workspace = workspace;
    this.javaProjects = javaProjects;
    this.structures = structures;
    this.portEditor = portEditor;
  }

  @GetMapping("/processes")
  public List<Map<String, Object>> processes() {
    return processes.summaries();
  }

  @GetMapping("/runtime-state")
  public Map<String, Object> runtimeState() {
    return workspace.runtimeState();
  }

  @PostMapping("/processes/stop-services")
  public Map<String, Object> stopServices() {
    return processes.stopServices();
  }

  @GetMapping("/runtime-detections")
  public List<Map<String, Object>> detections() {
    return runtime.detections();
  }

  @GetMapping("/repositories/{id}/run-configuration-template")
  public Map<String, Object> template(
      @PathVariable String id, @RequestParam(required = false) String configurationId) {
    return runtime.template(id, configurationId);
  }

  @PostMapping("/run-configurations")
  @ResponseStatus(HttpStatus.CREATED)
  public Map<String, Object> save(@RequestBody Map<String, Object> input) {
    return runtime.save(input);
  }

  @DeleteMapping("/run-configurations/{id}")
  public Map<String, Object> remove(@PathVariable String id) {
    runtime.remove(id);
    return Map.of("ok", true);
  }

  @PostMapping("/run-configurations/{id}/{action:start|stop|restart}")
  public ResponseEntity<Map<String, Object>> action(
      @PathVariable String id,
      @PathVariable String action,
      @RequestBody(required = false) Map<String, Object> input) {
    return ResponseEntity.status(action.equals("stop") ? 200 : 201)
        .body(runtime.action(id, action, input == null ? Map.of() : input));
  }

  @PostMapping("/run-configurations/{id}/ports")
  public Map<String, Object> ports(
      @PathVariable String id, @RequestBody Map<String, Object> input) {
    return input.containsKey("expectedContentHash") || !input.containsKey("managementPort")
        ? portEditor.update(id, input)
        : runtime.ports(id, input);
  }

  @GetMapping("/run-configurations/{id}/ports")
  public Map<String, Object> inspectPorts(@PathVariable String id) {
    return portEditor.inspect(id);
  }

  @GetMapping("/repositories/{id}/ports")
  public Map<String, Object> repositoryPorts(@PathVariable String id) {
    return portEditor.repositoryPorts(id);
  }

  @GetMapping("/processes/{id}/logs")
  public Map<String, Object> logs(
      @PathVariable String id, @RequestParam(defaultValue = "0") long after) {
    return processes.logs(id, after);
  }

  @GetMapping("/repositories/{id}/java-project")
  public Map<String, Object> inspectJava(@PathVariable String id) {
    return javaProjects.inspect(workspace.requireRepository(id), workspace.javaSettings(id));
  }

  @PutMapping("/repositories/{id}/java-project")
  public Map<String, Object> saveJava(
      @PathVariable String id, @RequestBody Map<String, Object> input) {
    var repository = workspace.requireRepository(id);
    workspace.saveJavaSettings(id, javaProjects.validateSettings(repository, input));
    return javaProjects.inspect(repository, workspace.javaSettings(id));
  }

  @GetMapping("/repositories/{id}/project-structure")
  public Map<String, Object> structure(@PathVariable String id) {
    return structures.inspect(workspace.requireRepository(id), workspace.javaSettings(id));
  }

  @PostMapping("/repositories/{id}/project-structure/run")
  public Map<String, Object> command(
      @PathVariable String id, @RequestBody Map<String, Object> input) {
    return Map.of(
        "command",
        structures.command(
            workspace.requireRepository(id),
            RuntimeData.text(input, "action"),
            RuntimeData.text(input, "script")));
  }

  @PostMapping("/repositories/{id}/project-structure/maintenance")
  @ResponseStatus(HttpStatus.CREATED)
  public Map<String, Object> maintenance(
      @PathVariable String id, @RequestBody Map<String, Object> input) {
    var repository = workspace.requireRepository(id);
    String action = RuntimeData.text(input, "action"),
        configurationId = RuntimeData.text(input, "configurationId");
    boolean synthetic = configurationId.isEmpty() || configurationId.equals("repository:" + id);
    if (synthetic) configurationId = "repository:" + id;
    else {
      var config = workspace.runConfiguration(configurationId);
      if (!id.equals(config.get("repositoryId")))
        throw new IllegalArgumentException("Run configuration does not belong to this repository");
    }
    var task = structures.maintenance(repository, action);
    Map<String, Object> detected;
    try {
      detected = runtime.resolve(repository, null);
    } catch (RuntimeException error) {
      detected = Map.of();
    }
    var configuration =
        RuntimeData.object(
            "id",
            configurationId,
            "name",
            repository.name(),
            "cwd",
            ".",
            "stage",
            action.equals("sync") ? "syncing" : "testing",
            "task",
            action,
            "runtimeBin",
            detected.get("runtimeBin"),
            "runtimeLabel",
            detected.get("runtimeLabel"));
    configuration.putAll(task);
    var selected = runtime.projectRuntime(repository, configuration);
    var environment = new java.util.LinkedHashMap<String, String>();
    if (!synthetic) environment.putAll(runtime.maintenanceEnvironment(configurationId));
    RuntimeData.map(selected.get("environment"))
        .forEach((key, value) -> environment.put(key, RuntimeData.text(value)));
    var launch = RuntimeData.map(selected.get("configuration"));
    if (action.equals("sync")
        && RuntimeData.text(launch, "executable").matches("(?:\\./)?gradlew|gradle"))
      return processes.runGradleTask(
          launch, repository, environment, structures.gradleSyncScript());
    return processes.runTask(launch, repository, environment);
  }

  @PostMapping("/repositories/{id}/project-structure/maintenance/stop")
  public Map<String, Object> stopMaintenance(@PathVariable String id) {
    workspace.requireRepository(id);
    var process = processes.getByConfiguration("repository:" + id);
    if (process != null) processes.stop(RuntimeData.text(process, "id"));
    return Map.of("ok", true);
  }
}
