package com.argus.planner.service;

import static com.argus.planner.service.DailyPlannerService.date;

import com.argus.planner.domain.PlannerModels.*;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Reconstructs daily evidence from immutable events, never from a task's current status. */
public final class PlannerReports {
  private PlannerReports() {}

  static Report build(Stored state, LocalDate from, LocalDate to, String groupBy, LocalDate today) {
    Map<String, TaskTiming> timings = PlannerTaskTiming.build(state, today);
    Map<String, Integer> missedByDate = PlannerTaskTiming.missedByDate(timings);
    Map<String, Event> originalEvidence = new HashMap<>();
    Set<String> completionEvidence = new HashSet<>();
    Map<String, String> keys = new HashMap<>();
    state.tasks().forEach(task -> keys.put(task.id(), task.key()));
    Map<String, List<String>> related = new HashMap<>();
    for (TaskLink link : state.links()) {
      related
          .computeIfAbsent(link.sourceTaskId(), ignored -> new ArrayList<>())
          .add(keys.get(link.targetTaskId()));
      related
          .computeIfAbsent(link.targetTaskId(), ignored -> new ArrayList<>())
          .add(keys.get(link.sourceTaskId()));
    }
    related
        .values()
        .forEach(
            list -> list.sort(Comparator.comparingLong(key -> Long.parseLong(key.substring(5)))));
    Map<String, LinkedHashMap<String, Row>> rows = new LinkedHashMap<>();
    for (LocalDate day = from; !day.isAfter(to); day = day.plusDays(1))
      rows.put(day.toString(), new LinkedHashMap<>());
    for (Event event : state.events()) {
      if (!"missed-planned-day".equals(event.kind()))
        originalEvidence.putIfAbsent(event.taskId(), event);
      if ("completed".equals(event.kind())) completionEvidence.add(event.taskId());
      switch (event.kind()) {
        case "created" -> {
          Row row = row(rows, event.date(), event);
          if (row != null) {
            row.planned = true;
            row.status = "todo";
          }
        }
        case "moved" -> {
          Row source = row(rows, event.fromDate(), event);
          if (source != null) {
            source.planned = true;
            source.moved = true;
            source.status = "moved";
            source.toDate = event.toDate();
          }
          Row destination = row(rows, event.toDate(), event);
          if (destination != null) {
            destination.planned = true;
            destination.fromDate = event.fromDate();
            destination.status = event.status();
          }
        }
        case "started", "completed", "reopened", "archived", "edited" -> {
          Row row = row(rows, event.date(), event);
          if (row != null) {
            row.status = event.status();
            if (!event.kind().equals("edited")) row.planned = true;
            if (event.kind().equals("started") || event.kind().equals("completed"))
              row.worked = true;
            if (event.kind().equals("completed")) row.completed = true;
          }
        }
        default -> {
          /* Forward-compatible events do not destroy known history. */
        }
      }
    }
    // Original plans remain accountable even if all later activity is outside this export.
    // Do not replace the immutable event title/notes with a renamed current task.
    for (Task task : state.tasks()) {
      TaskTiming timing = timings.get(task.id());
      Map<String, Row> plannedDay = rows.get(timing.plannedDate());
      if (plannedDay != null)
        plannedDay.computeIfAbsent(
                    task.id(), ignored -> new Row(task, originalEvidence.get(task.id())))
                .planned =
            true;
      if (!completionEvidence.contains(task.id()) && timing.completedDate() != null) {
        Map<String, Row> completedDay = rows.get(timing.completedDate());
        if (completedDay != null) {
          Row row =
              completedDay.computeIfAbsent(
                  task.id(), ignored -> new Row(task, originalEvidence.get(task.id())));
          row.planned = true;
          row.worked = true;
          row.completed = true;
          row.status = "done";
        }
      }
    }
    List<ReportDay> days = new ArrayList<>();
    for (var entry : rows.entrySet()) {
      List<ReportTask> tasks =
          entry.getValue().values().stream()
              .map(
                  row ->
                      row.view(
                          keys.getOrDefault(row.taskId, ""),
                          related.getOrDefault(row.taskId, List.of()),
                          timings.get(row.taskId)))
              .toList();
      boolean dayOff = !DailyPlannerService.eligible(date(entry.getKey()), state.daysOff());
      String label =
          state.daysOff().stream()
              .filter(d -> d.date().equals(entry.getKey()))
              .map(DayOff::label)
              .findFirst()
              .orElse(dayOff ? "Weekend" : "");
      days.add(
          new ReportDay(
              entry.getKey(),
              dayOff,
              label,
              summarize(tasks, missedByDate.getOrDefault(entry.getKey(), 0)),
              tasks));
    }
    List<ReportSprint> sprints = new ArrayList<>();
    Set<String> assigned = new HashSet<>();
    for (Sprint sprint : state.sprints()) {
      List<ReportDay> sprintDays =
          days.stream()
              .filter(
                  d ->
                      d.date().compareTo(sprint.startDate()) >= 0
                          && d.date().compareTo(sprint.endDate()) <= 0)
              .toList();
      if (sprintDays.isEmpty()) continue;
      sprintDays.forEach(day -> assigned.add(day.date()));
      sprints.add(
          new ReportSprint(
              sprint.id(),
              sprint.name(),
              sprint.startDate(),
              sprint.endDate(),
              summarizeDays(sprintDays),
              sprintDays));
    }
    List<ReportDay> unassigned =
        days.stream().filter(day -> !assigned.contains(day.date())).toList();
    if (!unassigned.isEmpty())
      sprints.add(
          new ReportSprint(
              "unassigned",
              "Outside sprints",
              from.toString(),
              to.toString(),
              summarizeDays(unassigned),
              unassigned));
    return new Report(
        from.toString(),
        to.toString(),
        groupBy,
        summarizeDays(days),
        List.copyOf(days),
        List.copyOf(sprints));
  }

