package com.argus.context.service;

import com.argus.common.error.NotFoundException;
import com.argus.context.domain.ContextAttachment;
import com.argus.context.repository.ContextRepository;
import com.argus.documents.service.WordPreviewService;
import com.argus.tasks.domain.AiTask;
import com.argus.tasks.repository.TaskRepository;
import java.io.IOException;
import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.ObjectMapper;

/** Read-only previews addressed by saved IDs, never caller-supplied filesystem paths. */
@Service
public class ContextPreviewService {
  private static final int MAX_BYTES = 20_000_000 + 65_536;
  private static final int MAX_TEXT_BYTES = 2 * 1024 * 1024;
  private static final String DOCX =
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  private final ContextService contexts;
  private final ContextRepository repository;
  private final TaskRepository tasks;
  private final WordPreviewService word;
  private final ObjectMapper mapper;
  private final LinkedHashMap<String, ContextAttachment> recovered =
      new LinkedHashMap<>(16, 0.75f, true);

  public ContextPreviewService(
      ContextService contexts,
      ContextRepository repository,
      TaskRepository tasks,
      WordPreviewService word,
      ObjectMapper mapper) {
    this.contexts = contexts;
    this.repository = repository;
    this.tasks = tasks;
    this.word = word;
    this.mapper = mapper;
  }

  public record Content(byte[] bytes, Map<String, String> headers) {}

  private record Format(String type, String mime) {}

  public Map<String, Object> preview(String id) {
    ContextAttachment attachment = attachment(id);
    byte[] bytes = read(attachment);
    Format format = format(attachment, bytes);
    String contentUrl = "/api/context/" + id + "/content";
    var result = new LinkedHashMap<String, Object>();
    result.put("id", id);
    result.put("kind", attachment.kind());
    result.put("title", attachment.title());
    result.put("fileName", filename(attachment));
    result.put("size", bytes.length);
    result.put("mimeType", format.mime());
    result.put("previewType", format.type());
    result.put("contentUrl", format.type().equals("download") ? null : contentUrl);
    result.put("downloadUrl", contentUrl + "?download=true");
    if (format.type().equals("text")) {
      result.put("content", displayText(attachment, text(bytes)));
    } else if (format.type().equals("docx")) {
      try {
        word.preview(bytes, extension(attachment).equals("doc"));
        result.put("contentUrl", contentUrl + "?preview=docx");
        result.put("previewMimeType", DOCX);
      } catch (ResponseStatusException error) {
        result.put("previewType", "download");
        result.put("contentUrl", null);
        result.put("previewNotice", error.getReason());
      }
    } else if (format.type().equals("download")) {
      result.put(
          "previewNotice",
          "This file cannot be previewed safely in Argus. Download the unchanged original to open it in a compatible application.");
    }
    return result;
  }

