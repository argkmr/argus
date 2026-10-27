package com.argus.backup.service;

import com.argus.apiclient.repository.ApiCollectionRepository;
import com.argus.common.config.ArgusProperties;
import java.nio.file.Path;
import org.springframework.stereotype.Component;

@Component
public class BackupPaths {
  public final Path data, maintenance, collections, project, source, encrypted, manifest;

  @org.springframework.beans.factory.annotation.Autowired
  public BackupPaths(ArgusProperties properties, ApiCollectionRepository collections) {
    this(
        properties.dataDirectory(),
        Path.of(
            System.getenv()
                .getOrDefault(
                    "ARGUS_MAINTENANCE_DATA_DIR",
                    properties
                        .dataDirectory()
                        .resolveSibling("Argus Personal Maintenance")
                        .toString())),
        collections.root(),
        projectRoot(properties),
        properties.sourceRoot());
  }

  BackupPaths(Path data, Path maintenance, Path collections, Path project, Path source) {
    this.data = data.toAbsolutePath().normalize();
    this.maintenance = maintenance.toAbsolutePath().normalize();
    this.collections = collections.toAbsolutePath().normalize();
    this.project = project.toAbsolutePath().normalize();
    this.source = source.toAbsolutePath().normalize();
    encrypted = this.project.resolve(".argus-backup/argus-backup.enc");
    manifest = this.project.resolve(".argus-backup/manifest.json");
    if (this.maintenance.equals(this.data)
        || this.maintenance.startsWith(this.data)
            && this.data.relativize(this.maintenance).getNameCount() != 1)
      throw new IllegalArgumentException(
          "Maintenance storage must be separate from local data or its immediate child");
  }

  private static Path projectRoot(ArgusProperties properties) {
    String configured = System.getenv("ARGUS_BACKUP_REPOSITORY_DIR");
    if (configured != null && !configured.isBlank()) return Path.of(configured);
    Path candidate = properties.sourceRoot();
    for (Path part : candidate)
      if (part.toString().toLowerCase().endsWith(".asar"))
        return properties.dataDirectory().getParent().resolve("Argus Personal Backup Repository");
    return candidate;
  }

  public Path driveRoot(String configured) {
    if (configured == null || configured.isBlank())
      throw new IllegalArgumentException("Choose a Google Drive folder");
    Path root = Path.of(configured).toAbsolutePath().normalize();
    if (root.getFileName() == null)
      throw new IllegalArgumentException("Choose a Google Drive folder, not the filesystem root");
    return root.getFileName().toString().equalsIgnoreCase("Argus Backups")
        ? root
        : root.resolve("Argus Backups");
  }

  public void requireDedicatedProject() {
    if (project.equals(source))
      throw new IllegalArgumentException(
          "Latest-only backup requires Argus's dedicated backup working copy; refusing to rewrite the live source repository");
    for (Path protectedRoot : java.util.List.of(data, maintenance, collections, source))
      if (project.equals(protectedRoot)
          || protectedRoot.startsWith(project)
          || project.startsWith(protectedRoot))
        throw new IllegalArgumentException(
            "Backup working copy must be separate from Argus data and source roots");
  }
}
