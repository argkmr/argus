package com.argus.diagrams.controller;

import static org.assertj.core.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.argus.common.error.ApiExceptionHandler;
import java.io.IOException;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;

class DiagramIconControllerTest {
  static final String SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0H24\"/></svg>";

  private static DiagramIconController.FetchedIcon asset(String text) {
    return new DiagramIconController.FetchedIcon(
        200, "image/svg+xml; charset=utf-8", text.getBytes(StandardCharsets.UTF_8));
  }

  @Test
  void returnsOnlyInertJsonAndCachesAllowedNames() throws Exception {
    var calls = new AtomicInteger();
    var controller =
        new DiagramIconController(
            Set.of("aws-ec2"),
            uri -> {
              calls.incrementAndGet();
              assertThat(uri.toString()).isEqualTo(DiagramIconController.ICON_BASE + "aws-ec2.svg");
              return asset(SVG);
            },
            3,
            1024);
    var mvc =
        MockMvcBuilders.standaloneSetup(controller)
            .setControllerAdvice(new ApiExceptionHandler())
            .build();
    for (int i = 0; i < 2; i++) {
      var response = mvc.perform(get("/api/diagram-icons/aws-ec2")).andReturn().getResponse();
      assertThat(response.getStatus()).isEqualTo(200);
      assertThat(response.getContentType()).isEqualTo("application/json");
      assertThat(response.getHeader("X-Content-Type-Options")).isEqualTo("nosniff");
      assertThat(response.getHeader("Cache-Control")).contains("private", "86400");
      assertThat(new ObjectMapper().readTree(response.getContentAsString()).path("svg").asText())
          .isEqualTo(SVG);
    }
    assertThat(calls.get()).isEqualTo(1);
    assertThat(
            mvc.perform(get("/api/diagram-icons/not-real")).andReturn().getResponse().getStatus())
        .isEqualTo(404);
    assertThat(calls.get()).isEqualTo(1);
  }

  @Test
  void rejectsUnlistedPathsAndUrlsBeforeNetworkAndEncodesRealSpecialNames() {
    var requested = new ArrayList<URI>();
    var controller =
        new DiagramIconController(
            Set.of("azure-web-app-+-database", "aws-elemental-appliances-&-software", "eraser.io"),
            uri -> {
              requested.add(uri);
              return asset(SVG);
            },
            3,
            1024);
    for (String name : List.of("../secrets", "https://example.com/x", "//evil/x", "aws-ec2?x=1")) {
      assertThatThrownBy(() -> controller.get(name))
          .isInstanceOfSatisfying(
              ResponseStatusException.class,
              error -> assertThat(error.getStatusCode().value()).isEqualTo(404));
    }
    assertThat(requested).isEmpty();
    controller.get("azure-web-app-+-database");
    controller.get("aws-elemental-appliances-&-software");
    controller.get("eraser.io");
    assertThat(requested.stream().map(URI::toString).toList())
        .containsExactly(
            DiagramIconController.ICON_BASE + "azure-web-app-%2B-database.svg",
            DiagramIconController.ICON_BASE + "aws-elemental-appliances-%26-software.svg",
            DiagramIconController.ICON_BASE + "eraser-io.svg");
  }

  @Test
  void boundedCacheEvictsLeastRecentlyUsedAndLimitsTotalBytes() {
    var requests = new ArrayList<String>();
    var controller =
        new DiagramIconController(
            Set.of("a", "b", "c"),
            uri -> {
              requests.add(uri.getPath());
              return asset(SVG);
            },
            2,
            1024);
    for (String name : List.of("a", "b", "a", "c", "b")) controller.get(name);
    assertThat(requests).hasSize(4);
    var byteLimited =
        new DiagramIconController(
            Set.of("a", "b"),
            uri -> {
              requests.add(uri.getPath());
              return asset(SVG);
            },
            100,
            SVG.getBytes(StandardCharsets.UTF_8).length);
    requests.clear();
    for (String name : List.of("a", "b", "a")) byteLimited.get(name);
    assertThat(requests).hasSize(3);
  }

