package com.argus.repositorycontext.service;

import static com.argus.runtime.service.RuntimeData.*;

import com.argus.workspace.domain.Repository;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

@Service
public class AiKitCoverageService {
  private static final Set<String> IGNORED =
      Set.of(
          ".git",
          ".idea",
          ".next",
          ".gradle",
          ".mvn",
          "build",
          "coverage",
          "dist",
          "node_modules",
          "out",
          "target",
          "vendor",
          "venv",
          ".venv",
          "__pycache__");
  private static final Pattern SOURCE =
      Pattern.compile(
          ".*\\.(?:java|kt|kts|js|mjs|cjs|jsx|ts|tsx|py|go|rb|cs|scala)$",
          Pattern.CASE_INSENSITIVE);
  private static final String[][] ENTRY = {
    {
      "http",
      "@(Get|Post|Put|Patch|Delete|Request)Mapping\\b|\\b(?:router|app|server|fastify)\\.(?:get|post|put|patch|delete|options|head|route)\\s*\\(|@(?:app|router)\\.(?:get|post|put|patch|delete)\\s*\\(|\\bHandleFunc\\s*\\("
    },
    {
      "graphql",
      "@(Query|Mutation|Subscription)Mapping\\b|@(?:Query|Mutation|Subscription|ResolveField)\\s*\\("
    },
    {
      "message-consumer",
      "@(KafkaListener|RabbitListener|SqsListener|JmsListener|EventListener)\\b|\\b(?:consumer|subscriber)\\.(?:on|subscribe)\\s*\\("
    },
    {"scheduled-job", "@Scheduled\\b|@Cron\\s*\\(|\\bcron\\.schedule\\s*\\(|\\bscheduleJob\\s*\\("},
    {"command", "@Command\\b|\\b(?:program|cli)\\.command\\s*\\("}
  };
  private final ObjectMapper json;

  public AiKitCoverageService(ObjectMapper json) {
    this.json = json;
  }

  public Map<String, Object> inventory(Repository repository) {
    Path root = Path.of(repository.path());
    var queue = new java.util.ArrayDeque<Path>();
    queue.add(root);
    var files = new ArrayList<Path>();
    while (!queue.isEmpty() && files.size() < 6000) {
      Path directory = queue.remove();
      try (var stream = Files.list(directory)) {
        for (Path item : stream.sorted().toList()) {
          String name = item.getFileName().toString();
          if (Files.isSymbolicLink(item) || name.startsWith(".")) continue;
          if (Files.isDirectory(item, LinkOption.NOFOLLOW_LINKS)) {
            if (!IGNORED.contains(name)) queue.add(item);
          } else if (SOURCE.matcher(name).matches()) files.add(item);
          if (files.size() >= 6000) break;
        }
      } catch (java.io.IOException ignored) {
      }
    }
    var entries = new ArrayList<Map<String, Object>>();
    for (Path file : files) {
      String source = read(file);
      if (source.indexOf('\0') >= 0) continue;
      String relative = root.relativize(file).toString().replace('\\', '/');
      String[] lines = source.split("\\r?\\n", -1);
      for (int i = 0; i < lines.length; i++)
        for (String[] candidate : ENTRY)
          if (Pattern.compile(candidate[1], Pattern.CASE_INSENSITIVE).matcher(lines[i]).find()) {
            String signature = lines[i].trim();
            entries.add(
                object(
                    "id",
                    candidate[0] + ":" + hash(relative + ":" + (i + 1)).substring(0, 16),
                    "type",
                    candidate[0],
                    "signature",
                    signature.substring(0, Math.min(500, signature.length())),
                    "source",
                    object("path", relative, "line", i + 1)));
            break;
          }
    }
    return object(
        "schemaVersion",
        1,
        "repository",
        repository.name(),
        "productionBranch",
        repository.productionBranch(),
        "generatedAt",
        Instant.now().toString(),
        "fingerprint",
        hash(json.writeValueAsString(entries)),
        "entryPoints",
        entries);
  }

