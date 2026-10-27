package com.argus.tasks.service;

import com.argus.common.error.ConflictException;
import java.util.HashSet;
import java.util.Set;
import org.springframework.stereotype.Service;

/** In-process reservation spans preparation, process drain and completion persistence. */
@Service
public class TaskActivityService {
  private final Set<String> active = new HashSet<>();
  private final Set<String> barriers = new HashSet<>();
  private final java.util.Map<String, Long> queueEpochs = new java.util.HashMap<>();

  public synchronized long queueEpoch(String id) {
    if (barriers.contains(id))
      throw new ConflictException(
          "This request is being cancelled; keep your draft and retry afterwards");
    return queueEpochs.getOrDefault(id, 0L);
  }

  /** Queue preparation may run alongside a response, but never cross a cancellation boundary. */
  public synchronized <T> T acceptQueuedPrompt(
      String id, long epoch, java.util.function.Supplier<T> save) {
    if (barriers.contains(id) || queueEpochs.getOrDefault(id, 0L) != epoch)
      throw new ConflictException(
          "This request was cancelled while queuing. Your draft was not sent; retry explicitly.");
    return save.get();
  }

  public synchronized boolean busy(String id) {
    return id != null && (active.contains(id) || barriers.contains(id));
  }

  public synchronized Lease reserve(String id) {
    if (id == null || id.isBlank()) throw new IllegalArgumentException("Task ID is required");
    if (barriers.contains(id) || !active.add(id))
      throw new ConflictException(
          "Wait for the task's response to finish before changing or sending a prompt");
    return new Lease(id);
  }

  /** Prevent a new response from racing cancellation without interrupting the existing lease. */
  public synchronized Barrier preventNewActivity(String id) {
    if (id == null || id.isBlank()) throw new IllegalArgumentException("Task ID is required");
    if (!barriers.add(id))
      throw new ConflictException("This chat is already being stopped; wait and refresh it");
    queueEpochs.merge(id, 1L, Long::sum);
    return new Barrier(id);
  }

  public final class Barrier implements AutoCloseable {
    private final String id;
    private boolean closed;

    private Barrier(String id) {
      this.id = id;
    }

    public boolean responseBusy() {
      synchronized (TaskActivityService.this) {
        return active.contains(id);
      }
    }

    public void awaitResponseRelease(long timeoutMillis) throws InterruptedException {
      long deadline =
          System.nanoTime() + java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(timeoutMillis);
      synchronized (TaskActivityService.this) {
        while (active.contains(id)) {
          long remaining = deadline - System.nanoTime();
          if (remaining <= 0)
            throw new ConflictException(
                "The response is still stopping. Your queue is paused; retry shortly.");
          java.util.concurrent.TimeUnit.NANOSECONDS.timedWait(TaskActivityService.this, remaining);
        }
      }
    }

    @Override
    public void close() {
      synchronized (TaskActivityService.this) {
        if (!closed) {
          closed = true;
          barriers.remove(id);
          TaskActivityService.this.notifyAll();
        }
      }
    }
  }

  public final class Lease implements AutoCloseable {
    private final String id;
    private boolean closed;

    private Lease(String id) {
      this.id = id;
    }

    @Override
    public void close() {
      synchronized (TaskActivityService.this) {
        if (!closed) {
          closed = true;
          active.remove(id);
          TaskActivityService.this.notifyAll();
        }
      }
    }
  }
}
