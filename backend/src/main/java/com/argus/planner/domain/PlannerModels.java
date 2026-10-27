package com.argus.planner.domain;

import java.util.List;
import java.util.Map;
import java.util.Set;

/** Date fields are ISO local dates in settings.timeZone; timestamps are UTC instants. */
public final class PlannerModels {
  private PlannerModels() {}

  public record Settings(
      String startTime, String endTime, String timeZone, boolean remindersEnabled) {}

  public record Task(
      String id,
      String title,
      String notes,
      String status,
      String date,
      String originalDate,
      String createdAt,
      String updatedAt,
      String completedAt,
      String key) {}

  /** Append-only evidence. Editing a title never rewrites an earlier day's report. */
  public record Event(
      String id,
      String taskId,
      String title,
      String notes,
      String date,
      String kind,
      String fromDate,
      String toDate,
      String at,
      String status,
      String reason) {}

  public record DayOff(String date, String label) {}

  public record Sprint(String id, String name, String startDate, String endDate) {}

  /** Undirected relationships reference stable task UUIDs, never dates or mutable titles. */
  public record TaskLink(
      String id, String sourceTaskId, String targetTaskId, String type, String createdAt) {}

  public record Stored(
      long revision,
      Settings settings,
      List<Task> tasks,
      List<Event> events,
      List<DayOff> daysOff,
      List<Sprint> sprints,
      Set<String> deliveredReminders,
      Long nextTaskNumber,
      List<TaskLink> links) {}

  public record Snapshot(
      long revision,
      String today,
      String nextWorkday,
      Settings settings,
      List<Task> tasks,
      List<Event> events,
      List<DayOff> daysOff,
      List<Sprint> sprints,
      List<TaskLink> links,
      Map<String, TaskTiming> taskTimings,
      Map<String, Integer> missedByDate) {
    public Snapshot(
        long revision,
        String today,
        String nextWorkday,
        Settings settings,
        List<Task> tasks,
        List<Event> events,
        List<DayOff> daysOff,
        List<Sprint> sprints,
        List<TaskLink> links) {
      this(
          revision,
          today,
          nextWorkday,
          settings,
          tasks,
          events,
          daysOff,
          sprints,
          links,
          Map.of(),
          Map.of());
    }
  }

  /** Calendar-day accountability, independent of current archive/reopen status. */
  public record TaskTiming(
      String plannedDate,
      String completedDate,
      Integer latenessDays,
      String timingStatus,
      boolean missedPlannedDay) {}

  public record NewTask(String title, String notes, String date) {}

  public record AddTasks(Long revision, List<NewTask> tasks) {}

  public record EditTask(Long revision, String title, String notes, String status, String date) {}

  public record UpdateSettings(
      Long revision, String startTime, String endTime, String timeZone, Boolean remindersEnabled) {}

  public record UpdateDayOff(Long revision, String date, String label, Boolean off) {}

  public record AddSprint(Long revision, String name, String startDate, String endDate) {}

  public record AddLink(Long revision, String sourceTaskId, String targetTaskId, String type) {}

  public record Notification(String id, String title, String body, String date, String kind) {}

  public record Reminders(List<Notification> notifications, Settings settings) {}

  public record Summary(
      int planned,
      int worked,
      int completed,
      int moved,
      double completionRate,
      int missedPlannedDay) {
    public Summary(int planned, int worked, int completed, int moved, double completionRate) {
      this(planned, worked, completed, moved, completionRate, 0);
    }
  }

  public record ReportTask(
      String taskId,
      String title,
      String notes,
      String status,
      boolean planned,
      boolean worked,
      boolean completed,
      boolean moved,
      String fromDate,
      String toDate,
      String key,
      List<String> relatedTaskKeys,
      String plannedDate,
      String completedDate,
      Integer latenessDays,
      String timingStatus,
      boolean missedPlannedDay) {
    public ReportTask(
        String taskId,
        String title,
        String notes,
        String status,
        boolean planned,
        boolean worked,
        boolean completed,
        boolean moved,
        String fromDate,
        String toDate,
        String key,
        List<String> relatedTaskKeys) {
      this(
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
          relatedTaskKeys,
          null,
          null,
          null,
          "pending",
          false);
    }
  }

  public record ReportDay(
      String date, boolean dayOff, String label, Summary summary, List<ReportTask> tasks) {}

  public record ReportSprint(
      String id,
      String name,
      String startDate,
      String endDate,
      Summary summary,
      List<ReportDay> daily) {}

  public record Report(
      String from,
      String to,
      String groupBy,
      Summary summary,
      List<ReportDay> daily,
      List<ReportSprint> sprints) {}
}
