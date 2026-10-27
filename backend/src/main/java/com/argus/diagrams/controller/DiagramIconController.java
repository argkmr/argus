package com.argus.diagrams.controller;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Flow;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.stream.Collectors;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * A narrow icon adapter, not a URL proxy. The normal local API boundary applies. Only names from
 * Eraser's checked-in public catalog can be requested, and upstream markup is returned as inert
 * JSON for the client's image sanitizer, never served as an active SVG document.
 */
@RestController
@RequestMapping("/api/diagram-icons")
public class DiagramIconController {
  static final int MAX_ICON_BYTES = 512 * 1024;
  static final Duration FETCH_TIMEOUT = Duration.ofSeconds(8);
  static final String ICON_BASE =
      "https://storage.googleapis.com/eraser-public-assets/canvas-icons/";
  private final Set<String> names;
  private final AssetFetcher fetcher;
  private final Semaphore permits = new Semaphore(6);
  private final Map<String, CachedIcon> cache = new LinkedHashMap<>(32, .75f, true);
  private final int maxEntries;
  private final int maxCacheBytes;
  private int cacheBytes;

  public DiagramIconController() {
    this(loadNames(), new HttpAssetFetcher(), 256, 8 * 1024 * 1024);
  }

  // A transport seam keeps tests deterministic, isolated and completely offline.
  DiagramIconController(
      Set<String> names, AssetFetcher fetcher, int maxEntries, int maxCacheBytes) {
    this.names = Set.copyOf(names);
    this.fetcher = fetcher;
    this.maxEntries = Math.max(1, maxEntries);
    this.maxCacheBytes = Math.max(1, maxCacheBytes);
  }

