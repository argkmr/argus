package com.argus.context.service;

import com.argus.context.domain.ContextAttachment;
import com.argus.context.dto.SaveContextRequest;
import com.argus.context.repository.ContextRepository;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Instant;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;

@Service
public class ContextService {
  private static final int MAX_CONTEXT_SIZE = 20_000_000;
  private final ContextRepository contexts;

  public ContextService(ContextRepository contexts) {
    this.contexts = contexts;
  }

  public SaveContextRequest validatedRequest(SaveContextRequest request) {
    return validate(request).request();
  }

  private ValidatedContext validate(SaveContextRequest request) {
    String kind = request.kind() == null ? "paste" : request.kind();
    boolean image = "image".equals(kind);
    boolean binary = image || "file".equals(kind);
    byte[] binaryContent = binary ? decodeBinary(request, image) : null;
    String content = request.content() == null ? "" : request.content();
    if (!binary && content.isBlank()) throw new IllegalArgumentException("Context is empty");
    int size = binary ? binaryContent.length : content.getBytes(StandardCharsets.UTF_8).length;
    if (size > MAX_CONTEXT_SIZE)
      throw new IllegalArgumentException("Attachment is larger than 20 MB. Choose a smaller file.");
    String title =
        request.title() == null || request.title().isBlank()
            ? (image ? "Pasted image" : "Pasted context")
            : request.title().trim();
    return new ValidatedContext(
        new SaveContextRequest(
            kind,
            title,
            request.url() == null ? "" : request.url(),
            content,
            request.contentBase64(),
            request.mimeType(),
            request.repositoryId() == null ? "" : request.repositoryId()),
        binaryContent,
        size);
  }

  private record ValidatedContext(SaveContextRequest request, byte[] binaryContent, int size) {}

