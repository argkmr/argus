package com.argus.documents.service;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

import com.argus.workspace.domain.Repository;
import com.argus.workspace.dto.WorkspaceResponse;
import com.argus.workspace.service.WorkspaceService;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.web.server.ResponseStatusException;

class WordPreviewServiceTest {
  @TempDir Path directory;

  @Test
  void utf16BothEndiansWithBomAndExplicitEndianDeclarationsBecomeUtf8OnlyForPreview()
      throws Exception {
    for (Charset encoding : List.of(StandardCharsets.UTF_16LE, StandardCharsets.UTF_16BE)) {
      for (boolean bom : List.of(false, true)) {
        String declaration = bom ? "UTF-16" : encoding.name();
        String body = "<document><p>Résumé हिन्दी 文 😀</p></document>";
        byte[] document = xml(body, declaration, encoding, bom);
        String relationships =
            "<Relationships><Relationship Id=\"r1\" Target=\"word/document.xml\"/></Relationships>";
        byte[] media = {0, 1, (byte) 255, 4, 8};
        byte[] styles = "<styles><b/></styles>".getBytes(StandardCharsets.UTF_8);
        var parts = new LinkedHashMap<String, byte[]>();
        parts.put("[Content_Types].xml", xml("<Types/>", declaration, encoding, bom));
        parts.put("word/document.xml", document);
        parts.put("_rels/.rels", xml(relationships, declaration, encoding, bom));
        parts.put("word/styles.xml", styles);
        parts.put("word/media/image.png", media);
        byte[] original = zip(parts), copy = original.clone();
        byte[] preview = new WordPreviewService().preview(original, false);
        var normalized = unzip(preview);
        assertThat(preview).isNotEqualTo(original);
        assertThat(original).isEqualTo(copy);
        assertThat(new String(normalized.get("word/document.xml"), StandardCharsets.UTF_8))
            .isEqualTo("<?xml version=\"1.0\" encoding=\"UTF-8\"?>" + body);
        assertThat(new String(normalized.get("_rels/.rels"), StandardCharsets.UTF_8))
            .isEqualTo("<?xml version=\"1.0\" encoding=\"UTF-8\"?>" + relationships);
        assertThat(normalized.get("word/styles.xml")).isEqualTo(styles);
        assertThat(normalized.get("word/media/image.png")).isEqualTo(media);
        new WordPreviewService().validate(preview, Duration.ofSeconds(2));
      }
    }
  }

  @Test
  void utf8PackageAndUtf8BomPartsRemainByteExact() throws Exception {
    byte[] original =
        zip(
            Map.of(
                "[Content_Types].xml",
                "<Types/>".getBytes(StandardCharsets.UTF_8),
                "word/document.xml",
                "\ufeff<?xml version=\"1.0\" encoding=\"UTF-8\"?><document>Text</document>"
                    .getBytes(StandardCharsets.UTF_8)));
    assertThat(new WordPreviewService().preview(original, false)).isSameAs(original);
  }

  @Test
  void sourceDownloadsAndLegacyOriginalsRemainExactWhilePreviewIsNormalized() throws Exception {
    byte[] docx =
        packageWith(
            xml("<document>Formatted 文</document>", "UTF-16", StandardCharsets.UTF_16LE, true));
    byte[] legacy = {
      (byte) 0xd0, (byte) 0xcf, 0x11, (byte) 0xe0, (byte) 0xa1, (byte) 0xb1, 0x1a, (byte) 0xe1, 0, 1
    };
    WordPreviewService word =
        new WordPreviewService() {
          @Override
          protected byte[] convertLegacy(byte[] input) {
            assertThat(input).isEqualTo(legacy);
            return docx;
          }
        };
    var repo = new Repository("repo", "Fixture", directory.toRealPath().toString(), "");
    var workspace = mock(WorkspaceService.class);
    when(workspace.snapshot())
        .thenReturn(
            new WorkspaceResponse(
                1, "repo", Map.of(), List.of(repo), List.of(), List.of(), Map.of()));
    var sources = new SourceReferenceService(workspace, word);
    for (var entry : Map.of("report.docx", docx, "legacy.doc", legacy).entrySet()) {
      Files.write(directory.resolve(entry.getKey()), entry.getValue());
      assertThat(sources.read(entry.getKey(), "repo")).containsEntry("previewType", "docx");
      byte[] preview = sources.content(entry.getKey(), "repo", false, "docx").bytes();
      assertThat(new String(unzip(preview).get("word/document.xml"), StandardCharsets.UTF_8))
          .contains("encoding=\"UTF-8\"", "Formatted 文");
      var download = sources.content(entry.getKey(), "repo", true, "docx");
      assertThat(download.bytes()).isEqualTo(entry.getValue());
      assertThat(download.headers().get("content-disposition")).contains(entry.getKey());
      assertThat(Files.readAllBytes(directory.resolve(entry.getKey()))).isEqualTo(entry.getValue());
    }
  }

