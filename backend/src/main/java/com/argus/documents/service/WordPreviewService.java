package com.argus.documents.service;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;
import javax.xml.XMLConstants;
import javax.xml.parsers.SAXParserFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import org.xml.sax.Attributes;
import org.xml.sax.SAXException;
import org.xml.sax.helpers.DefaultHandler;

/** Bounded in-memory OOXML verification; no ZIP extraction or remote resource access. */
@Service
public class WordPreviewService {
  public static final int MAX_BYTES = 50 * 1024 * 1024;
  private final Semaphore admission = new Semaphore(2);
  private final Semaphore converters = new Semaphore(2);
  private final Set<Process> converterProcesses =
      java.util.concurrent.ConcurrentHashMap.newKeySet();
  private final ExecutorService pipes =
      Executors.newCachedThreadPool(
          r -> {
            Thread t = new Thread(r, "argus-doc-converter");
            t.setDaemon(true);
            return t;
          });
  private static final byte[] OLE = {
    (byte) 0xd0, (byte) 0xcf, 0x11, (byte) 0xe0, (byte) 0xa1, (byte) 0xb1, 0x1a, (byte) 0xe1
  };

  public byte[] preview(byte[] input, boolean legacy) {
    if (!admission.tryAcquire())
      throw failure(413, "Document previews are busy. Try again in a moment.");
    try {
      if (input.length > MAX_BYTES)
        throw failure(413, "This Word document exceeds the 50 MB preview limit.");
      byte[] bytes = legacy ? convertLegacy(input) : input;
      return validatedPreview(bytes, System.nanoTime() + Duration.ofSeconds(8).toNanos(), true);
    } finally {
      admission.release();
    }
  }