  private static Row row(Map<String, LinkedHashMap<String, Row>> rows, String day, Event event) {
    Map<String, Row> daily = rows.get(day);
    if (daily == null) return null;
    Row row = daily.computeIfAbsent(event.taskId(), ignored -> new Row(event));
    // A later archive/reopen must not rewrite what was actually completed on that day.
    if (!row.completed) {
      row.title = event.title();
      row.notes = event.notes();
    }
    return row;
  }

  private static Summary summarizeDays(List<ReportDay> days) {
    return summarize(
        days.stream().flatMap(day -> day.tasks().stream()).toList(),
        days.stream().mapToInt(day -> day.summary().missedPlannedDay()).sum());
  }

  private static Summary summarize(List<ReportTask> tasks, int missedPlannedDay) {
    Set<String> planned = new HashSet<>(),
        worked = new HashSet<>(),
        completed = new HashSet<>(),
        moved = new HashSet<>();
    for (ReportTask task : tasks) {
      if (task.planned()) planned.add(task.taskId());
      if (task.worked()) worked.add(task.taskId());
      if (task.completed()) completed.add(task.taskId());
      if (task.moved()) moved.add(task.taskId());
    }
    return new Summary(
        planned.size(),
        worked.size(),
        completed.size(),
        moved.size(),
        planned.isEmpty() ? 0 : Math.round(completed.size() * 1000.0 / planned.size()) / 10.0,
        missedPlannedDay);
  }

  public static String csv(Report report) {
    StringBuilder out = new StringBuilder("\uFEFF");
    out.append(
        "Date,Sprint,Day off,Task key,Task UUID,Related task keys,Task,Notes,Status,Planned,Worked,Completed,Moved,From date,To date,Planned date,First completed date,Lateness (calendar days),Timing status,Missed original planned day,Day missed planned count\r\n");
    for (ReportDay day : report.daily()) {
      String sprint =
          report.groupBy().equals("sprint")
              ? report.sprints().stream()
                  .filter(s -> s.daily().stream().anyMatch(d -> d.date().equals(day.date())))
                  .map(ReportSprint::name)
                  .findFirst()
                  .orElse("")
              : "";
      if (day.tasks().isEmpty()) {
        List<String> values =
            new ArrayList<>(
                List.of(
                    day.date(),
                    sprint,
                    day.dayOff() ? (day.label().isBlank() ? "Day off" : day.label()) : ""));
        while (values.size() < 20) values.add("");
        values.add(String.valueOf(day.summary().missedPlannedDay()));
        csvLine(out, values);
      } else
        for (ReportTask task : day.tasks()) {
          csvLine(
              out,
              List.of(
                  day.date(),
                  sprint,
                  day.dayOff() ? (day.label().isBlank() ? "Day off" : day.label()) : "",
                  task.key(),
                  task.taskId(),
                  String.join("; ", task.relatedTaskKeys()),
                  task.title(),
                  task.notes(),
                  task.status(),
                  yes(task.planned()),
                  yes(task.worked()),
                  yes(task.completed()),
                  yes(task.moved()),
                  safe(task.fromDate()),
                  safe(task.toDate()),
                  safe(task.plannedDate()),
                  safe(task.completedDate()),
                  task.latenessDays() == null ? "" : task.latenessDays().toString(),
                  task.timingStatus(),
                  yes(task.missedPlannedDay()),
                  String.valueOf(day.summary().missedPlannedDay())));
        }
    }
    return out.toString();
  }