  @Test
  void rejectsUpstreamErrorsWrongMediaTypeAndOversizedAssetsWithoutCachingFailure() {
    for (var bad :
        List.of(
            new DiagramIconController.FetchedIcon(
                302, "image/svg+xml", SVG.getBytes(StandardCharsets.UTF_8)),
            new DiagramIconController.FetchedIcon(404, "text/html", new byte[] {1}),
            new DiagramIconController.FetchedIcon(
                200, "text/html", SVG.getBytes(StandardCharsets.UTF_8)),
            new DiagramIconController.FetchedIcon(200, "image/svg+xml", new byte[0]),
            new DiagramIconController.FetchedIcon(
                200, "image/svg+xml", new byte[DiagramIconController.MAX_ICON_BYTES + 1]))) {
      var attempts = new AtomicInteger();
      var controller =
          new DiagramIconController(
              Set.of("a"), uri -> attempts.incrementAndGet() == 1 ? bad : asset(SVG), 1, 1024);
      assertThatThrownBy(() -> controller.get("a"))
          .isInstanceOfSatisfying(
              ResponseStatusException.class,
              error -> assertThat(error.getStatusCode().value()).isEqualTo(502));
      assertThat(controller.get("a").getBody()).containsEntry("svg", SVG);
      assertThat(attempts.get()).isEqualTo(2);
    }
  }

  @Test
  void capsConcurrentUpstreamRequestsAndReleasesSlotsAfterFailure() throws Exception {
    var started = new CountDownLatch(6);
    var release = new CountDownLatch(1);
    var workers = Executors.newFixedThreadPool(6);
    try {
      var controller =
          new DiagramIconController(
              Set.of("a"),
              uri -> {
                started.countDown();
                if (!release.await(5, TimeUnit.SECONDS)) throw new IOException("fixture timeout");
                throw new IOException("synthetic upstream failure");
              },
              1,
              1024);
      var jobs = new ArrayList<java.util.concurrent.Future<?>>();
      for (int i = 0; i < 6; i++)
        jobs.add(
            workers.submit(
                () ->
                    assertThatThrownBy(() -> controller.get("a"))
                        .isInstanceOfSatisfying(
                            ResponseStatusException.class,
                            error -> assertThat(error.getStatusCode().value()).isEqualTo(502))));
      assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
      assertThatThrownBy(() -> controller.get("a"))
          .isInstanceOfSatisfying(
              ResponseStatusException.class,
              error -> assertThat(error.getStatusCode().value()).isEqualTo(429));
      release.countDown();
      for (var job : jobs) job.get(5, TimeUnit.SECONDS);
      assertThatThrownBy(() -> controller.get("a"))
          .isInstanceOfSatisfying(
              ResponseStatusException.class,
              error -> assertThat(error.getStatusCode().value()).isEqualTo(502));
    } finally {
      release.countDown();
      workers.shutdownNow();
    }
  }

  @Test
  void streamingBodyLimitCancelsBeforeAccumulatingOversizedChunks() {
    var cancelled = new AtomicBoolean();
    Flow.Subscription subscription =
        new Flow.Subscription() {
          public void request(long count) {}

          public void cancel() {
            cancelled.set(true);
          }
        };
    var body = new DiagramIconController.BoundedBodySubscriber(6);
    body.onSubscribe(subscription);
    body.onNext(List.of(ByteBuffer.wrap(new byte[] {1, 2, 3, 4})));
    body.onNext(List.of(ByteBuffer.wrap(new byte[] {5, 6, 7})));
    assertThat(cancelled.get()).isTrue();
    assertThatThrownBy(() -> body.getBody().toCompletableFuture().join())
        .hasCauseInstanceOf(IOException.class);
    body.onComplete();
    assertThat(body.getBody().toCompletableFuture()).isCompletedExceptionally();

    var exact = new DiagramIconController.BoundedBodySubscriber(3);
    exact.onSubscribe(subscription);
    exact.onNext(List.of(ByteBuffer.wrap(new byte[] {1, 2}), ByteBuffer.wrap(new byte[] {3})));
    exact.onComplete();
    assertThat(exact.getBody().toCompletableFuture().join()).containsExactly(1, 2, 3);
  }

  @Test
  void catalogResourceIncludesEveryPublishedCategoryAndPreservesSpecialNames() {
    assertThat(DiagramIconController.loadNames())
        .hasSize(3951)
        .contains(
            "aws-ec2",
            "aws-cloudfront-functions_48_Light",
            "azure-web-app-+-database",
            "aws-elemental-appliances-&-software",
            "eraser.io");
  }
}
