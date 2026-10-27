package com.argus.planner.service;

import com.argus.common.config.ArgusProperties;
import com.argus.common.error.ConflictException;
import com.argus.common.error.NotFoundException;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.planner.domain.PlannerModels.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.DayOfWeek;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

/**
 * Independent from repositories, Nexus tasks, and provider sessions. No offboarding dependencies.
 */
@Service
public class DailyPlannerService {
  private static final Set<String> STATUSES = Set.of("todo", "in-progress", "done", "archived");
  private final Path path;
  private final AtomicJsonStore json;
  private final Clock clock;
  private Stored state;

  @Autowired
  public DailyPlannerService(ArgusProperties properties, AtomicJsonStore json) {
    this(properties, json, Clock.systemDefaultZone());
  }

  public DailyPlannerService(ArgusProperties properties, AtomicJsonStore json, Clock clock) {
    this.path = properties.dataDirectory().resolve("daily-planner.json");
    this.json = json;
    this.clock = clock;
  }

  public synchronized Snapshot snapshot() {
    reconcile();
    return view();
  }

  public synchronized Snapshot addTasks(AddTasks request) {
    if (request == null
        || request.tasks() == null
        || request.tasks().isEmpty()
        || request.tasks().size() > 100) {
      throw new IllegalArgumentException("Add between 1 and 100 tasks at a time");
    }
    return mutate(
        request.revision(),
        draft -> {
          if (draft.tasks.size() + request.tasks().size() > 20_000) {
            throw new IllegalArgumentException("The planner has reached its 20,000-task capacity");
          }
          for (NewTask input : request.tasks()) {
            if (input == null) throw new IllegalArgumentException("A task is required");
            String title = text(input.title(), "Task title", 240, true);
            String notes = text(input.notes(), "Task notes", 8_000, false);
            LocalDate date = availableDate(input.date(), draft, true);
            String at = clock.instant().toString();
            Task task =
                new Task(
                    id(),
                    title,
                    notes,
                    "todo",
                    date.toString(),
                    date.toString(),
                    at,
                    at,
                    null,
                    allocateKey(draft));
            draft.tasks.add(task);
            draft.events.add(event(task, date, "created", null, date.toString(), "manual"));
          }
        });
  }

  public synchronized Snapshot editTask(String taskId, EditTask request) {
    if (request == null) throw new IllegalArgumentException("Task changes are required");
    return mutate(
        request.revision(),
        draft -> {
          int index = index(draft, taskId);
          Task old = draft.tasks.get(index);
          String title =
              request.title() == null
                  ? old.title()
                  : text(request.title(), "Task title", 240, true);
          String notes =
              request.notes() == null
                  ? old.notes()
                  : text(request.notes(), "Task notes", 8_000, false);
          String status = request.status() == null ? old.status() : request.status();
          if (!STATUSES.contains(status)) throw new IllegalArgumentException("Unknown task status");
          if (old.status().equals("archived") && status.equals("done")) {
            throw new IllegalArgumentException(
                "Reopen an archived task before marking it complete");
          }
          LocalDate today = today(draft.settings);
          boolean recordWorkToday =
              "in-progress".equals(request.status())
                  && old.status().equals("in-progress")
                  && draft.events.stream()
                      .noneMatch(
                          event ->
                              event.taskId().equals(old.id())
                                  && event.date().equals(today.toString())
                                  && Set.of("started", "completed").contains(event.kind()));
          LocalDate date = date(old.date());
          boolean reopening =
              (old.status().equals("done") || old.status().equals("archived"))
                  && !status.equals("done")
                  && !status.equals("archived");
          if (request.date() != null && !request.date().equals(old.date())) {
            throw new IllegalArgumentException(
                "A task stays on its original planned day; edit or complete it without changing its date");
          }
          // The plan is immutable. Work and completion are recorded on their actual calendar day,
          // including weekends, days off and after work hours, without moving the original card.
          String completedAt =
              status.equals("done")
                  ? (old.status().equals("done") ? old.completedAt() : clock.instant().toString())
                  : status.equals("archived") ? old.completedAt() : null;
          Task updated =
              new Task(
                  old.id(),
                  title,
                  notes,
                  status,
                  date.toString(),
                  old.originalDate(),
                  old.createdAt(),
                  clock.instant().toString(),
                  completedAt,
                  old.key());
          if (!old.status().equals(status)) {
            String kind =
                reopening
                    ? "reopened"
                    : switch (status) {
                      case "done" -> "completed";
                      case "in-progress" -> "started";
                      case "archived" -> "archived";
                      default -> "reopened";
                    };
            draft.events.add(event(updated, today, kind, old.date(), updated.date(), "manual"));
            if (reopening && status.equals("in-progress")) {
              draft.events.add(
                  event(updated, today, "started", old.date(), updated.date(), "manual"));
            }
          } else if (recordWorkToday) {
            draft.events.add(
                event(updated, today, "started", old.date(), updated.date(), "manual"));
          }
          if (!old.title().equals(title) || !old.notes().equals(notes)) {
            // Keep already completed historical entries immutable, even if their current card is
            // edited.
            if (!old.status().equals("done")) {
              draft.events.add(event(updated, today, "edited", null, null, "manual"));
            }
          }
          draft.tasks.set(index, updated);
        });
  }