  @Test
  void utf16DoesNotBypassDtdEntityNullOrMalformedEncodingRejection() throws Exception {
    var word = new WordPreviewService();
    for (Charset encoding : List.of(StandardCharsets.UTF_16LE, StandardCharsets.UTF_16BE)) {
      for (String body :
          List.of(
              "<!DOCTYPE document [<!ENTITY leak SYSTEM 'file:///never-read'>]><document>&leak;</document>",
              "<!DOCTYPE document SYSTEM 'https://never-resolve.invalid/private'><document/>",
              "<document>bad\0text</document>")) {
        byte[] original = packageWith(xml(body, "UTF-16", encoding, true));
        assertThatThrownBy(() -> word.preview(original, false))
            .isInstanceOf(ResponseStatusException.class);
      }
      byte[] valid = xml("<document/>", "UTF-16", encoding, true);
      for (byte[] malformed :
          List.of(
              Arrays.copyOf(valid, valid.length - 1),
              xml("<document/>", "UTF-8", encoding, true))) {
        byte[] original = packageWith(malformed);
        assertThatThrownBy(() -> word.preview(original, false))
            .isInstanceOf(ResponseStatusException.class);
      }
    }
    byte[] loneSurrogate = xml("<document/>", "UTF-16LE", StandardCharsets.UTF_16LE, true);
    loneSurrogate[2] = 0;
    loneSurrogate[3] = (byte) 0xd8;
    byte[] original = packageWith(loneSurrogate);
    assertThatThrownBy(() -> word.preview(original, false))
        .isInstanceOf(ResponseStatusException.class);
  }

  @Test
  void utf8ExpansionKeepsTheExistingXmlAndAggregatePreviewLimits() throws Exception {
    byte[] oversizedPart =
        packageWith(
            xml(
                "<document>" + "文".repeat(3_000_000) + "</document>",
                "UTF-16",
                StandardCharsets.UTF_16BE,
                true));
    assertThatThrownBy(() -> new WordPreviewService().preview(oversizedPart, false))
        .isInstanceOf(ResponseStatusException.class)
        .hasMessageContaining("8 MB normalized");
    byte[] part =
        xml(
            "<document>" + "文".repeat(1_050_000) + "</document>",
            "UTF-16",
            StandardCharsets.UTF_16LE,
            true);
    var parts = new LinkedHashMap<String, byte[]>();
    parts.put("[Content_Types].xml", "<Types/>".getBytes(StandardCharsets.UTF_8));
    parts.put("word/document.xml", part);
    for (int index = 0; index < 10; index++) parts.put("word/part" + index + ".xml", part);
    byte[] oversizedAggregate = zip(parts);
    assertThatThrownBy(() -> new WordPreviewService().preview(oversizedAggregate, false))
        .isInstanceOf(ResponseStatusException.class)
        .hasMessageContaining("safe preview limits");
  }