  public Content content(String id, boolean download, String preview) {
    ContextAttachment attachment = attachment(id);
    byte[] bytes = read(attachment);
    Format format = format(attachment, bytes);
    String name = filename(attachment), mime = format.mime();
    if (!download && preview != null && !preview.isEmpty()) {
      if (!preview.equals("docx")) throw failure(400, "This attachment preview is not supported.");
      if (!format.type().equals("docx"))
        throw failure(415, "Formatted Word previews require a DOC or DOCX attachment.");
      bytes = word.preview(bytes, extension(attachment).equals("doc"));
      mime = DOCX;
      if (extension(attachment).equals("doc")) name += "x";
    }
    boolean inline = !download && !Set.of("download", "docx").contains(format.type());
    var headers = new LinkedHashMap<String, String>();
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

  private ContextAttachment attachment(String id) {
    if (id == null || !id.matches("(?i)[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}"))
      throw failure(400, "Invalid saved attachment ID.");
    try {
      try {
        return contexts.get(id);
      } catch (NotFoundException missing) {
        ContextAttachment cached = recovered(id);
        if (cached != null) {
          try {
            // Cache identities, never file bytes or successful safety checks.
            return restored(cached);
          } catch (NotFoundException unavailable) {
            forgetRecovered(id);
          }
        }
        // The recent context index contains only 100 entries. Saved messages,
        // checkpoints and revision drafts retain the full attachment identity.
        for (var item : repository.list())
          if (id.equals(item.id())) return rememberRecovered(restored(item));
        for (var summary : tasks.list()) {
          AiTask task;
          try {
            task = tasks.readTask(summary.id());
          } catch (NotFoundException removed) {
            continue;
          }
          for (var candidate : savedAttachments(task)) {
            if (id.equals(candidate.get("id")))
              return rememberRecovered(
                  restored(mapper.convertValue(candidate, ContextAttachment.class)));
          }
          if (task.additionalProperties().containsKey("revisionOf")
              || task.additionalProperties().get("revisionCount") instanceof Number count
                  && count.longValue() > 0) {
            for (var revision : tasks.revisions(summary.id())) {
              if (!(revision.get("id") instanceof String revisionId)) continue;
              try {
                Object archived = tasks.revision(summary.id(), revisionId).get("task");
                if (archived instanceof AiTask previous)
                  for (var candidate : savedAttachments(previous))
                    if (id.equals(candidate.get("id")))
                      return rememberRecovered(
                          restored(mapper.convertValue(candidate, ContextAttachment.class)));
              } catch (NotFoundException removed) {
                // A concurrently removed task/version cannot supply this ID.
              }
            }
          }
        }
        throw missing;
      } catch (IllegalArgumentException invalid) {
        // The old data directory can still exist after a same-machine restore.
        // Resolve its saved identity, not its outside-root bytes.
        for (var item : repository.list())
          if (id.equals(item.id())) return rememberRecovered(restored(item));
        throw invalid;
      }
    } catch (IllegalArgumentException invalid) {
      throw failure(
          invalid.getMessage() != null && invalid.getMessage().contains("size limit") ? 413 : 403,
          "The saved attachment cannot be read safely from Argus context storage.");
    }
  }

  private synchronized ContextAttachment recovered(String id) {
    return recovered.get(id);
  }

  private synchronized void forgetRecovered(String id) {
    recovered.remove(id);
  }

  private synchronized ContextAttachment rememberRecovered(ContextAttachment attachment) {
    recovered.put(attachment.id(), attachment);
    while (recovered.size() > 128) recovered.remove(recovered.keySet().iterator().next());
    return attachment;
  }

  private ContextAttachment restored(ContextAttachment item) {
    try {
      return contexts.validateSaved(item);
    } catch (NotFoundException | IllegalArgumentException invalid) {
      // A backup may retain an old absolute data-directory prefix. Recover only
      // its exact saved basename beneath the current attachment root, then run
      // the same containment/readability/size validation again. Never write it.
      if (item.path() == null) throw invalid;
      Path original = Path.of(item.path()), basename = original.getFileName();
      Path root = repository.directory().toAbsolutePath().normalize();
      Path realRoot;
      try {
        realRoot = root.toRealPath();
      } catch (IOException unavailable) {
        throw invalid;
      }
      // Current-root escapes must stay rejected, including replaced symlinks.
      // Only an absolute, unambiguous old context-attachments prefix can move.
      if (basename == null
          || !original.isAbsolute()
          || !original.normalize().equals(original)
          || original.startsWith(root)
          || original.startsWith(realRoot)
          || original.getParent() == null
          || !"context-attachments".equals(String.valueOf(original.getParent().getFileName())))
        throw invalid;
      var relocated =
          new ContextAttachment(
              item.id(),
              item.kind(),
              item.title(),
              item.url(),
              repository.directory().resolve(basename).toString(),
              item.size(),
              item.mimeType(),
              item.repositoryId(),
              item.createdAt());
      return contexts.validateSaved(relocated);
    }
  }

  private static List<Map<String, Object>> savedAttachments(AiTask task) {
    var result = new ArrayList<Map<String, Object>>();
    if (task.messages != null)
      for (var message : task.messages)
        if (message.attachments != null) result.addAll(message.attachments);
    if (task.checkpoints != null)
      for (var checkpoint : task.checkpoints)
        if (checkpoint.message() != null && checkpoint.message().attachments != null)
          result.addAll(checkpoint.message().attachments);
    Object draft = task.additionalProperties().get("revisionDraft");
    if (draft instanceof Map<?, ?> revision
        && revision.get("attachments") instanceof List<?> values)
      for (Object value : values)
        if (value instanceof Map<?, ?> raw) {
          var item = new LinkedHashMap<String, Object>();
          raw.forEach(
              (key, entry) -> {
                if (key instanceof String name) item.put(name, entry);
              });
          result.add(item);
        }
    return result;
  }

  private byte[] read(ContextAttachment attachment) {
    try {
      Path root = repository.directory().toRealPath(), file = Path.of(attachment.path());
      requireInside(root, file);
      try (SeekableByteChannel channel =
          Files.newByteChannel(file, Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS))) {
        long size = channel.size();
        if (size > MAX_BYTES)
          throw failure(413, "This attachment exceeds the 20 MB context limit.");
        ByteBuffer buffer = ByteBuffer.allocate((int) size + 1);
        while (buffer.hasRemaining() && channel.read(buffer) != -1) {}
        requireInside(root, file);
        if (buffer.position() != size || channel.size() != size)
          throw failure(409, "This attachment changed while it was being read. Open it again.");
        return Arrays.copyOf(buffer.array(), (int) size);
      }
    } catch (java.nio.file.NoSuchFileException missing) {
      throw failure(404, "The original attachment is no longer available; attach it again.");
    } catch (IOException error) {
      throw failure(403, "This attachment is not readable. Check its permissions and try again.");
    }
  }