  public synchronized Snapshot updateSettings(UpdateSettings request) {
    if (request == null) throw new IllegalArgumentException("Settings are required");
    return mutate(
        request.revision(),
        draft -> {
          LocalTime start = time(request.startTime());
          LocalTime end = time(request.endTime());
          if (Duration.between(start, end).toMinutes() < 60) {
            throw new IllegalArgumentException(
                "The workday must end at least one hour after it starts; overnight days are not supported");
          }
          ZoneId zone;
          try {
            zone = ZoneId.of(request.timeZone() == null ? "" : request.timeZone());
          } catch (RuntimeException error) {
            throw new IllegalArgumentException("Choose a valid time zone");
          }
          if (request.remindersEnabled() == null)
            throw new IllegalArgumentException("Choose whether reminders are enabled");
          draft.settings =
              new Settings(
                  start.toString(), end.toString(), zone.getId(), request.remindersEnabled());
        });
  }

  public synchronized Snapshot updateDayOff(UpdateDayOff request) {
    if (request == null || request.off() == null)
      throw new IllegalArgumentException("A day-off date and choice are required");
    return mutate(
        request.revision(),
        draft -> {
          LocalDate offDate = boundedDate(request.date(), draft.settings);
          if (weekend(offDate))
            throw new IllegalArgumentException("Saturday and Sunday are already days off");
          draft.daysOff.removeIf(day -> day.date().equals(offDate.toString()));
          if (request.off()) {
            draft.daysOff.add(
                new DayOff(offDate.toString(), text(request.label(), "Day-off label", 120, false)));
            draft.daysOff.sort(Comparator.comparing(DayOff::date));
          }
        });
  }

  public synchronized Snapshot addSprint(AddSprint request) {
    if (request == null) throw new IllegalArgumentException("Sprint details are required");
    return mutate(
        request.revision(),
        draft -> {
          LocalDate start = boundedDate(request.startDate(), draft.settings);
          LocalDate end = boundedDate(request.endDate(), draft.settings);
          if (end.isBefore(start)
              || Duration.between(start.atStartOfDay(), end.atStartOfDay()).toDays() > 93) {
            throw new IllegalArgumentException("A sprint must cover between 1 and 94 days");
          }
          if (weekend(start) || weekend(end))
            throw new IllegalArgumentException("Start and end a sprint on weekdays");
          if (draft.sprints.stream()
              .anyMatch(
                  s -> !date(s.endDate()).isBefore(start) && !date(s.startDate()).isAfter(end))) {
            throw new ConflictException("Sprint dates overlap an existing sprint");
          }
          draft.sprints.add(
              new Sprint(
                  id(),
                  text(request.name(), "Sprint name", 120, true),
                  start.toString(),
                  end.toString()));
          draft.sprints.sort(Comparator.comparing(Sprint::startDate));
        });
  }

  public synchronized Snapshot deleteTask(String taskId, Long revision) {
    return mutate(
        revision,
        draft -> {
          draft.tasks.remove(index(draft, taskId));
          draft.events.removeIf(event -> taskId.equals(event.taskId()));
          draft.links.removeIf(
              link -> taskId.equals(link.sourceTaskId()) || taskId.equals(link.targetTaskId()));
        });
  }

  public synchronized Snapshot deleteSprint(String sprintId, Long revision) {
    return mutate(
        revision,
        draft -> {
          if (!draft.sprints.removeIf(s -> s.id().equals(sprintId)))
            throw new NotFoundException("Sprint not found");
        });
  }