  public synchronized ContextAttachment save(SaveContextRequest input) {
    ValidatedContext validated = validate(input);
    SaveContextRequest request = validated.request();
    String kind = request.kind();
    boolean image = "image".equals(kind);
    boolean binary = image || "file".equals(kind);
    byte[] binaryContent = validated.binaryContent();
    String content = request.content();
    String title = request.title();
    int size = validated.size();
    String id = UUID.randomUUID().toString();
    String safe = title.replaceAll("[^A-Za-z0-9._-]+", "-").replaceAll("^-+|-+$", "");
    if (safe.isBlank()) safe = "context";
    safe = safe.substring(0, Math.min(80, safe.length()));
    Path path =
        contexts
            .directory()
            .resolve(
                System.currentTimeMillis()
                    + "-"
                    + safe
                    + "-"
                    + id.substring(0, 8)
                    + extension(kind, request.mimeType(), title));
    String now = Instant.now().toString();
    String header =
        "browser".equals(kind)
            ? "# Browser context: "
                + title
                + "\n\nSource: "
                + (request.url() == null || request.url().isBlank() ? "Unknown URL" : request.url())
                + "\nCaptured: "
                + now
                + "\n\n---\n\n"
            : "# " + title + "\n\nCaptured: " + now + "\n\n---\n\n";
    try {
      if (Files.isSymbolicLink(path.getParent()))
        throw new IllegalStateException("Context storage must not be a symbolic link");
      Files.createDirectories(path.getParent());
      try {
        Files.setPosixFilePermissions(
            path.getParent(),
            Set.of(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE,
                PosixFilePermission.OWNER_EXECUTE));
      } catch (UnsupportedOperationException ignored) {
      }
      if (binary) Files.write(path, binaryContent);
      else Files.writeString(path, header + content + "\n");
      try {
        Files.setPosixFilePermissions(
            path, Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
      } catch (UnsupportedOperationException ignored) {
      }
    } catch (IOException error) {
      throw new IllegalStateException("Could not save context", error);
    }
    ContextAttachment item =
        new ContextAttachment(
            id,
            kind,
            title,
            request.url() == null ? "" : request.url(),
            path.toString(),
            size,
            binary
                ? request.mimeType() == null || request.mimeType().isBlank()
                    ? "application/octet-stream"
                    : request.mimeType()
                : "text/markdown",
            request.repositoryId() == null ? "" : request.repositoryId(),
            now);
    try {
      contexts.add(item);
    } catch (RuntimeException error) {
      try {
        Files.deleteIfExists(path);
      } catch (IOException cleanup) {
        error.addSuppressed(cleanup);
      }
      throw error;
    }
    return item;
  }

  private byte[] decodeBinary(SaveContextRequest request, boolean image) {
    Map<String, String> supported =
        Map.of(
            "image/png", ".png", "image/jpeg", ".jpg", "image/gif", ".gif", "image/webp", ".webp");
    if (image && (request.mimeType() == null || !supported.containsKey(request.mimeType())))
      throw new IllegalArgumentException("Paste a PNG, JPEG, GIF, or WebP image.");
    try {
      byte[] bytes =
          Base64.getDecoder()
              .decode(request.contentBase64() == null ? "" : request.contentBase64());
      if (bytes.length == 0)
        throw new IllegalArgumentException(image ? "Image is empty" : "File is empty");
      return bytes;
    } catch (IllegalArgumentException error) {
      if ("Image is empty".equals(error.getMessage()) || "File is empty".equals(error.getMessage()))
        throw error;
      throw new IllegalArgumentException(
          image ? "Image clipboard data is invalid" : "File data is invalid", error);
    }
  }

  private String extension(String kind, String mimeType, String title) {
    if ("browser".equals(kind)) return ".html.md";
    if ("file".equals(kind)) {
      String name = title == null ? "" : title.strip();
      int dot = name.lastIndexOf('.');
      if (dot > 0 && dot < name.length() - 1) {
        String suffix = name.substring(dot).toLowerCase();
        if (suffix.matches("\\.[a-z0-9]{1,12}")) return suffix;
      }
      return ".bin";
    }
    if (!"image".equals(kind)) return ".md";
    return Map.of(
            "image/png", ".png", "image/jpeg", ".jpg", "image/gif", ".gif", "image/webp", ".webp")
        .get(mimeType);
  }

  public ContextAttachment get(String id) {
    return validateSaved(contexts.require(id));
  }

  public ContextAttachment getForRevision(
      String id, boolean pending, List<ContextAttachment> saved) {
    try {
      return get(id);
    } catch (com.argus.common.error.NotFoundException error) {
      if (!pending || saved == null) throw error;
      return saved.stream()
          .filter(item -> item.id().equals(id))
          .findFirst()
          .map(this::validateSaved)
          .orElseThrow(() -> error);
    }
  }

  // Package access lets read-only previews validate an already resolved saved
  // identity after relocating an old backup prefix inside current storage.
  ContextAttachment validateSaved(ContextAttachment item) {
    try {
      Path root = contexts.directory().toRealPath(), file = Path.of(item.path()).toRealPath();
      if (file.equals(root) || !file.startsWith(root))
        throw new IllegalArgumentException("The saved attachment is outside Argus context storage");
      if (!Files.isRegularFile(file) || !Files.isReadable(file))
        throw new IllegalArgumentException("The saved attachment is not a readable regular file");
      if (Files.size(file) > MAX_CONTEXT_SIZE + 65_536)
        throw new IllegalArgumentException("The saved attachment exceeds the context size limit");
      return new ContextAttachment(
          item.id(),
          item.kind(),
          item.title(),
          item.url(),
          file.toString(),
          item.size(),
          item.mimeType(),
          item.repositoryId(),
          item.createdAt());
    } catch (IOException e) {
      throw new com.argus.common.error.NotFoundException(
          "The original attachment is no longer available; attach it again");
    }
  }

  public synchronized Map<String, Object> purgeRepositories(
      List<String> repositoryIds, List<String> attachmentIds) {
    Set<String> repositories = Set.copyOf(repositoryIds), ids = Set.copyOf(attachmentIds);
    var items = contexts.list();
    var selected =
        items.stream()
            .filter(item -> repositories.contains(item.repositoryId()) || ids.contains(item.id()))
            .toList();
    // Validate every persisted path before deleting any attachment.
    var validated = selected.stream().map(this::validatedDeletionPath).toList();
    try {
      for (var file : validated) Files.deleteIfExists(file);
    } catch (IOException e) {
      throw new IllegalStateException("Could not remove selected context attachments", e);
    }
    contexts.replace(
        items.stream()
            .filter(item -> selected.stream().noneMatch(removed -> removed.id().equals(item.id())))
            .toList());
    return Map.of("attachmentsDeleted", selected.size());
  }

  private Path validatedDeletionPath(ContextAttachment item) {
    try {
      Path root = contexts.directory().toRealPath(),
          requested = Path.of(item.path()).toAbsolutePath().normalize();
      Path parent = requested.getParent();
      if (parent == null) throw new IllegalArgumentException("Invalid saved attachment path");
      Path file = parent.toRealPath().resolve(requested.getFileName());
      if (!file.startsWith(root) || file.equals(root) || Files.isSymbolicLink(file))
        throw new IllegalArgumentException(
            "The saved attachment is outside safe Argus context storage");
      if (Files.exists(file, java.nio.file.LinkOption.NOFOLLOW_LINKS)
          && !Files.isRegularFile(file, java.nio.file.LinkOption.NOFOLLOW_LINKS))
        throw new IllegalArgumentException("The saved attachment is not a regular file");
      return file;
    } catch (IOException error) {
      throw new IllegalArgumentException(
          "The saved attachment path cannot be safely verified", error);
    }
  }

  public ContextAttachment latestBrowser() {
    return contexts.list().stream()
        .filter(item -> item.kind().equals("browser"))
        .max(Comparator.comparing(ContextAttachment::createdAt))
        .orElse(null);
  }
}