  private static void requireInside(Path root, Path file) throws IOException {
    Path current = file.toRealPath();
    if (!current.equals(file)
        || current.equals(root)
        || !current.startsWith(root)
        || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)
        || !Files.isReadable(file))
      throw failure(403, "This attachment is outside safe Argus context storage.");
  }

  private static Format format(ContextAttachment attachment, byte[] bytes) {
    String extension = extension(attachment);
    // Do not trust browser-provided MIME metadata. Inline media needs both a
    // supported format and matching magic bytes; active formats are only text.
    if (!Set.of("html", "htm", "svg", "xhtml", "xml").contains(extension)) {
      if (starts(bytes, 0, 0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10))
        return new Format("image", "image/png");
      if (starts(bytes, 0, 0xff, 0xd8, 0xff)) return new Format("image", "image/jpeg");
      if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a"))
        return new Format("image", "image/gif");
      if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP"))
        return new Format("image", "image/webp");
      if (extension.equals("pdf")) {
        for (int index = 0; index < Math.min(1024, bytes.length); index++)
          if (ascii(bytes, index, "%PDF-")) return new Format("pdf", "application/pdf");
      }
      if (Set.of("doc", "docx").contains(extension))
        return new Format("docx", extension.equals("doc") ? "application/msword" : DOCX);
      if (extension.equals("wav") && ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE"))
        return new Format("audio", "audio/wav");
      if (extension.equals("flac") && ascii(bytes, 0, "fLaC"))
        return new Format("audio", "audio/flac");
      if (Set.of("ogg", "oga", "ogv", "opus").contains(extension) && ascii(bytes, 0, "OggS"))
        return new Format(
            extension.equals("ogv") ? "video" : "audio",
            extension.equals("ogv") ? "video/ogg" : "audio/ogg");
      if (extension.equals("mp3")
          && (ascii(bytes, 0, "ID3")
              || bytes.length > 1 && (bytes[0] & 255) == 255 && (bytes[1] & 224) == 224))
        return new Format("audio", "audio/mpeg");
      if (Set.of("mp4", "m4a", "m4v").contains(extension) && ascii(bytes, 4, "ftyp"))
        return new Format(
            extension.equals("m4a") ? "audio" : "video",
            extension.equals("m4a") ? "audio/mp4" : "video/mp4");
      if (Set.of("webm", "weba").contains(extension) && starts(bytes, 0, 0x1a, 0x45, 0xdf, 0xa3))
        return new Format(
            extension.equals("weba") ? "audio" : "video",
            extension.equals("weba") ? "audio/webm" : "video/webm");
    }
    if (bytes.length <= MAX_TEXT_BYTES && text(bytes) != null)
      return new Format("text", "text/plain; charset=utf-8");
    return new Format("download", "application/octet-stream");
  }

  private static String text(byte[] bytes) {
    for (byte value : bytes) if (value == 0) return null;
    try {
      return StandardCharsets.UTF_8
          .newDecoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .decode(ByteBuffer.wrap(bytes))
          .toString();
    } catch (CharacterCodingException binary) {
      return null;
    }
  }

  private static String displayText(ContextAttachment attachment, String content) {
    String header;
    if ("browser".equals(attachment.kind()))
      header =
          "# Browser context: "
              + attachment.title()
              + "\n\nSource: "
              + (attachment.url() == null || attachment.url().isBlank()
                  ? "Unknown URL"
                  : attachment.url())
              + "\nCaptured: "
              + attachment.createdAt()
              + "\n\n---\n\n";
    else if ("paste".equals(attachment.kind()))
      header =
          "# " + attachment.title() + "\n\nCaptured: " + attachment.createdAt() + "\n\n---\n\n";
    else return content;
    return content.startsWith(header) && content.endsWith("\n")
        ? content.substring(header.length(), content.length() - 1)
        : content;
  }

  private static String filename(ContextAttachment attachment) {
    String name = attachment.title() == null ? "Attachment" : attachment.title().strip();
    name = name.replaceAll("[\\x00-\\x1f\\x7f/\\\\]", "_");
    if (name.isBlank() || name.equals(".") || name.equals("..")) name = "Attachment";
    if (("paste".equals(attachment.kind()) || "browser".equals(attachment.kind()))
        && !name.endsWith(".md")) name += ".md";
    return name;
  }

  private static String extension(ContextAttachment attachment) {
    String name = filename(attachment);
    int dot = name.lastIndexOf('.');
    if (dot < 0 && attachment.path() != null)
      name = Path.of(attachment.path()).getFileName().toString();
    dot = name.lastIndexOf('.');
    return dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
  }

  private static boolean ascii(byte[] bytes, int offset, String magic) {
    if (offset < 0 || offset + magic.length() > bytes.length) return false;
    for (int index = 0; index < magic.length(); index++)
      if (bytes[offset + index] != magic.charAt(index)) return false;
    return true;
  }

  private static boolean starts(byte[] bytes, int offset, int... magic) {
    if (offset < 0 || offset + magic.length > bytes.length) return false;
    for (int index = 0; index < magic.length; index++)
      if ((bytes[offset + index] & 255) != magic[index]) return false;
    return true;
  }

  private static String disposition(String name, boolean inline) {
    String fallback = name.replaceAll("[^\\x20-\\x7e]|[\"\\\\;]", "_");
    String encoded =
        URLEncoder.encode(name, StandardCharsets.UTF_8).replace("+", "%20").replace("*", "%2A");
    return (inline ? "inline" : "attachment")
        + "; filename=\""
        + fallback
        + "\"; filename*=UTF-8''"
        + encoded;
  }

  private static ResponseStatusException failure(int status, String message) {
    return new ResponseStatusException(HttpStatus.valueOf(status), message);
  }
}