  public synchronized Snapshot addLink(AddLink request) {
    if (request == null) throw new IllegalArgumentException("Task link details are required");
    return mutate(
        request.revision(),
        draft -> {
          if (!"related".equals(request.type())) {
            throw new IllegalArgumentException("Only related task links are supported");
          }
          String source = request.sourceTaskId(), target = request.targetTaskId();
          if (source == null || source.isBlank() || target == null || target.isBlank()) {
            throw new IllegalArgumentException("Choose two tasks to link");
          }
          if (source.equals(target))
            throw new IllegalArgumentException("A task cannot link to itself");
          index(draft, source);
          index(draft, target);
          String first = source.compareTo(target) < 0 ? source : target;
          String second = source.compareTo(target) < 0 ? target : source;
          if (draft.links.stream()
              .anyMatch(
                  link ->
                      link.sourceTaskId().equals(first) && link.targetTaskId().equals(second))) {
            throw new ConflictException("These tasks are already linked");
          }
          if (draft.links.size() >= 100_000)
            throw new IllegalArgumentException("The planner has reached its task-link capacity");
          draft.links.add(new TaskLink(id(), first, second, "related", clock.instant().toString()));
        });
  }

  public synchronized Snapshot deleteLink(String linkId, Long revision) {
    return mutate(
        revision,
        draft -> {
          if (!draft.links.removeIf(link -> link.id().equals(linkId)))
            throw new NotFoundException("Task link not found");
        });
  }

  public synchronized Reminders reminders() {
    reconcile();
    return dueReminders();
  }

  public synchronized Reminders acknowledge(String reminderId) {
    reconcile();
    if (state.deliveredReminders().contains(reminderId)) return dueReminders();
    if (dueReminders().notifications().stream().noneMatch(n -> n.id().equals(reminderId))) {
      throw new IllegalArgumentException("This reminder is no longer due");
    }
    Draft draft = new Draft(state);
    draft.delivered.add(reminderId);
    // Delivery is not a user-visible planner edit and must not invalidate an open task form.
    commit(draft, state.revision());
    return dueReminders();
  }

  public synchronized Report report(String from, String to, String groupBy) {
    reconcile();
    LocalDate first = date(from);
    LocalDate last = date(to);
    if (last.isBefore(first)
        || Duration.between(first.atStartOfDay(), last.atStartOfDay()).toDays() > 366) {
      throw new IllegalArgumentException("Choose a report range of up to one year");
    }
    if (!Set.of("day", "sprint").contains(groupBy))
      throw new IllegalArgumentException("Group reports by day or sprint");
    return PlannerReports.build(state, first, last, groupBy, today(state.settings()));
  }

  private Reminders dueReminders() {
    Settings settings = state.settings();
    ZonedDateTime now = now(settings);
    LocalDate day = now.toLocalDate();
    LocalTime local = now.toLocalTime();
    if (!settings.remindersEnabled()
        || !eligible(day, state.daysOff())
        || local.isBefore(time(settings.startTime()))
        || !local.isBefore(time(settings.endTime()))) {
      return new Reminders(List.of(), settings);
    }
    boolean end = !local.isBefore(time(settings.endTime()).minusHours(1));
    String kind = end ? "end" : "start";
    String notificationId = day + ":" + kind;
    if (state.deliveredReminders().contains(notificationId)
        || (!end && state.deliveredReminders().contains(day + ":end")))
      return new Reminders(List.of(), settings);
    long minuteNanos = Duration.ofMinutes(1).toNanos();
    long remainingMinutes =
        (Duration.between(local, time(settings.endTime())).toNanos() + minuteNanos - 1)
            / minuteNanos;
    boolean combined =
        Duration.between(time(settings.startTime()), time(settings.endTime()))
            .equals(Duration.ofHours(1));
    String endTitle =
        remainingMinutes
            + (remainingMinutes == 1 ? " minute" : " minutes")
            + " left in your workday";
    String endBody =
        combined
            ? "Add or review today's tasks in Argus, then close completed tasks. Unfinished tasks stay on their planned day."
            : "Close completed tasks in Argus. Unfinished tasks stay on their planned day.";
    return new Reminders(
        List.of(
            new Notification(
                notificationId,
                end ? endTitle : "Time to plan today's tasks",
                end ? endBody : "Add today's tasks and choose what to focus on in Argus.",
                day.toString(),
                kind)),
        settings);
  }