  private static void csvLine(StringBuilder out, List<String> values) {
    for (int i = 0; i < values.size(); i++) {
      if (i > 0) out.append(',');
      String value = safe(values.get(i));
      // Excel and other spreadsheets interpret leading whitespace/control + formulas as executable.
      String probe = value.replaceFirst("^[\\s\\p{Cc}\\p{Cf}]+", "");
      // Columns 17 and 20 come only from integer day/count fields, never user text.
      if (i != 17 && i != 20 && !probe.isEmpty() && "=+-@".indexOf(probe.charAt(0)) >= 0)
        value = "'" + value;
      out.append('"').append(value.replace("\"", "\"\"")).append('"');
    }
    out.append("\r\n");
  }

  public static String html(Report report) {
    StringBuilder out =
        new StringBuilder(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\"><title>Argus daily tasks report</title><style>body{font:14px/1.5 system-ui,sans-serif;color:#18222d;max-width:1100px;margin:32px auto;padding:0 24px}h1{margin:0}h2{margin-top:28px;border-bottom:2px solid #637fa3;padding-bottom:6px}h3{margin:20px 0 6px}.summary{display:flex;gap:24px;flex-wrap:wrap;padding:16px;background:#edf3f8;border-radius:10px}.muted{color:#566579}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{padding:8px;border-bottom:1px solid #d6dee6;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#edf3f8}th:first-child{width:40%}small{display:block;white-space:pre-wrap}section{break-inside:avoid}footer{margin-top:30px;color:#566579}@media print{body{margin:0;padding:0;font-size:10pt}.summary,th{print-color-adjust:exact}thead{display:table-header-group}}</style></head><body><h1>Daily tasks</h1><p class=\"muted\">");
    out.insert(
        out.indexOf("</style>"),
        ".timing{display:inline-block;border-radius:4px;padding:2px 6px;font-weight:600}.timing-on-time{background:#dcfce7;color:#166534}.timing-late,.timing-overdue{background:#fef3c7;color:#854d0e}.timing-very-late,.timing-very-overdue{background:#e7d3bc;color:#69452a}.timing-pending{background:#edf3f8;color:#566579}.legend{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}.timing{print-color-adjust:exact;-webkit-print-color-adjust:exact}");
    out.append(escape(report.from()))
        .append(" – ")
        .append(escape(report.to()))
        .append(" · Argus</p>");
    summary(out, report.summary());
    out.append(
        "<div class=\"legend\" aria-label=\"Timing legend\"><span class=\"timing timing-on-time\">Green · on time or early</span><span class=\"timing timing-late\">Yellow · 1–2 calendar days late or overdue</span><span class=\"timing timing-very-late\">Brown · 3+ calendar days late or overdue</span></div>");
    if (report.groupBy().equals("sprint")) {
      for (ReportSprint sprint : report.sprints()) {
        out.append("<h2>").append(escape(sprint.name())).append("</h2>");
        summary(out, sprint.summary());
        sprint.daily().forEach(day -> day(out, day));
      }
    } else report.daily().forEach(day -> day(out, day));
    return out.append(
            "<footer>Totals count unique tasks in the selected period. Each day preserves its own planned, worked, completed and moved history. Missed counts belong only to the original planned date and remain after late completion, reopening or archiving. Timing uses the first completion and calendar days, including weekends and days off. CSV exports contain the same timing labels; CSV does not support colors. Related task IDs show current links, including tasks outside this period. Use your browser's Print → Save as PDF to save a PDF.</footer></body></html>")
        .toString();
  }

