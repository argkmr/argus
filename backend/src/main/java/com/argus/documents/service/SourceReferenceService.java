package com.argus.documents.service;

import com.argus.workspace.domain.Repository;
import com.argus.workspace.service.WorkspaceService;
import java.io.IOException;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class SourceReferenceService {
  private static final String DOCX =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  private static final Map<String, String> TYPES =
      Map.ofEntries(
          Map.entry("pdf", "application/pdf"),
          Map.entry("docx", DOCX),
          Map.entry("doc", "application/msword"),
          Map.entry("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
          Map.entry("xls", "application/vnd.ms-excel"),
          Map.entry(
              "pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
          Map.entry("ppt", "application/vnd.ms-powerpoint"),
          Map.entry("odt", "application/vnd.oasis.opendocument.text"),
          Map.entry("ods", "application/vnd.oasis.opendocument.spreadsheet"),
          Map.entry("odp", "application/vnd.oasis.opendocument.presentation"),
          Map.entry("rtf", "application/rtf"),
          Map.entry("zip", "application/zip"),
          Map.entry("tar", "application/x-tar"),
          Map.entry("gz", "application/gzip"),
          Map.entry("tgz", "application/gzip"),
          Map.entry("bz2", "application/x-bzip2"),
          Map.entry("xz", "application/x-xz"),
          Map.entry("7z", "application/x-7z-compressed"),
          Map.entry("rar", "application/vnd.rar"));
  private static final Set<String> ARCHIVES =
      Set.of("zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar");
  private final WorkspaceService workspace;
  private final WordPreviewService word;

  public SourceReferenceService(WorkspaceService workspace, WordPreviewService word) {
    this.workspace = workspace;
    this.word = word;
  }

  public record Reference(String path, Integer line, Integer column, Integer endLine) {}

  private record Root(Repository repository, Path lexical, Path real) {}

  private record Resolved(Root root, Path file, Reference reference) {}

  public record Content(byte[] bytes, Map<String, String> headers) {}

  public Map<String, Object> read(String target, String repositoryId) {
    Resolved resolved = resolve(target, repositoryId);
    if (Files.isDirectory(resolved.file, LinkOption.NOFOLLOW_LINKS)) {
      requireDirectory(resolved);
      var result = locationMetadata(resolved);
      result.put("kind", "directory");
      result.put("previewType", "directory");
      result.put("size", null);
      result.put("contentUrl", null);
      result.put("downloadUrl", null);
      return result;
    }
    byte[] bytes = readBytes(resolved);
    var result = metadata(resolved, bytes.length);
    String extension = extension(resolved.file), mime = TYPES.get(extension);
    if (mime != null) {
      boolean pdf = mime.equals("application/pdf") && pdf(bytes);
      result.put("kind", "document");
      result.put("previewType", pdf ? "pdf" : "download");
      result.put("mimeType", mime);
      String url = (String) result.get("contentUrl");
      if (!pdf) result.put("contentUrl", null);
      if (ARCHIVES.contains(extension))
        result.put(
            "previewNotice",
            "This archive is a downloadable bundle, not a document preview. Download the unchanged original to access its files.");
      if (extension.equals("doc") || extension.equals("docx")) {
        try {
          word.preview(bytes, extension.equals("doc"));
          result.put("previewType", "docx");
          result.put("previewMimeType", DOCX);
          result.put("contentUrl", url + "&preview=docx");
          if (extension.equals("doc"))
            result.put(
                "previewNotice",
                "Converted locally for preview. Some legacy Word layout features may differ; the download is your unchanged original.");
        } catch (ResponseStatusException error) {
          result.put("previewNotice", error.getReason());
        }
      }
      return result;
    }
    // An unrecognized binary is still a safely resolved, bounded original.
    // Keep its filename and download action instead of opening an empty error dialog.
    if (containsZero(bytes)) {
      result.put("kind", "document");
      result.put("previewType", "download");
      result.put("mimeType", "application/octet-stream");
      result.put("contentUrl", null);
      result.put(
          "previewNotice",
          "This file format does not have an in-app preview. Download the unchanged original to open it in a compatible application.");
      return result;
    }
    if (bytes.length > 2 * 1024 * 1024) {
      if (Set.of("md", "markdown").contains(extension)) {
        result.put("kind", "document");
        result.put("previewType", "download");
        result.put("mimeType", "text/markdown");
        result.put("contentUrl", null);
        result.put(
            "previewNotice",
            "This Markdown document exceeds the 2 MB preview limit. Download the unchanged original to open it in an editor.");
        return result;
      }
      throw failure(413, "This source file is larger than the 2 MB preview limit.");
    }
    String content = new String(bytes, StandardCharsets.UTF_8);
    String[] lines = content.split("\\r\\n|\\r|\\n", -1);
    int requested = resolved.reference.line == null ? 1 : resolved.reference.line,
        line = Math.min(requested, lines.length);
    result.put("kind", "text");
    result.put("mimeType", "text/plain");
    result.put("contentUrl", null);
    result.put("content", content);
    result.put("line", line);
    result.put(
        "column",
        resolved.reference.column == null
            ? null
            : Math.min(resolved.reference.column, lines[line - 1].length() + 1));
    result.put("lineCount", lines.length);
    result.put("requestedLine", requested);
    result.put(
        "endLine",
        resolved.reference.endLine == null
            ? null
            : Math.min(Math.max(resolved.reference.endLine, line), lines.length));
    return result;
  }

  public Content content(String target, String repositoryId, boolean download, String preview) {
    Resolved resolved = resolve(target, repositoryId);
    byte[] bytes = readBytes(resolved);
    String ext = extension(resolved.file),
        mime = TYPES.get(ext),
        name = resolved.file.getFileName().toString();
    boolean formatted = !download && "docx".equals(preview);
    if (!download && preview != null && !preview.isEmpty() && !formatted)
      throw failure(400, "This document preview format is not supported.");
    if (formatted) {
      if (!Set.of("doc", "docx").contains(ext))
        throw failure(415, "Formatted Word previews require a DOC or DOCX document.");
      bytes = word.preview(bytes, ext.equals("doc"));
      mime = DOCX;
      if (ext.equals("doc")) name += "x";
    }
    boolean inline = !download && "application/pdf".equals(mime) && pdf(bytes);
    if (mime == null)
      mime = containsZero(bytes) ? "application/octet-stream" : "text/plain; charset=utf-8";
    Map<String, String> headers = new LinkedHashMap<>();
    headers.put("content-type", mime);
    headers.put("content-length", String.valueOf(bytes.length));
    headers.put("content-disposition", disposition(name, inline));
    headers.put("cache-control", "no-store");
    headers.put("x-content-type-options", "nosniff");
    headers.put("content-security-policy", "default-src 'none'; sandbox");
    headers.put("cross-origin-resource-policy", "same-origin");
    headers.put("referrer-policy", "no-referrer");
    headers.put("accept-ranges", "none");
    return new Content(bytes, headers);
  }

  /** Resolve again for an explicit Finder action; never list or onboard the directory. */
  public Path directory(String target, String repositoryId) {
    Resolved resolved = resolve(target, repositoryId);
    requireDirectory(resolved);
    return resolved.file;
  }

  private static void requireDirectory(Resolved resolved) {
    if (!Files.isDirectory(resolved.file, LinkOption.NOFOLLOW_LINKS))
      throw failure(400, "Only folders can be shown in Finder from this reference.");
    if (resolved.reference.line != null)
      throw failure(
          400, "Folders do not have line numbers. Use the folder path without a line reference.");
  }

  public static Reference parse(String value) {
    if (value == null || value.isBlank() || value.length() > 8192)
      throw failure(400, "This is not a supported local file or folder reference.");
    String target = value.trim();
    if (target.startsWith("<") && target.endsWith(">"))
      target = target.substring(1, target.length() - 1);
    target = target.replaceAll("\\\\([!\"#$%&'()*+,\\-./:;<=>?@\\[\\]\\\\^_`{|}~])", "$1");
    try {
      target = URLDecoder.decode(target.replace("+", "%2B"), StandardCharsets.UTF_8);
    } catch (IllegalArgumentException e) {
      throw failure(400, "Invalid encoded source reference.");
    }
    if (target.matches("(?s).*[\\x00-\\x1f\\x7f-\\x9f\\\\].*"))
      throw failure(400, "Invalid source reference.");
    if (target.regionMatches(true, 0, "file:", 0, 5)) {
      Matcher file = Pattern.compile("(?i)^file://(?:localhost)?(/.*)$").matcher(target);
      if (!file.matches()) throw failure(400, "Only local file references are supported.");
      target = file.group(1);
    }
    Integer line = null, column = null, end = null;
    String file = target;
    Matcher fragment = Pattern.compile("(?i)^(.*?)#L(\\d+)(?:-L?(\\d+))?$").matcher(target);
    Matcher colon = Pattern.compile("^(.*?):(\\d+)(?::(\\d+))?$").matcher(target);
    if (fragment.matches()) {
      file = fragment.group(1);
      line = position(fragment.group(2));
      end = position(fragment.group(3));
    } else if (colon.matches()) {
      file = colon.group(1);
      line = position(colon.group(2));
      column = position(colon.group(3));
    }
    if (file.isEmpty()
        || file.startsWith("//")
        || file.matches("(?i)^[a-z][a-z\\d+.-]*:.*")
        || file.matches(".*[?#<>].*")
        || end != null && end < line)
      throw failure(400, "This is not a supported local file or folder reference.");
    if (!file.startsWith("/")
        && !file.startsWith("~/")
        && Arrays.asList(file.split("/", -1)).contains(".."))
      throw failure(403, "Use an absolute local path to open a file outside its repository.");
    return new Reference(file, line, column, end);
  }

  private static Integer position(String value) {
    if (value == null) return null;
    try {
      int number = Integer.parseInt(value);
      if (number < 1) throw new NumberFormatException();
      return number;
    } catch (NumberFormatException e) {
      throw failure(400, "Invalid source position.");
    }
  }

  private Resolved resolve(String target, String preferredId) {
    Reference reference = parse(target);
    List<Root> roots = new ArrayList<>();
    for (Repository repository : workspace.snapshot().repositories()) {
      try {
        Path lexical = Path.of(repository.path()).toAbsolutePath().normalize();
        roots.add(new Root(repository, lexical, lexical.toRealPath()));
      } catch (IOException ignored) {
      }
    }
    Path requested =
        reference.path.startsWith("~/")
            ? homeDirectory().resolve(reference.path.substring(2).replaceFirst("^/+", ""))
            : Path.of(reference.path);
    Resolved resolved = null;
    if (requested.isAbsolute()) {
      // Explicit local references do not onboard their directory or grant
      // the agent tools access to another repository.
      resolved = absoluteCandidate(roots, requested, reference);
    } else {
      if (roots.isEmpty())
        throw failure(
            404,
            "Use an absolute local path, or connect the repository for this relative reference.");
      Root preferred =
          roots.stream()
              .filter(root -> root.repository.id().equals(preferredId))
              .findFirst()
              .orElse(null);
      if (preferred != null)
        resolved = candidate(preferred, preferred.real.resolve(requested), reference);
      if (resolved == null) {
        Map<Path, Resolved> matches = new LinkedHashMap<>();
        for (Root root : roots)
          if (root != preferred) {
            Resolved value = candidate(root, root.real.resolve(requested), reference);
            if (value != null) matches.put(value.file, value);
          }
        if (matches.size() > 1)
          throw failure(
              409,
              "This relative source path exists in more than one connected repository. Open the relevant repository chat or use an absolute file reference.");
        resolved = matches.values().stream().findFirst().orElse(null);
      }
    }
    if (resolved == null)
      throw failure(
          404,
          "This local file or folder could not be found. It may have moved since the response was generated.");
    return resolved;
  }

  protected Path homeDirectory() {
    String home = System.getProperty("user.home");
    if (home == null || home.isBlank() || !Path.of(home).isAbsolute())
      throw failure(400, "The home folder is unavailable. Use an absolute local file path.");
    return Path.of(home);
  }

  private static Resolved absoluteCandidate(List<Root> roots, Path candidate, Reference reference) {
    try {
      Path real = candidate.toRealPath();
      requireSupportedPath(real);
      Root root =
          roots.stream()
              .filter(value -> real.startsWith(value.real))
              .max(Comparator.comparingInt(value -> value.real.getNameCount()))
              .orElse(null);
      return new Resolved(root, real, reference);
    } catch (java.nio.file.NoSuchFileException e) {
      return null;
    } catch (IOException e) {
      throw failure(403, "Argus does not have permission to read this local file.");
    }
  }

  private static void requireRegularFile(Path file) {
    if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS))
      throw failure(
          400, "This preview requires a regular file. Folders can be shown in Finder instead.");
  }

  private static void requireSupportedPath(Path file) {
    if (!Files.isDirectory(file, LinkOption.NOFOLLOW_LINKS)) requireRegularFile(file);
  }

  private static Resolved candidate(Root root, Path candidate, Reference reference) {
    if (!candidate.normalize().startsWith(root.real)
        && !candidate.normalize().startsWith(root.lexical))
      throw failure(403, "Source references must stay inside a connected repository.");
    try {
      Path real = candidate.toRealPath();
      if (!real.startsWith(root.real))
        throw failure(
            403, "This source reference points outside its repository through a symbolic link.");
      requireSupportedPath(real);
      return new Resolved(root, real, reference);
    } catch (java.nio.file.NoSuchFileException e) {
      return null;
    } catch (IOException e) {
      throw failure(403, "Argus does not have permission to read this source file.");
    }
  }

  private static byte[] readBytes(Resolved resolved) {
    requireRegularFile(resolved.file);
    try (SeekableByteChannel channel =
        Files.newByteChannel(
            resolved.file, Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS))) {
      long size = channel.size();
      if (size > WordPreviewService.MAX_BYTES)
        throw failure(413, "This file is larger than the 50 MB document/download limit.");
      Path current = resolved.file.toRealPath();
      if (!current.equals(resolved.file)
          || resolved.root != null && !current.startsWith(resolved.root.real)
          || !Files.isRegularFile(current))
        throw failure(403, "This file changed location. Open the source reference again.");
      ByteBuffer buffer = ByteBuffer.allocate((int) size + 1);
      while (buffer.hasRemaining() && channel.read(buffer) != -1) {}
      if (buffer.position() != size)
        throw failure(409, "This file changed while it was being read. Download it again.");
      return Arrays.copyOf(buffer.array(), (int) size);
    } catch (java.nio.file.NoSuchFileException e) {
      throw failure(404, "This source file is no longer available.");
    } catch (IOException e) {
      throw failure(
          403, "This local file cannot be read safely. Check its permissions and try again.");
    }
  }

  private static LinkedHashMap<String, Object> metadata(Resolved resolved, int size) {
    String url =
        "/api/source-reference/content?target="
            + encode(resolved.file.toString().replace("%", "%25"));
    Root root = resolved.root;
    if (root != null) url += "&repositoryId=" + encode(root.repository.id());
    var result = locationMetadata(resolved);
    result.put("size", size);
    result.put("downloadUrl", url + "&download=true");
    result.put("contentUrl", url);
    return result;
  }

  private static LinkedHashMap<String, Object> locationMetadata(Resolved resolved) {
    Root root = resolved.root;
    var result = new LinkedHashMap<String, Object>();
    result.put("scope", root == null ? "local" : "repository");
    result.put("repositoryId", root == null ? null : root.repository.id());
    result.put("repositoryName", root == null ? null : root.repository.name());
    result.put(
        "file",
        root == null ? resolved.file.toString() : root.real.relativize(resolved.file).toString());
    result.put(
        "name",
        resolved.file.getFileName() == null
            ? resolved.file.toString()
            : resolved.file.getFileName().toString());
    result.put("path", resolved.file.toString());
    return result;
  }

  private static String extension(Path path) {
    String name = path.getFileName().toString();
    int dot = name.lastIndexOf('.');
    return dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
  }

  private static boolean containsZero(byte[] bytes) {
    for (byte value : bytes) if (value == 0) return true;
    return false;
  }

  private static boolean pdf(byte[] bytes) {
    // Match the bounded header search used by our PDF.js viewer. Some readable
    // PDFs have leading bytes; do not rewrite the original or scan the full file.
    int limit = Math.min(bytes.length, 1024);
    for (int index = 0; index + 5 <= limit; index++)
      if (bytes[index] == '%'
          && bytes[index + 1] == 'P'
          && bytes[index + 2] == 'D'
          && bytes[index + 3] == 'F'
          && bytes[index + 4] == '-') return true;
    return false;
  }

  private static String encode(String text) {
    return URLEncoder.encode(text, StandardCharsets.UTF_8).replace("+", "%20");
  }

  private static String disposition(String name, boolean inline) {
    String fallback = name.replaceAll("[^\\x20-\\x7e]|[\"\\\\;]", "_");
    return (inline ? "inline" : "attachment")
        + "; filename=\""
        + fallback
        + "\"; filename*=UTF-8''"
        + encode(name).replace("*", "%2A");
  }

  private static ResponseStatusException failure(int status, String message) {
    return new ResponseStatusException(HttpStatus.valueOf(status), message);
  }
}