  private Snapshot mutate(Long revision, Consumer<Draft> action) {
    reconcile();
    if (revision == null || revision != state.revision()) {
      throw new ConflictException(
          "Your planner changed. Refresh it before saving; your draft has not been discarded.");
    }
    Draft draft = new Draft(state);
    action.accept(draft);
    commit(draft, state.revision() + 1);
    return view();
  }

  private void reconcile() {
    load();
    LocalDate today = today(state.settings());
    Map<String, TaskTiming> timings = PlannerTaskTiming.taskTimings(state, today);
    Set<String> recorded = new HashSet<>();
    for (Event event : state.events()) {
      if (event.kind().equals("missed-planned-day")) recorded.add(event.taskId());
    }
    Draft draft = null;
    for (Task task : state.tasks()) {
      TaskTiming timing = timings.get(task.id());
      LocalDate planned = date(timing.plannedDate());
      if (!planned.isBefore(today) || !timing.missedPlannedDay() || recorded.contains(task.id()))
        continue;
      // This evidence is never removed by completion, archive, reopen or a timezone/clock change.
      // The deadline is the calendar day, not the configured workday's end time.
      if (draft == null) draft = new Draft(state);
      draft.events.add(
          event(
              task, planned, "missed-planned-day", planned.toString(), null, "planned-day-ended"));
    }
    if (draft != null) commit(draft, state.revision() + 1);
  }

  private Event event(
      Task task, LocalDate date, String kind, String from, String to, String reason) {
    return new Event(
        id(),
        task.id(),
        task.title(),
        task.notes(),
        date.toString(),
        kind,
        from,
        to,
        clock.instant().toString(),
        task.status(),
        reason);
  }

  private void load() {
    if (state != null) return;
    if (Files.exists(path)) {
      Stored stored = json.read(path, Stored.class);
      if (stored == null
          || stored.settings() == null
          || stored.tasks() == null
          || stored.events() == null
          || stored.daysOff() == null
          || stored.sprints() == null
          || stored.deliveredReminders() == null) {
        throw new IllegalStateException(
            "Daily planner data is incomplete; it has been preserved for recovery");
      }
      Draft draft = new Draft(stored);
      boolean migrated = migrateTaskIdentity(draft, stored);
      migrated |= pinOriginalPlannedDates(draft);
      Stored loaded = immutable(draft, stored.revision() + (migrated ? 1 : 0));
      // Backfill is one atomic transaction. A write failure exposes neither half-migrated memory
      // nor unstable keys; the next attempt reuses the same original persisted task order.
      if (migrated) json.write(path, loaded);
      state = loaded;
    } else {
      state =
          new Stored(
              0,
              new Settings("09:00", "18:00", clock.getZone().getId(), false),
              List.of(),
              List.of(),
              List.of(),
              List.of(),
              Set.of(),
              1L,
              List.of());
    }
  }

  private boolean pinOriginalPlannedDates(Draft draft) {
    boolean changed = false;
    Set<String> completedEvidence = new HashSet<>();
    for (Event event : draft.events) {
      if (event.kind().equals("completed")) completedEvidence.add(event.taskId());
    }
    ZoneId storedZone = ZoneId.of(draft.settings.timeZone());
    for (int i = 0; i < draft.tasks.size(); i++) {
      Task old = draft.tasks.get(i);
      // Validate before publishing or writing any migration. A corrupt original date must not
      // silently become a different plan, and a failed atomic write must leave the source intact.
      String plannedDate = date(PlannerTaskTiming.plannedDate(old)).toString();
      boolean hasCompletionInstant = old.completedAt() != null && !old.completedAt().isBlank();
      if (!completedEvidence.contains(old.id())
          && (hasCompletionInstant || old.status().equals("done"))) {
        // Freeze every legacy fallback before pinning, reopening or changing the configured zone.
        // Even an already-pinned/archived card can carry the only surviving completion evidence.
        LocalDate completedDate =
            hasCompletionInstant
                ? Instant.parse(old.completedAt()).atZone(storedZone).toLocalDate()
                : date(old.date());
        draft.events.add(
            new Event(
                id(),
                old.id(),
                old.title(),
                old.notes(),
                completedDate.toString(),
                "completed",
                plannedDate,
                completedDate.toString(),
                hasCompletionInstant ? old.completedAt() : clock.instant().toString(),
                "done",
                "legacy-completion"));
        completedEvidence.add(old.id());
        changed = true;
      }
      if (plannedDate.equals(old.date()) && plannedDate.equals(old.originalDate())) continue;
      Task pinned =
          new Task(
              old.id(),
              old.title(),
              old.notes(),
              old.status(),
              plannedDate,
              plannedDate,
              old.createdAt(),
              old.updatedAt(),
              old.completedAt(),
              old.key());
      draft.tasks.set(i, pinned);
      draft.events.add(
          event(
              pinned,
              today(draft.settings),
              "schedule-pinned",
              old.date(),
              plannedDate,
              "fixed-planned-day"));
      changed = true;
    }
    return changed;
  }