  public Map<String, Object> validate(Path staging, Map<String, Object> inventory) {
    var coverage =
        map(json.readValue(read(inside(staging, "skill-coverage.json")), LinkedHashMap.class));
    if (number(coverage.get("schemaVersion")) != 1)
      throw new IllegalArgumentException("skill-coverage.json must use schemaVersion 1");
    if (!text(coverage, "inventoryFingerprint").equals(text(inventory, "fingerprint")))
      throw new IllegalArgumentException(
          "skill-coverage.json does not match the production entry-point inventory");
    var expected = new LinkedHashMap<String, Map<String, Object>>();
    for (Object item : list(inventory.get("entryPoints")))
      expected.put(text(map(item), "id"), map(item));
    var seen = new LinkedHashSet<String>();
    var skills = new LinkedHashSet<String>();
    for (Object raw : list(coverage.get("entries"))) {
      var item = map(raw);
      String id = text(item, "entryPointId"), skill = text(item, "skill").trim();
      if (!expected.containsKey(id))
        throw new IllegalArgumentException(
            "skill-coverage.json contains unknown entry point " + id);
      if (!seen.add(id))
        throw new IllegalArgumentException("Entry point " + id + " is covered more than once");
      if (text(item, "businessFlow").isBlank())
        throw new IllegalArgumentException("Entry point " + id + " has no business flow");
      if (!skill.matches("[a-z0-9]+(?:-[a-z0-9]+)*"))
        throw new IllegalArgumentException("Entry point " + id + " has an invalid Skill name");
      var source = map(expected.get(id).get("source"));
      if (list(item.get("evidence")).stream()
          .noneMatch(
              value ->
                  text(map(value), "path").equals(text(source, "path"))
                      && number(map(value).get("line")) == number(source.get("line"))))
        throw new IllegalArgumentException(
            "Entry point "
                + id
                + " is missing exact source evidence "
                + source.get("path")
                + ":"
                + source.get("line"));
      skills.add(skill);
    }
    var missing = expected.keySet().stream().filter(id -> !seen.contains(id)).toList();
    if (!missing.isEmpty())
      throw new IllegalArgumentException(
          "AI-kit coverage is incomplete: "
              + missing.size()
              + " production entry points missing ("
              + String.join(", ", missing.subList(0, Math.min(5, missing.size())))
              + ")");
    String agents = read(inside(staging, "AGENTS.md"));
    for (String skill : skills) {
      String contents = read(inside(staging, "skills/" + skill + "/SKILL.md"));
      var front = Pattern.compile("^---\\s*\\n([\\s\\S]*?)\\n---\\s*\\n").matcher(contents);
      if (!front.find())
        throw new IllegalArgumentException("Skill " + skill + " is missing YAML frontmatter");
      String header = front.group(1);
      var name = Pattern.compile("(?m)^name:\\s*['\"]?([^'\"\\n]+)['\"]?\\s*$").matcher(header);
      if (!name.find() || !skill.equals(name.group(1).trim()))
        throw new IllegalArgumentException(
            "Skill " + skill + " frontmatter name must exactly match its directory");
      if (!Pattern.compile("(?m)^description:\\s*(.+)$").matcher(header).find())
        throw new IllegalArgumentException(
            "Skill " + skill + " frontmatter description is required");
      for (String section :
          List.of(
              "purpose",
              "entry point",
              "flow",
              "validation",
              "dependenc",
              "failure",
              "observability",
              "source"))
        if (!Pattern.compile(
                "^#{1,4}\\s+.*" + section, Pattern.CASE_INSENSITIVE | Pattern.MULTILINE)
            .matcher(contents)
            .find())
          throw new IllegalArgumentException(
              "Skill " + skill + " is incomplete; missing section: " + section);
      if (!agents.contains(skill))
        throw new IllegalArgumentException("AGENTS.md does not route to Skill " + skill);
    }
    return object(
        "coverage",
        coverage,
        "coveredEntryPoints",
        seen.size(),
        "totalEntryPoints",
        expected.size(),
        "referencedSkills",
        skills.stream().sorted().toList());
  }

  public static String hash(String input) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256")
                  .digest(input.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    } catch (Exception error) {
      throw new IllegalStateException(error);
    }
  }
}
