package com.argus.apiclient.service;

import com.argus.apiclient.dto.ApiResponse;
import com.argus.apiclient.dto.SendApiRequest;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

@Service
public class ApiRequestService {
  private static final int MAX_RESPONSE_BYTES = 5_000_000;
  private static final Pattern TEMPLATE = Pattern.compile("\\{\\{\\s*([^{}]+?)\\s*}}");
  private final HttpClient client =
      HttpClient.newBuilder()
          .connectTimeout(Duration.ofSeconds(15))
          .followRedirects(HttpClient.Redirect.NEVER)
          .build();

  public ApiResponse send(SendApiRequest input, Map<String, String> environment) {
    Resolved request = resolve(input, environment);
    long started = System.nanoTime();
    try {
      URI uri = URI.create(request.url());
      String method = request.method(), requestBody = request.body();
      Map<String, String> outboundHeaders = new LinkedHashMap<>(request.headers());
      HttpResponse<byte[]> response = null;
      for (int redirects = 0; redirects <= 20; redirects++) {
        long remaining = 60_000 - Duration.ofNanos(System.nanoTime() - started).toMillis();
        if (remaining <= 0) throw new java.util.concurrent.TimeoutException();
        HttpRequest.Builder builder =
            HttpRequest.newBuilder(uri).timeout(Duration.ofMillis(remaining));
        outboundHeaders.forEach(builder::header);
        builder.method(
            method,
            Set.of("GET", "HEAD").contains(method) || requestBody.isEmpty()
                ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(requestBody));
        var future = client.sendAsync(builder.build(), ignored -> new LimitedBodySubscriber());
        try {
          response = future.get(remaining, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
          future.cancel(true);
          throw e;
        }
        if (!Set.of(301, 302, 303, 307, 308).contains(response.statusCode())
            || response.headers().firstValue("location").isEmpty()) break;
        if (redirects == 20)
          throw new IllegalArgumentException("API request exceeded 20 redirects");
        URI next = uri.resolve(response.headers().firstValue("location").orElseThrow());
        validateUri(next);
        if (!java.util.Objects.equals(uri.getAuthority(), next.getAuthority())
            || !java.util.Objects.equals(uri.getScheme(), next.getScheme()))
          outboundHeaders
              .keySet()
              .removeIf(
                  key ->
                      Set.of("authorization", "cookie", "proxy-authorization")
                          .contains(key.toLowerCase()));
        if (response.statusCode() == 303 && !method.equals("HEAD")
            || Set.of(301, 302).contains(response.statusCode()) && method.equals("POST")) {
          method = "GET";
          requestBody = "";
          outboundHeaders
              .keySet()
              .removeIf(
                  key ->
                      key.equalsIgnoreCase("content-type")
                          || key.equalsIgnoreCase("content-length"));
        }
        uri = next;
      }
      Map<String, String> headers = new LinkedHashMap<>();
      response
          .headers()
          .map()
          .forEach((key, values) -> headers.put(key, String.join(", ", values)));
      return new ApiResponse(
          response.statusCode(),
          statusText(response.statusCode()),
          response.statusCode() >= 200 && response.statusCode() < 300,
          Duration.ofNanos(System.nanoTime() - started).toMillis(),
          response.body().length,
          headers,
          new String(response.body(), StandardCharsets.UTF_8),
          response.uri().toString());
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException("API request interrupted", error);
    } catch (Exception error) {
      Throwable cause = error;
      while (cause.getCause() != null) cause = cause.getCause();
      if (cause instanceof IllegalArgumentException || cause instanceof IllegalStateException)
        throw (RuntimeException) cause;
      throw new IllegalStateException(
          "Could not reach "
              + URI.create(request.url()).getAuthority()
              + " (network request failed). The active environment resolved the request to this origin.",
          error);
    }
  }

  public String curl(SendApiRequest input, Map<String, String> environment) {
    Resolved request = resolve(input, environment);
    StringBuilder curl =
        new StringBuilder("curl --request ")
            .append(shell(request.method()))
            .append(" ")
            .append(shell(request.url()));
    request
        .headers()
        .forEach((key, value) -> curl.append(" \\\n  --header ").append(shell(key + ": " + value)));
    if (!request.body().isEmpty()
        && !request.method().equals("GET")
        && !request.method().equals("HEAD"))
      curl.append(" \\\n  --data-raw ").append(shell(request.body()));
    return curl.toString();
  }

  public Resolved resolve(SendApiRequest input, Map<String, String> environment) {
    String method = input.method() == null ? "GET" : input.method().toUpperCase();
    if (!method.matches("[A-Z]+")) throw new IllegalArgumentException("Invalid HTTP method");
    Map<String, String> variables = new LinkedHashMap<>();
    if (input.variables() != null)
      input
          .variables()
          .forEach((key, value) -> variables.put(key, value == null ? "" : String.valueOf(value)));
    variables.putAll(environment == null ? Map.of() : environment);
    String templateUrl = input.url() == null ? "" : input.url();
    if (input.queryParams() != null)
      templateUrl =
          ApiRequestParameters.compose(
              templateUrl, ApiRequestParameters.normalize(input.queryParams()));
    Map<String, String> pathValues = new LinkedHashMap<>();
    for (var parameter : ApiRequestParameters.normalize(input.pathVariables()))
      if (Boolean.TRUE.equals(parameter.get("enabled"))
          && !String.valueOf(parameter.get("key")).isEmpty())
        pathValues.put(
            String.valueOf(parameter.get("key")), String.valueOf(parameter.get("value")));
    var missing =
        ApiRequestParameters.path(templateUrl).stream()
            .map(row -> String.valueOf(row.get("key")))
            .filter(key -> !pathValues.containsKey(key) || pathValues.get(key).isEmpty())
            .toList();
    if (!missing.isEmpty())
      throw new IllegalArgumentException(
          "Set a value for path variables: " + String.join(", ", missing));
    String url = templates(templateUrl, variables).trim();
    var pathMatcher = ApiRequestParameters.PATH.matcher(url);
    var appliedPath = new StringBuffer();
    while (pathMatcher.find()) {
      String name = pathMatcher.group(1) == null ? pathMatcher.group(2) : pathMatcher.group(1);
      String value = pathValues.get(name);
      pathMatcher.appendReplacement(
          appliedPath,
          Matcher.quoteReplacement(
              value == null || value.isEmpty()
                  ? pathMatcher.group()
                  : ApiRequestParameters.encode(templates(value, variables))));
    }
    pathMatcher.appendTail(appliedPath);
    url = appliedPath.toString();
    if (url.matches("(?i)^[a-z][a-z0-9+.-]*://.*") && !url.matches("(?i)^https?://.*"))
      throw new IllegalArgumentException("Only HTTP and HTTPS requests are supported");
    if (!url.matches("(?i)^https?://.*"))
      url =
          url.startsWith("//")
              ? "https:" + url
              : url.matches("(?i)^(localhost|127(?:\\.\\d+){3}|\\[::1])(?::|/|$).*")
                  ? "http://" + url
                  : "https://" + url;
    if (TEMPLATE.matcher(url).find())
      throw new IllegalArgumentException(
          "Set a value for every Postman variable in the active environment");
    Map<String, String> headers = new LinkedHashMap<>();
    if (input.headers() != null)
      input.headers().forEach((key, value) -> headers.put(key, templates(value, variables)));
    String body = templates(input.body(), variables);
    String all = url + "\n" + String.join("\n", headers.values()) + "\n" + body;
    if (TEMPLATE.matcher(all).find())
      throw new IllegalArgumentException(
          "Set a value for every Postman variable in the active environment");
    validateUri(URI.create(url));
    if (input.postman() != null && input.postman().get("body") instanceof Map<?, ?> postmanBody) {
      String mode = String.valueOf(postmanBody.get("mode"));
      if (Set.of("formdata", "urlencoded").contains(mode)) {
        var fields = ApiRequestParameters.normalize(postmanBody.get(mode));
        for (var field : fields)
          if (Boolean.TRUE.equals(field.get("enabled"))
              && TEMPLATE.matcher(templates(field.get("value"), variables)).find())
            throw new IllegalArgumentException(
                "Set a value for every Postman variable in the active environment");
        if (mode.equals("formdata")) {
          if (postmanBody.get("formdata") instanceof List<?> parts
              && parts.stream()
                  .anyMatch(
                      item ->
                          item instanceof Map<?, ?> field
                              && !Boolean.TRUE.equals(field.get("disabled"))
                              && "file".equals(field.get("type"))))
            throw new IllegalArgumentException(
                "Attach the local file for multipart fields before sending. File paths from another Postman installation are not used automatically.");
          String boundary = "Argus" + java.util.UUID.randomUUID().toString().replace("-", "");
          var form = new StringBuilder();
          for (var field : fields)
            if (Boolean.TRUE.equals(field.get("enabled"))
                && !String.valueOf(field.get("key")).isEmpty())
              form.append("--")
                  .append(boundary)
                  .append("\r\nContent-Disposition: form-data; name=\"")
                  .append(
                      String.valueOf(field.get("key"))
                          .replace("\"", "%22")
                          .replace("\r", "%0D")
                          .replace("\n", "%0A"))
                  .append("\"\r\n\r\n")
                  .append(templates(field.get("value"), variables))
                  .append("\r\n");
          body = form.append("--").append(boundary).append("--\r\n").toString();
          headers.keySet().removeIf(key -> key.equalsIgnoreCase("content-type"));
          headers.put("Content-Type", "multipart/form-data; boundary=" + boundary);
        } else {
          body =
              fields.stream()
                  .filter(
                      field ->
                          Boolean.TRUE.equals(field.get("enabled"))
                              && !String.valueOf(field.get("key")).isEmpty())
                  .map(
                      field ->
                          java.net.URLEncoder.encode(
                                  String.valueOf(field.get("key")), StandardCharsets.UTF_8)
                              + "="
                              + java.net.URLEncoder.encode(
                                  templates(field.get("value"), variables), StandardCharsets.UTF_8))
                  .collect(java.util.stream.Collectors.joining("&"));
          if (headers.keySet().stream().noneMatch(key -> key.equalsIgnoreCase("content-type")))
            headers.put("Content-Type", "application/x-www-form-urlencoded");
        }
      }
    }
    return new Resolved(method, url, headers, body);
  }

  private String templates(Object source, Map<String, String> variables) {
    String value = source == null ? "" : String.valueOf(source);
    Matcher origins = Pattern.compile("(?i)\\b(https?)://\\{\\{\\s*([^{}]+?)\\s*}}").matcher(value);
    StringBuffer normalized = new StringBuffer();
    while (origins.find()) {
      String replacement = variables.get(origins.group(2).trim());
      if (replacement == null) replacement = origins.group();
      else
        replacement =
            replacement.matches("(?i)^https?://.*")
                ? replacement.replaceAll("/+$", "")
                : origins.group(1) + "://" + replacement.replaceAll("^/+|/+$", "");
      origins.appendReplacement(normalized, Matcher.quoteReplacement(replacement));
    }
    origins.appendTail(normalized);
    value = normalized.toString();
    Matcher matcher = TEMPLATE.matcher(value);
    StringBuffer result = new StringBuffer();
    while (matcher.find()) {
      String replacement = variables.get(matcher.group(1).trim());
      matcher.appendReplacement(
          result, Matcher.quoteReplacement(replacement == null ? matcher.group() : replacement));
    }
    matcher.appendTail(result);
    return result.toString();
  }

  private static String shell(String value) {
    return "'" + value.replace("'", "'\"'\"'") + "'";
  }

  private static String statusText(int status) {
    return switch (status) {
      case 200 -> "OK";
      case 201 -> "Created";
      case 202 -> "Accepted";
      case 204 -> "No Content";
      case 400 -> "Bad Request";
      case 401 -> "Unauthorized";
      case 403 -> "Forbidden";
      case 404 -> "Not Found";
      case 409 -> "Conflict";
      case 500 -> "Internal Server Error";
      default -> "";
    };
  }

  private static void validateUri(URI uri) {
    if (!Set.of("http", "https").contains(uri.getScheme())
        || uri.getHost() == null
        || uri.getRawUserInfo() != null)
      throw new IllegalArgumentException(
          "Only HTTP and HTTPS requests without embedded credentials are supported");
  }

  private static final class LimitedBodySubscriber implements HttpResponse.BodySubscriber<byte[]> {
    private final HttpResponse.BodySubscriber<byte[]> delegate =
        HttpResponse.BodySubscribers.ofByteArray();
    private Flow.Subscription subscription;
    private long size;

    @Override
    public CompletionStage<byte[]> getBody() {
      return delegate.getBody();
    }

    @Override
    public void onSubscribe(Flow.Subscription value) {
      subscription = value;
      delegate.onSubscribe(value);
    }

    @Override
    public void onNext(List<java.nio.ByteBuffer> chunks) {
      for (var chunk : chunks) size += chunk.remaining();
      if (size > MAX_RESPONSE_BYTES) {
        subscription.cancel();
        delegate.onError(new IllegalStateException("Response is larger than 5 MB"));
      } else delegate.onNext(chunks);
    }

    @Override
    public void onError(Throwable error) {
      delegate.onError(error);
    }

    @Override
    public void onComplete() {
      delegate.onComplete();
    }
  }

  public record Resolved(String method, String url, Map<String, String> headers, String body) {}
}