  private void commit(Draft draft, long revision) {
    Stored replacement = immutable(draft, revision);
    // Publish only after the durable atomic replacement succeeds. A failed write changes no memory.
    json.write(path, replacement);
    state = replacement;
  }

  private Stored immutable(Draft draft, long revision) {
    return new Stored(
        revision,
        draft.settings,
        List.copyOf(draft.tasks),
        List.copyOf(draft.events),
        List.copyOf(draft.daysOff),
        List.copyOf(draft.sprints),
        Set.copyOf(draft.delivered),
        draft.nextTaskNumber,
        List.copyOf(draft.links));
  }

  private Snapshot view() {
    LocalDate today = today(state.settings());
    Map<String, TaskTiming> timings = PlannerTaskTiming.taskTimings(state, today);
    return new Snapshot(
        state.revision(),
        today.toString(),
        nextWorkday(today, state.daysOff()).toString(),
        state.settings(),
        state.tasks(),
        state.events(),
        state.daysOff(),
        state.sprints(),
        state.links(),
        timings,
        PlannerTaskTiming.missedByDate(timings));
  }

  private static boolean migrateTaskIdentity(Draft draft, Stored original) {
    Set<String> ids = new HashSet<>(), keys = new HashSet<>();
    long next = 1;
    for (Task task : draft.tasks) {
      if (task == null || task.id() == null || task.id().isBlank() || !ids.add(task.id())) {
        throw new IllegalStateException(
            "Daily planner task identities are invalid; data has been preserved for recovery");
      }
      if (task.key() != null) {
        long number = taskNumber(task.key());
        if (!keys.add(task.key()))
          throw new IllegalStateException(
              "Daily planner task keys are duplicated; data has been preserved for recovery");
        next = Math.max(next, number + 1);
      }
    }
    if (original.nextTaskNumber() != null && original.nextTaskNumber() < 1) {
      throw new IllegalStateException(
          "Daily planner task counter is invalid; data has been preserved for recovery");
    }
    draft.nextTaskNumber =
        Math.max(next, original.nextTaskNumber() == null ? 1 : original.nextTaskNumber());
    boolean changed =
        original.nextTaskNumber() == null
            || original.links() == null
            || draft.nextTaskNumber != original.nextTaskNumber();
    for (int i = 0; i < draft.tasks.size(); i++) {
      Task task = draft.tasks.get(i);
      if (task.key() == null) {
        draft.tasks.set(
            i,
            new Task(
                task.id(),
                task.title(),
                task.notes(),
                task.status(),
                task.date(),
                task.originalDate(),
                task.createdAt(),
                task.updatedAt(),
                task.completedAt(),
                allocateKey(draft)));
        changed = true;
      }
    }
    Set<String> linkIds = new HashSet<>(), relationships = new HashSet<>();
    for (TaskLink link : draft.links) {
      if (link == null
          || link.id() == null
          || link.id().isBlank()
          || !linkIds.add(link.id())
          || !"related".equals(link.type())
          || link.createdAt() == null
          || !ids.contains(link.sourceTaskId())
          || !ids.contains(link.targetTaskId())
          || link.sourceTaskId().compareTo(link.targetTaskId()) >= 0
          || !relationships.add(link.sourceTaskId() + "\0" + link.targetTaskId())) {
        throw new IllegalStateException(
            "Daily planner task links are invalid; data has been preserved for recovery");
      }
    }
    return changed;
  }

  private static long taskNumber(String key) {
    if (!key.matches("TASK-[1-9][0-9]*")) {
      throw new IllegalStateException(
          "Daily planner task key is invalid; data has been preserved for recovery");
    }
    try {
      long number = Long.parseLong(key.substring(5));
      if (number == Long.MAX_VALUE) throw new NumberFormatException();
      return number;
    } catch (NumberFormatException error) {
      throw new IllegalStateException(
          "Daily planner task key is outside the supported range; data has been preserved for recovery");
    }
  }

