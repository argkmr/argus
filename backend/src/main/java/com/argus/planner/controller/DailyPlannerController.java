package com.argus.planner.controller;

import com.argus.planner.domain.PlannerModels.*;
import com.argus.planner.service.DailyPlannerService;
import com.argus.planner.service.PlannerReports;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/daily-planner")
public class DailyPlannerController {
  private final DailyPlannerService planner;

  public DailyPlannerController(DailyPlannerService planner) {
    this.planner = planner;
  }

  @GetMapping
  public Snapshot get() {
    return planner.snapshot();
  }

  @PostMapping("/tasks")
  public Snapshot add(@RequestBody AddTasks request) {
    return planner.addTasks(request);
  }

  @PatchMapping("/tasks/{id}")
  public Snapshot edit(@PathVariable String id, @RequestBody EditTask request) {
    return planner.editTask(id, request);
  }

  @DeleteMapping("/tasks/{id}")
  public Snapshot deleteTask(@PathVariable String id, @RequestParam Long revision) {
    return planner.deleteTask(id, revision);
  }

  @PutMapping("/settings")
  public Snapshot settings(@RequestBody UpdateSettings request) {
    return planner.updateSettings(request);
  }

  @PutMapping("/days-off")
  public Snapshot dayOff(@RequestBody UpdateDayOff request) {
    return planner.updateDayOff(request);
  }

  @PostMapping("/sprints")
  public Snapshot addSprint(@RequestBody AddSprint request) {
    return planner.addSprint(request);
  }

  @DeleteMapping("/sprints/{id}")
  public Snapshot deleteSprint(@PathVariable String id, @RequestParam Long revision) {
    return planner.deleteSprint(id, revision);
  }

  @PostMapping("/links")
  public Snapshot addLink(@RequestBody AddLink request) {
    return planner.addLink(request);
  }

  @DeleteMapping("/links/{id}")
  public Snapshot deleteLink(@PathVariable String id, @RequestParam Long revision) {
    return planner.deleteLink(id, revision);
  }

  @GetMapping("/reminders")
  public Reminders reminders() {
    return planner.reminders();
  }

  @PostMapping("/reminders/{id}/ack")
  public Reminders acknowledge(@PathVariable String id) {
    return planner.acknowledge(id);
  }

  @GetMapping("/report")
  public Report report(
      @RequestParam String from,
      @RequestParam String to,
      @RequestParam(defaultValue = "day") String groupBy) {
    return planner.report(from, to, groupBy);
  }

  @GetMapping("/report.csv")
  public ResponseEntity<String> csv(
      @RequestParam String from,
      @RequestParam String to,
      @RequestParam(defaultValue = "day") String groupBy) {
    Report report = planner.report(from, to, groupBy);
    return ResponseEntity.ok()
        .contentType(MediaType.parseMediaType("text/csv;charset=UTF-8"))
        .header(
            HttpHeaders.CONTENT_DISPOSITION,
            "attachment; filename=\"argus-tasks-" + report.from() + "-" + report.to() + ".csv\"")
        .header(HttpHeaders.CACHE_CONTROL, "no-store")
        .body(PlannerReports.csv(report));
  }

  @GetMapping("/report.html")
  public ResponseEntity<String> html(
      @RequestParam String from,
      @RequestParam String to,
      @RequestParam(defaultValue = "day") String groupBy) {
    Report report = planner.report(from, to, groupBy);
    return ResponseEntity.ok()
        .contentType(MediaType.parseMediaType("text/html;charset=UTF-8"))
        .header(
            HttpHeaders.CONTENT_DISPOSITION,
            "attachment; filename=\"argus-tasks-" + report.from() + "-" + report.to() + ".html\"")
        .header(HttpHeaders.CACHE_CONTROL, "no-store")
        .body(PlannerReports.html(report));
  }
}