  private static void summary(StringBuilder out, Summary summary) {
    out.append("<div class=\"summary\"><span>Planned <b>")
        .append(summary.planned())
        .append("</b></span><span>Worked <b>")
        .append(summary.worked())
        .append("</b></span><span>Completed <b>")
        .append(summary.completed())
        .append("</b></span><span>Moved <b>")
        .append(summary.moved())
        .append("</b></span><span>Missed planned day <b>")
        .append(summary.missedPlannedDay())
        .append("</b></span><span>Completion <b>")
        .append(summary.completionRate())
        .append("%</b></span></div>");
  }

  private static void day(StringBuilder out, ReportDay day) {
    out.append("<section><h3>").append(escape(day.date()));
    if (day.dayOff())
      out.append(" · ").append(escape(day.label().isBlank() ? "Day off" : day.label()));
    out.append("</h3><p class=\"muted\">Missed original planned day: <b>")
        .append(day.summary().missedPlannedDay())
        .append("</b></p>");
    if (day.tasks().isEmpty()) {
      out.append("<p class=\"muted\">No tasks recorded.</p></section>");
      return;
    }
    out.append(
        "<table><thead><tr><th>Task</th><th>Outcome</th><th>First-completion timing</th><th>Movement</th></tr></thead><tbody>");
    for (ReportTask task : day.tasks()) {
      out.append("<tr><td>").append(escape(task.title()));
      out.append("<small class=\"muted\">").append(escape(task.key()));
      if (!task.relatedTaskKeys().isEmpty()) {
        out.append(" · Related: ").append(escape(String.join(", ", task.relatedTaskKeys())));
      }
      out.append("</small>");
      if (!safe(task.notes()).isBlank())
        out.append("<small>").append(escape(task.notes())).append("</small>");
      List<String> outcomes = new ArrayList<>();
      if (task.worked()) outcomes.add("Worked");
      if (task.completed()) outcomes.add("Completed");
      if (task.moved()) outcomes.add("Moved");
      if (outcomes.isEmpty()) outcomes.add(task.status());
      out.append("</td><td>").append(escape(String.join(" · ", outcomes))).append("</td><td>");
      String timing =
          switch (safe(task.timingStatus())) {
            case "on-time", "late", "very-late", "overdue", "very-overdue" -> task.timingStatus();
            default -> "pending";
          };
      out.append("<span class=\"timing timing-")
          .append(timing)
          .append("\">")
          .append(escape(timing.replace('-', ' ')))
          .append("</span>")
          .append("<small>Planned: ")
          .append(escape(task.plannedDate()))
          .append("</small>");
      if (task.completedDate() != null)
        out.append("<small>First completed: ")
            .append(escape(task.completedDate()))
            .append("</small>")
            .append("<small>Calendar-day difference: ")
            .append(task.latenessDays())
            .append("</small>");
      if (task.missedPlannedDay()) out.append("<small>Missed original planned day</small>");
      out.append("</td><td>");
      if (task.fromDate() != null)
        out.append("From ").append(escape(task.fromDate())).append("<br>");
      if (task.toDate() != null) out.append("To ").append(escape(task.toDate()));
      out.append("</td></tr>");
    }
    out.append("</tbody></table></section>");
  }

  private static String yes(boolean value) {
    return value ? "Yes" : "No";
  }

  private static String safe(String value) {
    return value == null ? "" : value;
  }

  private static String escape(String value) {
    return safe(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")
        .replace("'", "&#39;");
  }

  private static final class Row {
    final String taskId;
    String title, notes, status = "todo", fromDate, toDate;
    boolean planned, worked, completed, moved;

    Row(Event event) {
      taskId = event.taskId();
      title = event.title();
      notes = event.notes();
    }

    Row(Task task, Event evidence) {
      taskId = task.id();
      title = evidence == null ? task.title() : evidence.title();
      notes = evidence == null ? task.notes() : evidence.notes();
    }

    ReportTask view(String key, List<String> relatedTaskKeys, TaskTiming timing) {
      return new ReportTask(
          taskId,
          title,
          notes,
          status,
          planned,
          worked,
          completed,
          moved,
          fromDate,
          toDate,
          key,
          List.copyOf(relatedTaskKeys),
          timing == null ? null : timing.plannedDate(),
          timing == null ? null : timing.completedDate(),
          timing == null ? null : timing.latenessDays(),
          timing == null ? "pending" : timing.timingStatus(),
          timing != null && timing.missedPlannedDay());
    }
  }
}