  private static String allocateKey(Draft draft) {
    if (draft.nextTaskNumber < 1 || draft.nextTaskNumber == Long.MAX_VALUE) {
      throw new IllegalStateException("Daily planner task IDs have reached their capacity");
    }
    return "TASK-" + draft.nextTaskNumber++;
  }

  private LocalDate availableDate(String raw, Draft draft, boolean futureOnly) {
    LocalDate value = boundedDate(raw, draft.settings);
    if (futureOnly && value.isBefore(today(draft.settings)))
      throw new IllegalArgumentException("Choose today or a future working day");
    if (!eligible(value, draft.daysOff))
      throw new IllegalArgumentException("Choose a weekday that is not marked as a day off");
    if (value.equals(today(draft.settings))
        && !now(draft.settings).toLocalTime().isBefore(time(draft.settings.endTime()))) {
      throw new IllegalArgumentException("Today's workday has ended. Choose the next working day");
    }
    return value;
  }

  private LocalDate boundedDate(String raw, Settings settings) {
    LocalDate value = date(raw);
    LocalDate current = today(settings);
    if (value.isBefore(current.minusYears(10)) || value.isAfter(current.plusYears(5))) {
      throw new IllegalArgumentException("Choose a date within the last 10 years or next 5 years");
    }
    return value;
  }

  static LocalDate date(String raw) {
    try {
      if (raw == null || !raw.matches("\\d{4}-\\d{2}-\\d{2}")) throw new IllegalArgumentException();
      return LocalDate.parse(raw);
    } catch (DateTimeParseException | IllegalArgumentException error) {
      throw new IllegalArgumentException("Use a valid YYYY-MM-DD date");
    }
  }

  private static LocalTime time(String raw) {
    try {
      if (raw == null || !raw.matches("\\d{2}:\\d{2}")) throw new IllegalArgumentException();
      return LocalTime.parse(raw);
    } catch (DateTimeParseException | IllegalArgumentException error) {
      throw new IllegalArgumentException("Use a valid 24-hour HH:mm time");
    }
  }

  private static String text(String raw, String label, int max, boolean required) {
    String value = raw == null ? "" : raw.strip();
    if ((required && value.isBlank()) || value.length() > max || value.indexOf('\0') >= 0) {
      throw new IllegalArgumentException(
          label + " must contain " + (required ? "1" : "0") + "–" + max + " characters");
    }
    return value;
  }

  private static boolean weekend(LocalDate day) {
    return day.getDayOfWeek() == DayOfWeek.SATURDAY || day.getDayOfWeek() == DayOfWeek.SUNDAY;
  }

  static boolean eligible(LocalDate day, List<DayOff> daysOff) {
    return !weekend(day) && daysOff.stream().noneMatch(d -> d.date().equals(day.toString()));
  }

  private static LocalDate eligibleOnOrAfter(LocalDate day, List<DayOff> daysOff) {
    for (int i = 0; i < 36_600; i++, day = day.plusDays(1)) if (eligible(day, daysOff)) return day;
    throw new IllegalStateException("No available working day in the supported calendar");
  }

  private static LocalDate nextWorkday(LocalDate day, List<DayOff> daysOff) {
    return eligibleOnOrAfter(day.plusDays(1), daysOff);
  }

  private ZonedDateTime now(Settings settings) {
    return clock.instant().atZone(ZoneId.of(settings.timeZone()));
  }

  private LocalDate today(Settings settings) {
    return now(settings).toLocalDate();
  }

  private static String id() {
    return UUID.randomUUID().toString();
  }

  private static int index(Draft draft, String id) {
    for (int i = 0; i < draft.tasks.size(); i++) if (draft.tasks.get(i).id().equals(id)) return i;
    throw new NotFoundException("Daily task not found");
  }

  private static final class Draft {
    Settings settings;
    final List<Task> tasks;
    final List<Event> events;
    final List<DayOff> daysOff;
    final List<Sprint> sprints;
    final Set<String> delivered;
    long nextTaskNumber;
    final List<TaskLink> links;

    Draft(Stored state) {
      settings = state.settings();
      tasks = new ArrayList<>(state.tasks());
      events = new ArrayList<>(state.events());
      daysOff = new ArrayList<>(state.daysOff());
      sprints = new ArrayList<>(state.sprints());
      delivered = new HashSet<>(state.deliveredReminders());
      nextTaskNumber = state.nextTaskNumber() == null ? 1 : state.nextTaskNumber();
      links = new ArrayList<>(state.links() == null ? List.of() : state.links());
    }
  }
}
