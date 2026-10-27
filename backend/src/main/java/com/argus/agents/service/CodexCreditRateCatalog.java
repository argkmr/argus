package com.argus.agents.service;

import com.argus.common.config.ArgusProperties;
import com.argus.common.storage.AtomicJsonStore;
import com.argus.platform.NativeBackgroundOwner;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.Flow;
import java.util.regex.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

/** Public documentation only: no account, prompt, token, repository or credential leaves Argus. */
@Service
public final class CodexCreditRateCatalog implements NativeBackgroundOwner, AutoCloseable {
  static final URI PRICING = URI.create("https://learn.chatgpt.com/docs/pricing.md");
  static final URI SPEED =
      URI.create("https://learn.chatgpt.com/docs/agent-configuration/speed.md");
  static final int MAX_BYTES = 1024 * 1024;
  static final Duration REFRESH = Duration.ofHours(6);
  private static final Pattern TABLE =
      Pattern.compile("<table\\b[^>]*>(.*?)</table>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
  private static final Pattern ROW =
      Pattern.compile("<tr\\b[^>]*>(.*?)</tr>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
  private static final Pattern CELL =
      Pattern.compile("<t[dh]\\b[^>]*>(.*?)</t[dh]>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
  private final AtomicJsonStore json;
  private final Path cache;
  private final Fetcher fetcher;
  private final Clock clock;
  private final ScheduledExecutorService worker;
  private volatile boolean closed;
  private Instant lastFetched;

  @FunctionalInterface
  interface Fetcher {
    String get(URI uri) throws Exception;
  }

  @Autowired
  public CodexCreditRateCatalog(ArgusProperties properties, AtomicJsonStore json) {
    this(
        properties.dataDirectory().resolve("pricing-cache/codex-credits.json"),
        json,
        uri -> fetch(uri, Duration.ofSeconds(10)),
        Clock.systemUTC(),
        "1".equals(System.getenv("ARGUS_DESKTOP"))
            || Boolean.getBoolean("argus.pricing.autoRefresh"));
  }

  CodexCreditRateCatalog(
      Path cache, AtomicJsonStore json, Fetcher fetcher, Clock clock, boolean start) {
    this.cache = cache;
    this.json = json;
    this.fetcher = fetcher;
    this.clock = clock;
    loadCached();
    worker =
        Executors.newSingleThreadScheduledExecutor(
            runnable -> {
              var thread = new Thread(runnable, "argus-credit-rates");
              thread.setDaemon(true);
              return thread;
            });
    // Startup is never blocked on internet access. A bounded cached/bundled card is usable offline.
    long delay =
        lastFetched == null
            ? 0
            : Math.max(0, Duration.between(clock.instant(), lastFetched.plus(REFRESH)).toSeconds());
    if (start)
      worker.scheduleWithFixedDelay(
          this::refreshQuietly, delay, REFRESH.toSeconds(), TimeUnit.SECONDS);
  }

  private void loadCached() {
    try {
      if (Files.isSymbolicLink(cache)
          || !Files.isRegularFile(cache)
          || Files.size(cache) > MAX_BYTES * 3L) return;
      var saved = json.read(cache, Map.class);
      if (!PRICING.toString().equals(saved.get("pricingSource"))
          || !SPEED.toString().equals(saved.get("speedSource"))) return;
      Instant fetched = Instant.parse((String) saved.get("fetchedAt"));
      // Reject future timestamps and reparse cached source instead of trusting cached numeric
      // rates.
      if (fetched.isAfter(clock.instant().plusSeconds(300))) return;
      if (fetched.isBefore(
          LocalDate.parse(ProviderCostEstimate.fallbackRateCard().date())
              .atStartOfDay(ZoneOffset.UTC)
              .toInstant())) return;
      var card = parse((String) saved.get("pricing"), (String) saved.get("speed"), fetched);
      ProviderCostEstimate.installRateCard(card);
      lastFetched = fetched;
    } catch (Exception ignored) {
      /* A damaged cache must not prevent startup or replace fallback. */
    }
  }

  private void refreshQuietly() {
    try {
      refresh();
    } catch (Exception ignored) {
      /* Keep last validated card; its timestamp stays unchanged. */
    }
  }

  synchronized void refresh() throws Exception {
    if (closed || Thread.currentThread().isInterrupted()) return;
    String pricing = fetcher.get(PRICING), speed = fetcher.get(SPEED);
    Instant fetched = clock.instant();
    var card = parse(pricing, speed, fetched);
    if (closed || Thread.currentThread().isInterrupted()) return;
    // Write only validated, public documentation. Failed updates cannot corrupt the old cache.
    json.write(
        cache,
        Map.of(
            "pricingSource",
            PRICING.toString(),
            "speedSource",
            SPEED.toString(),
            "fetchedAt",
            fetched.toString(),
            "pricing",
            pricing,
            "speed",
            speed));
    ProviderCostEstimate.installRateCard(card);
    lastFetched = fetched;
  }

  static ProviderCostEstimate.RateCard parse(String pricing, String speed, Instant fetched) {
    if (pricing == null
        || speed == null
        || pricing.length() > MAX_BYTES
        || speed.length() > MAX_BYTES)
      throw new IllegalArgumentException("Rate documentation is missing or too large");
    String plain = clean(pricing), speedPlain = clean(speed);
    if (!plain.contains("Codex credit billing has no separate cache-write charge"))
      throw new IllegalArgumentException(
          "Codex cache-write policy changed; retaining previous card");
    String fast = matchedRate(plain, "Fast mode uses ([0-9.]+)[x×] the Standard rate");
    String ultra = matchedRate(plain, "Ultrafast mode uses ([0-9.]+)[x×]");
    String fastIncluded =
        matchedRate(speedPlain, "Fast mode uses included subscription limits at ([0-9.]+)[x×]");
    String ultraIncluded =
        matchedRate(speedPlain, "Ultrafast uses included subscription limits at ([0-9.]+)[x×]");
    var supportedFast = new HashSet<String>();
    var fastSupport =
        Pattern.compile(
                "Fast mode speeds up supported models, including (.+?),? where available\\.")
            .matcher(speedPlain);
    if (!fastSupport.find()) throw new IllegalArgumentException("Fast model policy unavailable");
    for (String label : fastSupport.group(1).split(",|\\s+and\\s+")) {
      String id = modelId(label.trim().replaceFirst("^and\\s+", ""));
      if (id != null) supportedFast.add(id);
    }
    if (supportedFast.isEmpty()) throw new IllegalArgumentException("Fast model policy invalid");
    if (fastSupport.find()) throw new IllegalArgumentException("Ambiguous Fast model policy");
    var supportedUltra = new HashSet<String>();
    // Match the standalone eligibility statement, not a later sentence such as
    // "GPT-6.1 Sol Ultrafast supports inference residency ...".
    var support =
        Pattern.compile("(?m)^\\s*Ultrafast supports ([\\s\\S]+?)\\.(?=\\s|$)").matcher(speed);
    if (!support.find()) throw new IllegalArgumentException("Ultrafast model policy unavailable");
    for (String label : clean(support.group(1)).split(",|\\s+and\\s+")) {
      String id = modelId(label.trim());
      if (id != null) supportedUltra.add(id);
    }
    if (supportedUltra.isEmpty())
      throw new IllegalArgumentException("Ultrafast model policy invalid");
    if (support.find()) throw new IllegalArgumentException("Ambiguous Ultrafast model policy");
    var rates = new LinkedHashMap<String, ProviderCostEstimate.Rates>();
    var tables = TABLE.matcher(pricing);
    int matchingTables = 0;
    while (tables.find()) {
      var rows = ROW.matcher(tables.group(1));
      if (!rows.find()) continue;
      if (!cells(rows.group(1))
          .equals(
              List.of(
                  "Credits per 1M tokens", "Input Tokens", "Cached input tokens", "Output Tokens")))
        continue;
      matchingTables++;
      while (rows.find()) {
        var values = cells(rows.group(1));
        if (values.size() != 4) {
          if (!values.isEmpty() && modelId(values.get(0)) != null)
            throw new IllegalArgumentException("Incomplete model rate row");
          continue;
        }
        String id = modelId(values.get(0));
        if (id == null)
          continue; // Images with distinct text/image categories cannot be priced as text-only
        // calls.
        String input = tokenRate(values.get(1)),
            cached = tokenRate(values.get(2)),
            output = tokenRate(values.get(3));
        if (new BigDecimal(cached).compareTo(new BigDecimal(input)) > 0 || rates.size() >= 200)
          throw new IllegalArgumentException("Inconsistent rate table");
        boolean legacyFast =
            speedPlain.contains("For GPT-5.6, the speed increase is 1.5x.")
                && Set.of("gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna").contains(id);
        boolean fastSupported = supportedFast.contains(id) || legacyFast;
        if (rates.putIfAbsent(
                id,
                new ProviderCostEstimate.Rates(
                    input,
                    cached,
                    output,
                    fastSupported ? fast : null,
                    supportedUltra.contains(id) ? ultra : null))
            != null) throw new IllegalArgumentException("Ambiguous duplicate model rate");
      }
    }
    if (matchingTables != 1 || rates.isEmpty())
      throw new IllegalArgumentException("Expected one explicit Codex credit table");
    String version;
    try {
      version =
          HexFormat.of()
              .formatHex(
                  MessageDigest.getInstance("SHA-256")
                      .digest((pricing + "\n" + speed).getBytes(StandardCharsets.UTF_8)));
    } catch (Exception error) {
      throw new IllegalStateException(error);
    }
    return new ProviderCostEstimate.RateCard(
        rates,
        fetched.atZone(ZoneOffset.UTC).toLocalDate().toString(),
        ProviderCostEstimate.CODEX_SOURCE,
        ProviderCostEstimate.SPEED_SOURCE,
        version,
        fetched.toString(),
        fastIncluded,
        ultraIncluded);
  }

  private static List<String> cells(String row) {
    var values = new ArrayList<String>();
    var matcher = CELL.matcher(row);
    while (matcher.find()) values.add(clean(matcher.group(1)));
    return values;
  }

  private static String clean(String text) {
    return text.replaceAll("<[^>]+>", " ")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replaceAll("\\s+", " ")
        .trim();
  }

  private static String modelId(String label) {
    // Canonical spelling from the published model label, never fuzzy family/prefix pricing.
    if (!label.matches("(?i)[a-z][a-z0-9]*(?:[. -][a-z0-9]+)*") || label.length() > 120)
      return null;
    return label.toLowerCase(Locale.ROOT).replace(' ', '-');
  }

  private static String tokenRate(String cell) {
    if (!cell.matches("[0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)? credits"))
      throw new IllegalArgumentException("Invalid credit rate");
    return boundedNumber(cell.replace(" credits", "").replace(",", ""), "1000000", true);
  }

  private static String matchedRate(String content, String expression) {
    var matcher = Pattern.compile(expression).matcher(content);
    if (!matcher.find()) throw new IllegalArgumentException("Speed rate unavailable");
    String rate = boundedNumber(matcher.group(1), "100", false);
    while (matcher.find()) {
      if (!rate.equals(boundedNumber(matcher.group(1), "100", false)))
        throw new IllegalArgumentException("Conflicting speed rates");
    }
    return rate;
  }

  private static String boundedNumber(String value, String maximum, boolean zero) {
    var number = new BigDecimal(value);
    if (number.scale() > 6
        || number.signum() < (zero ? 0 : 1)
        || number.compareTo(new BigDecimal(maximum)) > 0)
      throw new IllegalArgumentException("Rate outside validated range");
    return number.stripTrailingZeros().toPlainString();
  }

  static String fetch(URI uri, Duration timeout) throws Exception {
    var client =
        HttpClient.newBuilder()
            .connectTimeout(timeout)
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();
    var request =
        HttpRequest.newBuilder(uri)
            .timeout(timeout)
            .header("Accept", "text/markdown,text/plain,text/html")
            .header("User-Agent", "Argus-Public-Rate-Card/1")
            .GET()
            .build();
    var response = client.send(request, info -> new LimitedBody());
    if (response.statusCode() != 200)
      throw new IllegalStateException("Official pricing source unavailable");
    return new String(response.body(), StandardCharsets.UTF_8);
  }

  private static final class LimitedBody implements HttpResponse.BodySubscriber<byte[]> {
    private final HttpResponse.BodySubscriber<byte[]> delegate =
        HttpResponse.BodySubscribers.ofByteArray();
    private Flow.Subscription subscription;
    private long size;

    public CompletionStage<byte[]> getBody() {
      return delegate.getBody();
    }

    public void onSubscribe(Flow.Subscription value) {
      subscription = value;
      delegate.onSubscribe(value);
    }

    public void onNext(List<ByteBuffer> buffers) {
      for (var buffer : buffers) size += buffer.remaining();
      if (size > MAX_BYTES) {
        subscription.cancel();
        delegate.onError(new IllegalStateException("Pricing response too large"));
      } else delegate.onNext(buffers);
    }

    public void onError(Throwable error) {
      delegate.onError(error);
    }

    public void onComplete() {
      delegate.onComplete();
    }
  }

  public String ownerName() {
    return "public credit rate refresh";
  }

  public int shutdownOrder() {
    return 96;
  }

  public void quiesce() {
    close();
  }

  public void close() {
    closed = true;
    worker.shutdownNow();
    try {
      if (!worker.awaitTermination(25, TimeUnit.SECONDS))
        throw new IllegalStateException("Credit rate refresh did not stop");
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException(error);
    }
  }
}
