package com.argus.planner.service;

import com.argus.planner.domain.PlannerModels.*;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/** Shared fixed-plan accountability. Mutable status and text never erase completion evidence. */
public final class PlannerTaskTiming {
  private PlannerTaskTiming() {}

  public static Map<String, TaskTiming> build(Stored state, LocalDate today) {
    return taskTimings(state, today);
  }

  public static Map<String, TaskTiming> taskTimings(Stored state, LocalDate today) {
    Map<String, LocalDate> firstCompleted = new HashMap<>();
    Set<String> recordedMisses = new HashSet<>();
    for (Event event : state.events()) {
      if ("completed".equals(event.kind()))
        firstCompleted.merge(
            event.taskId(),
            LocalDate.parse(event.date()),
            (first, next) -> first.isBefore(next) ? first : next);
      else if ("missed-planned-day".equals(event.kind())) recordedMisses.add(event.taskId());
    }
    ZoneId zone = ZoneId.of(state.settings().timeZone());
    Map<String, TaskTiming> result = new LinkedHashMap<>();
    for (Task task : state.tasks()) {
      LocalDate planned = LocalDate.parse(plannedDate(task));
      LocalDate completed = firstCompleted.get(task.id());
      if (completed == null && task.completedAt() != null && !task.completedAt().isBlank())
        completed = Instant.parse(task.completedAt()).atZone(zone).toLocalDate();
      if (completed == null && "done".equals(task.status()))
        completed = LocalDate.parse(task.date());
      Integer lateness =
          completed == null ? null : Math.toIntExact(ChronoUnit.DAYS.between(planned, completed));
      long overdue = ChronoUnit.DAYS.between(planned, today);
      String timingStatus =
          completed != null
              ? lateness <= 0 ? "on-time" : lateness <= 2 ? "late" : "very-late"
              : overdue <= 0 ? "pending" : overdue <= 2 ? "overdue" : "very-overdue";
      boolean missed =
          recordedMisses.contains(task.id())
              || (completed == null ? planned.isBefore(today) : completed.isAfter(planned));
      result.put(
          task.id(),
          new TaskTiming(
              planned.toString(),
              completed == null ? null : completed.toString(),
              lateness,
              timingStatus,
              missed));
    }
    return Collections.unmodifiableMap(result);
  }

  public static String plannedDate(Task task) {
    return task.originalDate() == null || task.originalDate().isBlank()
        ? task.date()
        : task.originalDate();
  }

  public static Map<String, Integer> missedByDate(Map<String, TaskTiming> timings) {
    Map<String, Integer> result = new TreeMap<>();
    for (TaskTiming timing : timings.values())
      if (timing.missedPlannedDay()) result.merge(timing.plannedDate(), 1, Integer::sum);
    return Collections.unmodifiableMap(result);
  }
}