  @Test
  void forgedCentralLocalOffsetsCannotPassWithDifferentRendererTargets() throws Exception {
    for (byte[] document :
        List.of(
            "<document>UTF-8</document>".getBytes(StandardCharsets.UTF_8),
            xml("<document>UTF-16</document>", "UTF-16", StandardCharsets.UTF_16LE, true))) {
      byte[] original = packageWith(document);
      int end = original.length - 22;
      int central = ByteBuffer.wrap(original).order(ByteOrder.LITTLE_ENDIAN).getInt(end + 16);
      for (int forgedOffset : List.of(1, central, Integer.MAX_VALUE)) {
        byte[] forged = original.clone();
        ByteBuffer.wrap(forged).order(ByteOrder.LITTLE_ENDIAN).putInt(central + 42, forgedOffset);
        assertThatThrownBy(() -> new WordPreviewService().preview(forged, false))
            .isInstanceOf(ResponseStatusException.class)
            .hasMessageContaining("local archive offsets");
      }
    }
  }

  @Test
  void deflatedDataDescriptorsAndReorderedCentralDirectoryRemainSupported() throws Exception {
    for (boolean utf16 : List.of(false, true)) {
      var bytes = new ByteArrayOutputStream();
      try (var zip = new ZipOutputStream(bytes)) {
        zip.putNextEntry(new ZipEntry("[Content_Types].xml"));
        zip.write("<Types/>".getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
        zip.putNextEntry(new ZipEntry("word/document.xml"));
        zip.write(
            utf16
                ? xml("<document>文</document>", "UTF-16", StandardCharsets.UTF_16BE, true)
                : "<document>Text</document>".getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
      }
      byte[] original = bytes.toByteArray();
      ByteBuffer buffer = ByteBuffer.wrap(original).order(ByteOrder.LITTLE_ENDIAN);
      assertThat(buffer.getShort(6) & 8).isEqualTo(8);
      assertThat(buffer.getShort(8)).isEqualTo((short) ZipEntry.DEFLATED);
      int end = original.length - 22, central = buffer.getInt(end + 16);
      int firstLength =
          46
              + Short.toUnsignedInt(buffer.getShort(central + 28))
              + Short.toUnsignedInt(buffer.getShort(central + 30))
              + Short.toUnsignedInt(buffer.getShort(central + 32));
      byte[] first = Arrays.copyOfRange(original, central, central + firstLength);
      byte[] second = Arrays.copyOfRange(original, central + firstLength, end);
      // The central directory is an index, not a promise of local-entry order.
      System.arraycopy(second, 0, original, central, second.length);
      System.arraycopy(first, 0, original, central + second.length, first.length);
      byte[] preview = new WordPreviewService().preview(original, false);
      if (!utf16) assertThat(preview).isSameAs(original);
      assertThat(new String(unzip(preview).get("word/document.xml"), StandardCharsets.UTF_8))
          .contains(utf16 ? "encoding=\"UTF-8\"" : "<document>Text</document>");
      new WordPreviewService().validate(preview, Duration.ofSeconds(2));
    }
  }

  @Test
  void zip64LocalSizesCannotHideShorterCentralCompressedSize() throws Exception {
    var parts = new LinkedHashMap<String, byte[]>();
    parts.put("[Content_Types].xml", "<Types/>".getBytes(StandardCharsets.UTF_8));
    byte[] document =
        "<document>Complete validated content</document>".getBytes(StandardCharsets.UTF_8);
    parts.put("word/document.xml", document);
    byte[] ordinary = zip(parts);
    ByteBuffer original = ByteBuffer.wrap(ordinary).order(ByteOrder.LITTLE_ENDIAN);
    int oldEnd = ordinary.length - 22, oldCentral = original.getInt(oldEnd + 16);
    int firstRecordLength = 46 + Short.toUnsignedInt(original.getShort(oldCentral + 28));
    int documentRecord = oldCentral + firstRecordLength;
    int local = original.getInt(documentRecord + 42);
    int nameLength = Short.toUnsignedInt(original.getShort(local + 26));
    assertThat(original.getShort(local + 28)).isZero();
    int insert = local + 30 + nameLength;
    byte[] zip64 = new byte[ordinary.length + 20];
    System.arraycopy(ordinary, 0, zip64, 0, insert);
    System.arraycopy(ordinary, insert, zip64, insert + 20, ordinary.length - insert);
    ByteBuffer modified = ByteBuffer.wrap(zip64).order(ByteOrder.LITTLE_ENDIAN);
    modified.putShort(local + 4, (short) 45);
    modified.putInt(local + 18, -1);
    modified.putInt(local + 22, -1);
    modified.putShort(local + 28, (short) 20);
    modified.putShort(insert, (short) 1);
    modified.putShort(insert + 2, (short) 16);
    modified.putLong(insert + 4, document.length);
    modified.putLong(insert + 12, document.length);
    modified.putShort(documentRecord + 20 + 6, (short) 45);
    modified.putInt(oldEnd + 20 + 16, oldCentral + 20);
    var word = new WordPreviewService();
    assertThat(word.preview(zip64, false)).isSameAs(zip64);
    byte[] forged = zip64.clone();
    ByteBuffer.wrap(forged)
        .order(ByteOrder.LITTLE_ENDIAN)
        .putInt(documentRecord + 20 + 20, document.length - 1);
    assertThatThrownBy(() -> word.preview(forged, false))
        .isInstanceOf(ResponseStatusException.class)
        .hasMessageContaining("invalid size or checksum");
  }

  @Test
  void unicodePathExtrasCannotAliasUnvalidatedMediaAsXml() throws Exception {
    String media = "word/media/image.png";
    byte[] original =
        zip(
            Map.of(
                "[Content_Types].xml",
                "<Types/>".getBytes(StandardCharsets.UTF_8),
                "word/document.xml",
                "<document/>".getBytes(StandardCharsets.UTF_8),
                media,
                "<!DOCTYPE document><document>Unvalidated</document>"
                    .getBytes(StandardCharsets.UTF_8)));
    var word = new WordPreviewService();
    byte[] alias =
        withCentralExtra(
            original, media, unicodePathExtra(media, "word/document.xml", 1, true), false);
    assertThatThrownBy(() -> word.preview(alias, false))
        .isInstanceOf(ResponseStatusException.class)
        .hasMessageContaining("inconsistent Unicode archive paths");
    for (byte[] ignoredOrEqual :
        List.of(
            withCentralExtra(original, media, unicodePathExtra(media, media, 1, true), false),
            withCentralExtra(
                original, media, unicodePathExtra(media, "word/document.xml", 2, true), false),
            withCentralExtra(
                original, media, unicodePathExtra(media, "word/document.xml", 1, false), false),
            withCentralExtra(
                original, media, unicodePathExtra(media, "word/document.xml", 1, true), true))) {
      assertThat(word.preview(ignoredOrEqual, false)).isSameAs(ignoredOrEqual);
    }
    byte[] badFirst = unicodePathExtra(media, "word/document.xml", 1, true);
    byte[] goodLast = unicodePathExtra(media, media, 1, true);
    byte[] repeated = new byte[badFirst.length + goodLast.length];
    System.arraycopy(badFirst, 0, repeated, 0, badFirst.length);
    System.arraycopy(goodLast, 0, repeated, badFirst.length, goodLast.length);
    byte[] lastWins = withCentralExtra(original, media, repeated, false);
    assertThat(word.preview(lastWins, false)).isSameAs(lastWins);
  }

  @Test
  void malformedCentralExtraBoundsAndInvalidEffectiveUnicodePathAreRejected() throws Exception {
    String name = "word/document.xml";
    byte[] original = packageWith("<document/>".getBytes(StandardCharsets.UTF_8));
    byte[] beyondBounds = unicodePathExtra(name, name, 1, true);
    ByteBuffer.wrap(beyondBounds)
        .order(ByteOrder.LITTLE_ENDIAN)
        .putShort(2, (short) (beyondBounds.length + 1));
    byte[] malformedUtf8 = unicodePathExtra(name, name, 1, true);
    malformedUtf8[9] = (byte) 0xff;
    for (byte[] extra :
        List.of(
            new byte[] {0x75, 0x70, 1}, // Incomplete TLV header.
            new byte[] {0x75, 0x70, 1, 0, 1}, // Version 1 missing its CRC.
            beyondBounds,
            malformedUtf8)) {
      byte[] malformed = withCentralExtra(original, name, extra, false);
      assertThatThrownBy(() -> new WordPreviewService().preview(malformed, false))
          .isInstanceOf(ResponseStatusException.class);
    }
  }

  private static byte[] unicodePathExtra(
      String raw, String alias, int version, boolean matchingCrc) {
    byte[] name = alias.getBytes(StandardCharsets.UTF_8);
    var crc = new CRC32();
    crc.update(raw.getBytes(StandardCharsets.UTF_8));
    return ByteBuffer.allocate(9 + name.length)
        .order(ByteOrder.LITTLE_ENDIAN)
        .putShort((short) 0x7075)
        .putShort((short) (5 + name.length))
        .put((byte) version)
        .putInt((int) (crc.getValue() ^ (matchingCrc ? 0 : 1)))
        .put(name)
        .array();
  }

  private static byte[] withCentralExtra(byte[] original, String name, byte[] extra, boolean utf8) {
    ByteBuffer source = ByteBuffer.wrap(original).order(ByteOrder.LITTLE_ENDIAN);
    int end = original.length - 22, central = source.getInt(end + 16);
    int record = central;
    while (record < end) {
      int length = Short.toUnsignedInt(source.getShort(record + 28));
      int extras = Short.toUnsignedInt(source.getShort(record + 30));
      int comment = Short.toUnsignedInt(source.getShort(record + 32));
      if (new String(original, record + 46, length, StandardCharsets.UTF_8).equals(name)) {
        assertThat(extras).isZero();
        int insert = record + 46 + length;
        byte[] modified = new byte[original.length + extra.length];
        System.arraycopy(original, 0, modified, 0, insert);
        System.arraycopy(extra, 0, modified, insert, extra.length);
        System.arraycopy(
            original, insert, modified, insert + extra.length, original.length - insert);
        ByteBuffer output = ByteBuffer.wrap(modified).order(ByteOrder.LITTLE_ENDIAN);
        int flags = Short.toUnsignedInt(source.getShort(record + 8));
        flags = utf8 ? flags | 0x0800 : flags & ~0x0800;
        output.putShort(record + 8, (short) flags);
        output.putShort(source.getInt(record + 42) + 6, (short) flags);
        output.putShort(record + 30, (short) extra.length);
        output.putInt(end + extra.length + 12, source.getInt(end + 12) + extra.length);
        return modified;
      }
      record += 46 + length + extras + comment;
    }
    throw new AssertionError("Missing fixture central entry: " + name);
  }

  private static byte[] xml(String body, String declaration, Charset encoding, boolean bom)
      throws Exception {
    var bytes = new ByteArrayOutputStream();
    if (bom)
      bytes.write(
          encoding.equals(StandardCharsets.UTF_16LE)
              ? new byte[] {(byte) 0xff, (byte) 0xfe}
              : new byte[] {(byte) 0xfe, (byte) 0xff});
    bytes.write(
        ("<?xml version=\"1.0\" encoding=\"" + declaration + "\"?>" + body).getBytes(encoding));
    return bytes.toByteArray();
  }

  private static byte[] packageWith(byte[] document) throws Exception {
    return zip(
        Map.of(
            "[Content_Types].xml",
            "<Types/>".getBytes(StandardCharsets.UTF_8),
            "word/document.xml",
            document));
  }

  private static byte[] zip(Map<String, byte[]> parts) throws Exception {
    var bytes = new ByteArrayOutputStream();
    try (var zip = new ZipOutputStream(bytes)) {
      for (var part : parts.entrySet()) {
        var entry = new ZipEntry(part.getKey());
        var crc = new CRC32();
        crc.update(part.getValue());
        entry.setMethod(ZipEntry.STORED);
        entry.setSize(part.getValue().length);
        entry.setCrc(crc.getValue());
        zip.putNextEntry(entry);
        zip.write(part.getValue());
        zip.closeEntry();
      }
    }
    return bytes.toByteArray();
  }

  private static Map<String, byte[]> unzip(byte[] bytes) throws Exception {
    var parts = new LinkedHashMap<String, byte[]>();
    try (var zip = new ZipInputStream(new ByteArrayInputStream(bytes))) {
      ZipEntry entry;
      while ((entry = zip.getNextEntry()) != null) parts.put(entry.getName(), zip.readAllBytes());
    }
    return parts;
  }
}