  protected byte[] convertLegacy(byte[] bytes) {
    if (bytes.length < OLE.length
        || !java.util.Arrays.equals(OLE, java.util.Arrays.copyOf(bytes, OLE.length)))
      throw failure(415, "This file is not a supported legacy Word DOC document.");
    if (!System.getProperty("os.name", "").toLowerCase().contains("mac"))
      throw failure(415, "Formatted legacy DOC previews require the macOS document converter.");
    if (!converters.tryAcquire())
      throw failure(413, "Document converters are busy. Try again in a moment.");
    Process process = null;
    try {
      process =
          new ProcessBuilder(
                  List.of(
                      "/usr/bin/textutil",
                      "-convert",
                      "docx",
                      "-format",
                      "doc",
                      "-stdin",
                      "-stdout",
                      "-noload",
                      "-nostore"))
              .start();
      converterProcesses.add(process);
      Process child = process;
      var output =
          CompletableFuture.supplyAsync(() -> bounded(child.getInputStream(), MAX_BYTES), pipes);
      var errors =
          CompletableFuture.supplyAsync(() -> bounded(child.getErrorStream(), 64 * 1024), pipes);
      var input =
          CompletableFuture.runAsync(
              () -> {
                try (var stream = child.getOutputStream()) {
                  stream.write(bytes);
                } catch (Exception e) {
                  throw new IllegalStateException(e);
                }
              },
              pipes);
      if (!child.waitFor(10, TimeUnit.SECONDS))
        throw failure(413, "This DOC exceeded the preview time limit.");
      input.get(1, TimeUnit.SECONDS);
      errors.get(1, TimeUnit.SECONDS);
      byte[] result = output.get(1, TimeUnit.SECONDS);
      if (child.exitValue() != 0 || result.length == 0)
        throw failure(415, "This DOC is invalid, encrypted, or cannot be converted safely.");
      return result;
    } catch (ResponseStatusException e) {
      throw e;
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw failure(415, "The DOC preview was interrupted.");
    } catch (Exception e) {
      throw failure(415, "The macOS DOC converter could not preview this document.");
    } finally {
      if (process != null) {
        if (process.isAlive()) process.destroyForcibly();
        try {
          process.waitFor(1, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
        }
        try {
          process.getInputStream().close();
          process.getErrorStream().close();
          process.getOutputStream().close();
        } catch (Exception ignored) {
        }
        Process owned = process;
        if (owned.isAlive())
          owned
              .onExit()
              .whenComplete(
                  (ignored, error) -> {
                    converterProcesses.remove(owned);
                    converters.release();
                  });
        else {
          converterProcesses.remove(owned);
          converters.release();
        }
      } else converters.release();
    }
  }

  @jakarta.annotation.PreDestroy
  public void close() {
    for (Process process : converterProcesses) process.destroyForcibly();
    pipes.shutdownNow();
  }

  private static byte[] bounded(InputStream input, int maximum) {
    try (input;
        var output = new ByteArrayOutputStream()) {
      byte[] chunk = new byte[8192];
      int count;
      while ((count = input.read(chunk)) >= 0) {
        if (output.size() + count > maximum)
          throw failure(413, "This Word document exceeds preview limits.");
        output.write(chunk, 0, count);
      }
      return output.toByteArray();
    } catch (ResponseStatusException e) {
      throw e;
    } catch (Exception e) {
      throw new IllegalStateException("Could not read document bytes", e);
    }
  }

  private record Entry(
      long size, long compressed, long crc, int method, int flags, long localOffset) {}

  public void validate(byte[] bytes, Duration timeout) {
    validatedPreview(bytes, System.nanoTime() + timeout.toNanos(), false);
  }

  private byte[] validatedPreview(byte[] bytes, long deadline, boolean normalize) {
    try {
      deadline(deadline);
      if (bytes.length > MAX_BYTES)
        throw failure(413, "This DOCX exceeds the 50 MB preview limit.");
      Map<String, Entry> directory = directory(bytes);
      Set<String> seen = new HashSet<>();
      Map<String, byte[]> replacements = new HashMap<>();
      long expanded = 0, normalizedExpanded = 0;
      try (var archive =
          new ZipInputStream(new ByteArrayInputStream(bytes), StandardCharsets.UTF_8)) {
        ZipEntry entry;
        while ((entry = archive.getNextEntry()) != null) {
          deadline(deadline);
          Entry declared = directory.get(entry.getName());
          if (declared == null
              || !seen.add(entry.getName())
              || declared.method != entry.getMethod())
            throw failure(415, "This DOCX contains ambiguous archive entries.");
          var content = new ByteArrayOutputStream();
          byte[] chunk = new byte[8192];
          int length;
          while ((length = archive.read(chunk)) != -1) {
            deadline(deadline);
            expanded += length;
            if (expanded > 32L * 1024 * 1024 || content.size() + length > declared.size)
              throw failure(413, "This DOCX expands beyond its declared preview limits.");
            content.write(chunk, 0, length);
          }
          if (content.size() != declared.size
              || entry.getCompressedSize() != declared.compressed
              || entry.getCrc() != declared.crc)
            throw failure(415, "A DOCX archive part has an invalid size or checksum.");
          byte[] normalized =
              entry.getName().matches("(?i).*\\.(xml|rels)$")
                  ? validateXml(content.toByteArray(), deadline)
                  : null;
          normalizedExpanded += normalized == null ? content.size() : normalized.length;
          if (normalizedExpanded > 32L * 1024 * 1024)
            throw failure(413, "This DOCX expands beyond safe preview limits.");
          if (normalize && normalized != null) replacements.put(entry.getName(), normalized);
        }
      }
      if (!seen.equals(directory.keySet()))
        throw failure(415, "This DOCX has inconsistent archive entries.");
      if (replacements.isEmpty()) return bytes;
      byte[] result = normalizedArchive(bytes, directory, replacements, deadline);
      // The renderer only receives an archive that passes the same guards after
      // normalization. This deadline is shared, not restarted for the second pass.
      validatedPreview(result, deadline, false);
      return result;
    } catch (ResponseStatusException e) {
      throw e;
    } catch (Exception e) {
      throw failure(415, "This DOCX cannot be safely previewed.");
    }
  }

  private static byte[] normalizedArchive(
      byte[] bytes, Map<String, Entry> directory, Map<String, byte[]> replacements, long deadline)
      throws Exception {
    var output =
        new ByteArrayOutputStream() {
          @Override
          public synchronized void write(byte[] bytes, int offset, int length) {
            if ((long) count + length > MAX_BYTES)
              throw failure(413, "The normalized DOCX exceeds the 50 MB preview limit.");
            super.write(bytes, offset, length);
          }

          @Override
          public synchronized void write(int value) {
            if (count >= MAX_BYTES)
              throw failure(413, "The normalized DOCX exceeds the 50 MB preview limit.");
            super.write(value);
          }
        };
    try (var input = new ZipInputStream(new ByteArrayInputStream(bytes), StandardCharsets.UTF_8);
        var archive = new ZipOutputStream(output, StandardCharsets.UTF_8)) {
      ZipEntry entry;
      byte[] chunk = new byte[8192];
      while ((entry = input.getNextEntry()) != null) {
        deadline(deadline);
        Entry declared = directory.get(entry.getName());
        byte[] replacement = replacements.get(entry.getName());
        var previewEntry = new ZipEntry(entry.getName());
        // Avoid creating a new compression-ratio violation when valid stored
        // parts happen to contain highly repetitive data.
        previewEntry.setMethod(ZipEntry.STORED);
        long size = replacement == null ? declared.size : replacement.length;
        previewEntry.setSize(size);
        previewEntry.setCompressedSize(size);
        CRC32 crc = new CRC32();
        if (replacement != null) crc.update(replacement);
        previewEntry.setCrc(replacement == null ? declared.crc : crc.getValue());
        archive.putNextEntry(previewEntry);
        int count;
        while ((count = input.read(chunk)) != -1) {
          deadline(deadline);
          if (replacement == null) archive.write(chunk, 0, count);
        }
        if (replacement != null) archive.write(replacement);
        archive.closeEntry();
      }
    }
    deadline(deadline);
    return output.toByteArray();
  }

  private static Map<String, Entry> directory(byte[] bytes) throws Exception {
    ByteBuffer b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
    int end = -1;
    for (int offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--)
      if (b.getInt(offset) == 0x06054b50 && offset + 22 + u16(b, offset + 20) == bytes.length) {
        end = offset;
        break;
      }
    if (end < 0 || u16(b, end + 4) != 0 || u16(b, end + 6) != 0)
      throw failure(415, "This file is not a supported DOCX archive.");
    int entries = u16(b, end + 10);
    long offset = u32(b, end + 16), directorySize = u32(b, end + 12);
    long directoryStart = offset;
    if (entries > 512) throw failure(413, "This DOCX has too many archive entries for a preview.");
    if (entries != u16(b, end + 8) || offset + directorySize != end)
      throw failure(415, "This DOCX has an invalid archive directory.");
    Map<String, Entry> result = new HashMap<>();
    int xmlCount = 0;
    long expanded = 0;
    for (int i = 0; i < entries; i++) {
      if (offset < 0 || offset + 46 > end || b.getInt((int) offset) != 0x02014b50)
        throw failure(415, "This DOCX has an invalid archive directory.");
      int p = (int) offset,
          nameLength = u16(b, p + 28),
          extraLength = u16(b, p + 30),
          commentLength = u16(b, p + 32),
          flags = u16(b, p + 8),
          method = u16(b, p + 10);
      if (offset + 46 + nameLength + extraLength + commentLength > end
          || (flags & 1) != 0
          || (method != 0 && method != 8)
          || u16(b, p + 34) != 0)
        throw failure(415, "Encrypted or unsupported DOCX archives cannot be previewed.");
      String name =
          StandardCharsets.UTF_8
              .newDecoder()
              .onMalformedInput(CodingErrorAction.REPORT)
              .decode(ByteBuffer.wrap(bytes, p + 46, nameLength))
              .toString();
      if (name.isEmpty()
          || name.startsWith("/")
          || name.contains("\\")
          || name.contains("\0")
          || name.matches("^[A-Za-z]:.*")
          || java.util.Arrays.stream(name.split("/", -1))
              .anyMatch(part -> part.equals(".") || part.equals(".."))
          || result.containsKey(name))
        throw failure(415, "This DOCX contains ambiguous archive paths.");
      validateCentralExtra(bytes, p + 46 + nameLength, extraLength, flags, name);
      boolean xml = name.matches("(?i).*\\.(xml|rels)$");
      long size = u32(b, p + 24), compressed = u32(b, p + 20);
      if (xml && ++xmlCount > 128)
        throw failure(413, "This DOCX contains too many XML parts for a preview.");
      if (size > (xml ? 8L : 16L) * 1024 * 1024
          || (expanded += size) > 32L * 1024 * 1024
          || size > 1024 * 1024 && size > Math.max(1, compressed) * 200L)
        throw failure(413, "This DOCX expands beyond safe preview limits.");
      result.put(name, new Entry(size, compressed, u32(b, p + 16), method, flags, u32(b, p + 42)));
      offset += 46L + nameLength + extraLength + commentLength;
    }
    if (offset != end
        || !result.containsKey("word/document.xml")
        || !result.containsKey("[Content_Types].xml"))
      throw failure(415, "This file is not a Word DOCX document.");
    validateLocalHeaders(bytes, result, directoryStart);
    return result;
  }

  private static void validateCentralExtra(
      byte[] bytes, int start, int length, int flags, String name) throws Exception {
    ByteBuffer b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
    int end = start + length, unicodeStart = -1, unicodeLength = 0;
    for (int position = start; position < end; ) {
      if (position + 4 > end) throw failure(415, "This DOCX has malformed archive extra fields.");
      int id = u16(b, position), size = u16(b, position + 2);
      int value = position + 4;
      if (value + size > end) throw failure(415, "This DOCX has malformed archive extra fields.");
      if (id == 0x7075) {
        // JSZip retains the last field with this ID, and ignores this field
        // entirely when the UTF-8 filename flag is already set.
        unicodeStart = value;
        unicodeLength = size;
      }
      position = value + size;
    }
    if ((flags & 0x0800) != 0 || unicodeStart < 0) return;
    if (unicodeLength < 1) throw failure(415, "This DOCX has a malformed Unicode archive path.");
    if (bytes[unicodeStart] != 1) return;
    if (unicodeLength < 5) throw failure(415, "This DOCX has a malformed Unicode archive path.");
    CRC32 crc = new CRC32();
    crc.update(name.getBytes(StandardCharsets.UTF_8));
    if (u32(b, unicodeStart + 1) != crc.getValue()) return;
    String alias =
        StandardCharsets.UTF_8
            .newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes, unicodeStart + 5, unicodeLength - 5))
            .toString();
    if (!alias.equals(name))
      throw failure(415, "This DOCX contains inconsistent Unicode archive paths.");
  }

  private static void validateLocalHeaders(
      byte[] bytes, Map<String, Entry> directory, long directoryStart) {
    ByteBuffer b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
    long expectedOffset = 0;
    var ordered =
        directory.entrySet().stream()
            .sorted(java.util.Comparator.comparingLong(entry -> entry.getValue().localOffset))
            .toList();
    for (var part : ordered) {
      Entry entry = part.getValue();
      long offset = entry.localOffset;
      if (offset != expectedOffset
          || offset + 30 > directoryStart
          || b.getInt((int) offset) != 0x04034b50)
        throw failure(415, "This DOCX has inconsistent local archive offsets.");
      int p = (int) offset, nameLength = u16(b, p + 26), extraLength = u16(b, p + 28);
      long dataStart = offset + 30L + nameLength + extraLength;
      long dataEnd = dataStart + entry.compressed;
      byte[] name = part.getKey().getBytes(StandardCharsets.UTF_8);
      if (dataEnd > directoryStart
          || nameLength != name.length
          || !java.util.Arrays.equals(bytes, p + 30, p + 30 + nameLength, name, 0, name.length)
          || u16(b, p + 6) != entry.flags
          || u16(b, p + 8) != entry.method)
        throw failure(415, "This DOCX has inconsistent local archive headers.");
      boolean descriptor = (entry.flags & 8) != 0;
      long crc = u32(b, p + 14), compressed = u32(b, p + 18), size = u32(b, p + 22);
      // ZIP64 size placeholders are checked by ZipInputStream against the
      // bounded central sizes. Data descriptors may legitimately leave zeros.
      if (crc != entry.crc && !(descriptor && crc == 0)
          || compressed != entry.compressed
              && compressed != 0xffffffffL
              && !(descriptor && compressed == 0)
          || size != entry.size && size != 0xffffffffL && !(descriptor && size == 0))
        throw failure(415, "This DOCX has inconsistent local archive sizes.");
      expectedOffset = dataEnd;
      if (descriptor) {
        if (dataEnd + 12 > directoryStart)
          throw failure(415, "This DOCX has an invalid archive data descriptor.");
        int start = (int) dataEnd;
        boolean signature = b.getInt(start) == 0x08074b50;
        if (signature) start += 4;
        if ((long) start + 12 > directoryStart
            || u32(b, start) != entry.crc
            || u32(b, start + 4) != entry.compressed
            || u32(b, start + 8) != entry.size)
          throw failure(415, "This DOCX has an invalid archive data descriptor.");
        expectedOffset = (long) start + 12;
      }
    }
  }

  private static int u16(ByteBuffer bytes, int offset) {
    return Short.toUnsignedInt(bytes.getShort(offset));
  }

  private static long u32(ByteBuffer bytes, int offset) {
    return Integer.toUnsignedLong(bytes.getInt(offset));
  }

  private static void deadline(long deadline) {
    if (System.nanoTime() > deadline || Thread.currentThread().isInterrupted())
      throw failure(413, "This DOCX exceeded the preview time limit.");
  }

  private static byte[] validateXml(byte[] bytes, long deadline) throws Exception {
    Charset encoding = StandardCharsets.UTF_8;
    int bom = 0;
    if (bytes.length >= 2 && bytes[0] == (byte) 0xff && bytes[1] == (byte) 0xfe) {
      encoding = StandardCharsets.UTF_16LE;
      bom = 2;
    } else if (bytes.length >= 2 && bytes[0] == (byte) 0xfe && bytes[1] == (byte) 0xff) {
      encoding = StandardCharsets.UTF_16BE;
      bom = 2;
    } else if (bytes.length >= 4
        && bytes[0] == 0
        && bytes[1] == '<'
        && bytes[2] == 0
        && bytes[3] == '?') {
      encoding = StandardCharsets.UTF_16BE;
    } else if (bytes.length >= 4
        && bytes[0] == '<'
        && bytes[1] == 0
        && bytes[2] == '?'
        && bytes[3] == 0) {
      encoding = StandardCharsets.UTF_16LE;
    }
    deadline(deadline);
    String xml =
        encoding
            .newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes, bom, bytes.length - bom))
            .toString();
    if (xml.indexOf('\0') >= 0
        || java.util.regex.Pattern.compile(
                "<!\\s*(?:DOCTYPE|ENTITY)\\b", java.util.regex.Pattern.CASE_INSENSITIVE)
            .matcher(xml)
            .find())
      throw failure(415, "This DOCX contains unsupported XML declarations or encoding.");
    SAXParserFactory factory = SAXParserFactory.newInstance();
    factory.setNamespaceAware(true);
    factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
    factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
    factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
    factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
    var parser = factory.newSAXParser();
    parser.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD, "");
    parser.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
    parser.parse(
        new ByteArrayInputStream(bytes),
        new DefaultHandler() {
          @Override
          public void startElement(String uri, String local, String name, Attributes attrs)
              throws SAXException {
            deadline(deadline);
          }

          @Override
          public void characters(char[] ch, int start, int length) throws SAXException {
            deadline(deadline);
          }
        });
    deadline(deadline);
    if (encoding.equals(StandardCharsets.UTF_8)) return null;
    // JSZip/docx-preview reads XML as UTF-8 strings. Change encoding only in
    // validated preview parts, preserving the original package for downloads.
    String normalized =
        xml.replaceFirst(
            "\\A(<\\?xml\\s+[^?]*?\\bencoding\\s*=\\s*)([\"'])[^\"']+\\2", "$1$2UTF-8$2");
    byte[] utf8 = normalized.getBytes(StandardCharsets.UTF_8);
    if (utf8.length > 8L * 1024 * 1024)
      throw failure(413, "This DOCX XML part exceeds the 8 MB normalized preview limit.");
    deadline(deadline);
    return utf8;
  }

  static ResponseStatusException failure(int status, String message) {
    return new ResponseStatusException(
        HttpStatus.valueOf(status),
        message + " Download the original to open it in a document editor.");
  }
}