  @GetMapping(value = "/{name}", produces = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<Map<String, String>> get(@PathVariable String name) {
    if (!names.contains(name))
      throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unknown diagram icon");
    String svg = cached(name);
    if (svg == null) {
      if (!permits.tryAcquire())
        throw new ResponseStatusException(
            HttpStatus.TOO_MANY_REQUESTS, "Diagram icons are loading. Please retry shortly.");
      try {
        // A parallel request may have finished after the first lookup.
        svg = cached(name);
        if (svg == null) {
          FetchedIcon fetched = fetcher.fetch(iconUri(name));
          if (fetched.status() != 200
              || fetched.contentType() == null
              || !fetched
                  .contentType()
                  .toLowerCase(Locale.ROOT)
                  .split(";", 2)[0]
                  .trim()
                  .equals("image/svg+xml")
              || fetched.body() == null
              || fetched.body().length == 0
              || fetched.body().length > MAX_ICON_BYTES) throw unavailable();
          svg = new String(fetched.body(), StandardCharsets.UTF_8);
          remember(name, svg, fetched.body().length);
        }
      } catch (InterruptedException error) {
        Thread.currentThread().interrupt();
        throw new ResponseStatusException(
            HttpStatus.SERVICE_UNAVAILABLE, "Icon request interrupted");
      } catch (IOException error) {
        throw unavailable();
      } finally {
        permits.release();
      }
    }
    return ResponseEntity.ok()
        .cacheControl(CacheControl.maxAge(Duration.ofHours(24)).cachePrivate())
        .header("X-Content-Type-Options", "nosniff")
        .contentType(MediaType.APPLICATION_JSON)
        .body(Map.of("svg", svg));
  }

  private synchronized String cached(String name) {
    CachedIcon item = cache.get(name);
    return item == null ? null : item.svg();
  }

  private synchronized void remember(String name, String svg, int bytes) {
    if (bytes > maxCacheBytes) return;
    CachedIcon old = cache.remove(name);
    if (old != null) cacheBytes -= old.bytes();
    cache.put(name, new CachedIcon(svg, bytes));
    cacheBytes += bytes;
    while (cache.size() > maxEntries || cacheBytes > maxCacheBytes) {
      var oldest = cache.entrySet().iterator();
      cacheBytes -= oldest.next().getValue().bytes();
      oldest.remove();
    }
  }

  static URI iconUri(String name) {
    // The documented name has one historical storage alias. No user-supplied URL or host is used.
    String asset = name.equals("eraser.io") ? "eraser-io" : name;
    return URI.create(
        ICON_BASE + URLEncoder.encode(asset, StandardCharsets.UTF_8).replace("+", "%20") + ".svg");
  }

  static Set<String> loadNames() {
    try (InputStream stream =
        DiagramIconController.class.getResourceAsStream("/diagrams/eraser-icon-names.txt")) {
      if (stream == null) throw new IllegalStateException("Diagram icon catalog is missing");
      return new String(stream.readAllBytes(), StandardCharsets.UTF_8)
          .lines()
          .map(String::trim)
          .filter(line -> !line.isEmpty() && !line.startsWith("#"))
          .collect(Collectors.toUnmodifiableSet());
    } catch (IOException error) {
      throw new IllegalStateException("Diagram icon catalog could not be loaded", error);
    }
  }

  private static ResponseStatusException unavailable() {
    return new ResponseStatusException(
        HttpStatus.BAD_GATEWAY, "This icon could not be loaded. Check your connection and retry.");
  }

  private record CachedIcon(String svg, int bytes) {}

  record FetchedIcon(int status, String contentType, byte[] body) {}

  @FunctionalInterface
  interface AssetFetcher {
    FetchedIcon fetch(URI uri) throws IOException, InterruptedException;
  }

  static final class HttpAssetFetcher implements AssetFetcher {
    private final HttpClient http =
        HttpClient.newBuilder()
            .connectTimeout(FETCH_TIMEOUT)
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();

    @Override
    public FetchedIcon fetch(URI uri) throws IOException, InterruptedException {
      HttpRequest request =
          HttpRequest.newBuilder(uri)
              .timeout(FETCH_TIMEOUT)
              .header("Accept", "image/svg+xml")
              .GET()
              .build();
      CompletableFuture<HttpResponse<byte[]>> pending =
          http.sendAsync(request, ignored -> new BoundedBodySubscriber(MAX_ICON_BYTES));
      try {
        // Covers the entire body, not only connecting or receiving headers.
        HttpResponse<byte[]> response =
            pending.get(FETCH_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
        return new FetchedIcon(
            response.statusCode(),
            response.headers().firstValue("Content-Type").orElse(""),
            response.body());
      } catch (TimeoutException error) {
        pending.cancel(true);
        throw new IOException("Icon request timed out", error);
      } catch (InterruptedException error) {
        pending.cancel(true);
        throw error;
      } catch (ExecutionException error) {
        throw new IOException("Icon fetch failed", error.getCause());
      }
    }
  }

  static final class BoundedBodySubscriber implements HttpResponse.BodySubscriber<byte[]> {
    private final CompletableFuture<byte[]> body = new CompletableFuture<>();
    private final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
    private final int limit;
    private Flow.Subscription subscription;

    BoundedBodySubscriber(int limit) {
      this.limit = limit;
    }

    @Override
    public CompletionStage<byte[]> getBody() {
      return body;
    }

    @Override
    public void onSubscribe(Flow.Subscription next) {
      if (subscription != null) {
        next.cancel();
        return;
      }
      subscription = next;
      next.request(1);
    }

    @Override
    public void onNext(List<ByteBuffer> chunks) {
      if (body.isDone()) return;
      for (ByteBuffer chunk : chunks) {
        if (chunk.remaining() > limit - bytes.size()) {
          subscription.cancel();
          body.completeExceptionally(new IOException("Icon exceeds the size limit"));
          return;
        }
        byte[] segment = new byte[chunk.remaining()];
        chunk.get(segment);
        bytes.writeBytes(segment);
      }
      subscription.request(1);
    }

    @Override
    public void onError(Throwable error) {
      body.completeExceptionally(error);
    }

    @Override
    public void onComplete() {
      body.complete(bytes.toByteArray());
    }
  }
}
