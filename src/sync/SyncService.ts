import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebDavClient, WebDavConfig, WebDavFileInfo } from './WebDavClient';
import { SyncManifest } from './SyncManifest';
import { SessionParser } from '../sessionParser';

export interface MachineDescriptor {
  name: string;
  platform: string;
  hostname: string;
  projectDirs: string[];
  lastSeen: number;
}

export enum SyncStatus {
  Idle = 'idle',
  Syncing = 'syncing',
  Error = 'error',
  Disabled = 'disabled',
}

interface FileChange {
  relativePath: string;
  localPath?: string;
  action: 'upload' | 'download';
  localMtime?: number;
  remoteMtime?: number;
  size?: number;
}

export class SyncService implements vscode.Disposable {
  private client: WebDavClient | null = null;
  private manifest: SyncManifest;
  private cacheDir: string;
  private hostname: string;
  private status: SyncStatus = SyncStatus.Disabled;
  private autoSyncTimer?: ReturnType<typeof setInterval>;
  private syncLock = false;

  private _onStatusChange = new vscode.EventEmitter<SyncStatus>();
  readonly onStatusChange = this._onStatusChange.event;

  private outputChannel: vscode.OutputChannel;

  constructor(
    private context: vscode.ExtensionContext,
    private parser: SessionParser,
  ) {
    this.cacheDir = path.join(context.globalStorageUri.fsPath, 'webdav-cache', '.claude');
    this.manifest = new SyncManifest(context.globalStorageUri.fsPath);
    this.hostname = os.hostname();
    this.outputChannel = vscode.window.createOutputChannel('Claude Session Sync');
  }

  /** Local path for this machine's host prefix on WebDAV */
  private get hostPrefix(): string {
    return `/hosts/${this.hostname}`;
  }

  getCacheDir(): string {
    return this.cacheDir;
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  isConfigured(): boolean {
    const config = vscode.workspace.getConfiguration('claudeSessionManager.sync');
    return config.get<boolean>('enabled', false) &&
      !!config.get<string>('webdavUrl') &&
      !!config.get<string>('webdavUsername');
  }

  private setStatus(status: SyncStatus): void {
    this.status = status;
    this._onStatusChange.fire(status);
  }

  private log(msg: string): void {
    const ts = new Date().toLocaleTimeString();
    this.outputChannel.appendLine(`[${ts}] ${msg}`);
  }

  async initialize(): Promise<void> {
    if (!this.isConfigured()) {
      this.setStatus(SyncStatus.Disabled);
      return;
    }

    const config = vscode.workspace.getConfiguration('claudeSessionManager.sync');
    const password = await this.context.secrets.get('claudeSessions.webdavPassword');

    if (!password) {
      this.setStatus(SyncStatus.Disabled);
      return;
    }

    const davConfig: WebDavConfig = {
      url: config.get<string>('webdavUrl', ''),
      username: config.get<string>('webdavUsername', ''),
      password,
    };

    this.client = new WebDavClient(davConfig);
    this.setStatus(SyncStatus.Idle);
    this.log('Sync service initialized');
  }

  async configure(): Promise<boolean> {
    const url = await vscode.window.showInputBox({
      prompt: 'WebDAV URL',
      placeHolder: 'https://dav.jianguoyun.com/dav/ClaudeSessions',
      value: vscode.workspace.getConfiguration('claudeSessionManager.sync').get<string>('webdavUrl', ''),
    });
    if (!url) { return false; }

    const username = await vscode.window.showInputBox({
      prompt: 'WebDAV Username',
      placeHolder: 'your@email.com',
      value: vscode.workspace.getConfiguration('claudeSessionManager.sync').get<string>('webdavUsername', ''),
    });
    if (!username) { return false; }

    const password = await vscode.window.showInputBox({
      prompt: 'WebDAV Password (app-specific password for Jianguoyun)',
      password: true,
    });
    if (!password) { return false; }

    const testClient = new WebDavClient({ url, username, password });
    const connected = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Testing WebDAV connection...' },
      async () => testClient.testConnection()
    );

    if (!connected) {
      vscode.window.showErrorMessage('WebDAV connection failed. Please check your credentials.');
      return false;
    }

    const config = vscode.workspace.getConfiguration('claudeSessionManager.sync');
    await config.update('enabled', true, vscode.ConfigurationTarget.Global);
    await config.update('webdavUrl', url, vscode.ConfigurationTarget.Global);
    await config.update('webdavUsername', username, vscode.ConfigurationTarget.Global);
    await this.context.secrets.store('claudeSessions.webdavPassword', password);

    await this.initialize();

    vscode.window.showInformationMessage('WebDAV sync configured successfully!');
    return true;
  }

  async syncNow(): Promise<void> {
    if (this.syncLock) {
      vscode.window.showWarningMessage('Sync is already in progress.');
      return;
    }

    if (!this.client) {
      await this.initialize();
      if (!this.client) {
        vscode.window.showWarningMessage('Sync not configured. Run "Configure WebDAV Sync" first.');
        return;
      }
    }

    this.syncLock = true;
    this.setStatus(SyncStatus.Syncing);

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Syncing Claude sessions...',
          cancellable: false,
        },
        async (progress) => {
          await this.performSync(progress);
        }
      );

      this.manifest.setLastSyncTime(Date.now());
      this.manifest.save();
      this.setStatus(SyncStatus.Idle);
      this.log('Sync completed successfully');
      vscode.window.setStatusBarMessage('Claude sessions synced', 3000);
    } catch (err) {
      this.setStatus(SyncStatus.Error);
      this.log(`Sync error: ${err}`);
      vscode.window.showErrorMessage(`Sync failed: ${err}`);
    } finally {
      this.syncLock = false;
    }
  }

  // ---- Core sync logic (per-host cloud structure) ----

  private async performSync(progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
    if (!this.client) { throw new Error('Not initialized'); }

    // Ensure remote directory structure: /hosts/{hostname}/projects/
    progress.report({ message: 'Preparing remote directories...' });
    await this.client.mkdirp(`${this.hostPrefix}/projects`);

    // 1. Upload local sessions to /hosts/{hostname}/projects/...
    progress.report({ message: 'Scanning local sessions...' });
    const localFiles = this.scanLocalFiles();
    this.log(`Found ${localFiles.size} local session files`);

    progress.report({ message: 'Scanning remote sessions...' });
    const myRemoteFiles = await this.scanHostRemoteFiles(this.hostname);
    this.log(`Found ${myRemoteFiles.size} remote files for this host`);

    const uploadChanges = this.computeUploadChanges(localFiles, myRemoteFiles);
    this.log(`Uploads needed: ${uploadChanges.length}`);

    // 2. Download sessions from all OTHER hosts
    const otherHosts = await this.listRemoteHosts();
    const downloadChanges: FileChange[] = [];
    for (const host of otherHosts) {
      if (host === this.hostname) { continue; }
      progress.report({ message: `Scanning remote host: ${host}...` });
      const hostFiles = await this.scanHostRemoteFiles(host);
      for (const [relativePath, info] of hostFiles) {
        // relativePath = hosts/{host}/projects/{proj}/{file}
        const cachePath = path.join(this.cacheDir, relativePath);
        const manifest = this.manifest.getEntry(relativePath);

        let needDownload = false;
        if (!fs.existsSync(cachePath)) {
          needDownload = true;
        } else if (manifest) {
          if (info.lastModified.getTime() > manifest.syncedAt + 1000) {
            needDownload = true;
          }
        } else {
          needDownload = true;
        }

        if (needDownload) {
          downloadChanges.push({
            relativePath,
            action: 'download',
            remoteMtime: info.lastModified.getTime(),
            size: info.size,
          });
        }
      }
    }
    this.log(`Downloads needed: ${downloadChanges.length}`);

    const total = uploadChanges.length + downloadChanges.length;
    let current = 0;

    // Execute uploads
    for (const change of uploadChanges) {
      current++;
      progress.report({
        message: `Uploading (${current}/${total}): ${path.basename(change.relativePath)}`,
        increment: total > 0 ? 100 / total : 0,
      });
      await this.uploadFile(change);
    }

    // Execute downloads
    for (const change of downloadChanges) {
      current++;
      progress.report({
        message: `Downloading (${current}/${total}): ${path.basename(change.relativePath)}`,
        increment: total > 0 ? 100 / total : 0,
      });
      await this.downloadFile(change);
    }

    // Sync metadata
    progress.report({ message: 'Syncing metadata...' });
    await this.syncMetadata();
  }

  private scanLocalFiles(): Map<string, { fullPath: string; size: number; mtimeMs: number }> {
    const files = new Map<string, { fullPath: string; size: number; mtimeMs: number }>();

    for (const { dir } of this.parser.getClaudeDirs()) {
      if (dir === this.cacheDir) { continue; }

      const projectsDir = path.join(dir, 'projects');
      if (!fs.existsSync(projectsDir)) { continue; }

      try {
        const projectDirs = fs.readdirSync(projectsDir)
          .filter(d => {
            const full = path.join(projectsDir, d);
            return fs.statSync(full).isDirectory() && !d.startsWith('.');
          });

        for (const projectDir of projectDirs) {
          const fullProjectDir = path.join(projectsDir, projectDir);
          const sessionFiles = fs.readdirSync(fullProjectDir)
            .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));

          for (const file of sessionFiles) {
            const fullPath = path.join(fullProjectDir, file);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory() || stat.size === 0) { continue; }
            if (Date.now() - stat.mtimeMs < 30000) { continue; }

            // Remote path: /hosts/{hostname}/projects/{proj}/{file}
            const relativePath = `hosts/${this.hostname}/projects/${projectDir}/${file}`;
            files.set(relativePath, {
              fullPath,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
            });
          }
        }
      } catch { /* skip */ }
    }

    return files;
  }

  private async listRemoteHosts(): Promise<string[]> {
    if (!this.client) { return []; }
    try {
      const items = await this.client.list('/hosts');
      return items.filter(i => i.isDirectory).map(i => i.path.replace(/\/$/, ''));
    } catch {
      return [];
    }
  }

  private async scanHostRemoteFiles(host: string): Promise<Map<string, WebDavFileInfo>> {
    if (!this.client) { return new Map(); }

    const files = new Map<string, WebDavFileInfo>();
    try {
      const projectDirs = await this.client.list(`/hosts/${host}/projects`);
      for (const projDir of projectDirs) {
        if (!projDir.isDirectory) { continue; }
        const projName = projDir.path.replace(/\/$/, '');
        const sessionFiles = await this.client.list(`/hosts/${host}/projects/${projName}`);
        for (const file of sessionFiles) {
          if (file.isDirectory || !file.path.endsWith('.jsonl') || file.path.startsWith('agent-')) { continue; }
          const relativePath = `hosts/${host}/projects/${projName}/${file.path}`;
          files.set(relativePath, file);
        }
      }
    } catch (err) {
      this.log(`Error scanning host ${host}: ${err}`);
    }
    return files;
  }

  private computeUploadChanges(
    localFiles: Map<string, { fullPath: string; size: number; mtimeMs: number }>,
    remoteFiles: Map<string, WebDavFileInfo>,
  ): FileChange[] {
    const changes: FileChange[] = [];

    for (const [relativePath, local] of localFiles) {
      const manifest = this.manifest.getEntry(relativePath);
      const remote = remoteFiles.get(relativePath);

      if (!remote) {
        changes.push({ relativePath, localPath: local.fullPath, action: 'upload', localMtime: local.mtimeMs, size: local.size });
      } else if (manifest) {
        const localChanged = local.size !== manifest.size || local.mtimeMs > manifest.mtimeMs + 1000;
        if (localChanged) {
          changes.push({ relativePath, localPath: local.fullPath, action: 'upload', localMtime: local.mtimeMs, size: local.size });
        }
      } else {
        changes.push({ relativePath, localPath: local.fullPath, action: 'upload', localMtime: local.mtimeMs, size: local.size });
      }
    }

    return changes;
  }

  private async uploadFile(change: FileChange): Promise<void> {
    if (!this.client || !change.localPath) { return; }

    try {
      const remoteDir = path.dirname(change.relativePath);
      await this.client.mkdirp('/' + remoteDir);

      const content = fs.readFileSync(change.localPath);
      await this.client.upload('/' + change.relativePath, content);

      this.manifest.setEntry(change.relativePath, {
        size: content.length,
        mtimeMs: change.localMtime || Date.now(),
        syncedAt: Date.now(),
      });

      this.log(`Uploaded: ${change.relativePath} (${this.formatSize(content.length)})`);
    } catch (err) {
      this.log(`Upload failed: ${change.relativePath} - ${err}`);
      throw err;
    }
  }

  private async downloadFile(change: FileChange): Promise<void> {
    if (!this.client) { return; }

    try {
      const content = await this.client.download('/' + change.relativePath);

      // Cache path mirrors the remote structure
      const cachePath = path.join(this.cacheDir, change.relativePath);
      const cacheFileDir = path.dirname(cachePath);
      if (!fs.existsSync(cacheFileDir)) {
        fs.mkdirSync(cacheFileDir, { recursive: true });
      }
      fs.writeFileSync(cachePath, content);

      this.manifest.setEntry(change.relativePath, {
        size: content.length,
        mtimeMs: change.remoteMtime || Date.now(),
        syncedAt: Date.now(),
      });

      this.log(`Downloaded: ${change.relativePath} (${this.formatSize(content.length)})`);
    } catch (err) {
      this.log(`Download failed: ${change.relativePath} - ${err}`);
      throw err;
    }
  }

  // ---- Metadata sync ----

  private async syncMetadata(): Promise<void> {
    if (!this.client) { return; }

    await this.uploadMachineDescriptor();
    await this.downloadMachineDescriptors();
    await this.syncHistoryFile();
    await this.syncSessionNames();
  }

  private async uploadMachineDescriptor(): Promise<void> {
    if (!this.client) { return; }

    const configuredName = this.parser.getClaudeDirs()
      .find(d => d.dir !== this.cacheDir && d.name)?.name || this.hostname;

    const projectDirs: string[] = [];
    for (const { dir } of this.parser.getClaudeDirs()) {
      if (dir === this.cacheDir) { continue; }
      const projectsDir = path.join(dir, 'projects');
      if (!fs.existsSync(projectsDir)) { continue; }
      try {
        const dirs = fs.readdirSync(projectsDir).filter(d => {
          const full = path.join(projectsDir, d);
          return fs.statSync(full).isDirectory() && !d.startsWith('.');
        });
        projectDirs.push(...dirs);
      } catch { /* skip */ }
    }

    const descriptor: MachineDescriptor = {
      name: configuredName,
      platform: os.platform(),
      hostname: this.hostname,
      projectDirs,
      lastSeen: Date.now(),
    };

    try {
      // Store descriptor inside the host directory
      await this.client.upload(`${this.hostPrefix}/machine.json`, JSON.stringify(descriptor, null, 2));
      this.log(`Uploaded machine descriptor for ${this.hostname}`);
    } catch (err) {
      this.log(`Machine descriptor upload failed: ${err}`);
    }
  }

  private async downloadMachineDescriptors(): Promise<void> {
    if (!this.client) { return; }

    const machinesDir = path.join(this.cacheDir, '..', 'machines');
    if (!fs.existsSync(machinesDir)) {
      fs.mkdirSync(machinesDir, { recursive: true });
    }

    try {
      const hosts = await this.listRemoteHosts();
      for (const host of hosts) {
        try {
          const content = await this.client.download(`/hosts/${host}/machine.json`);
          fs.writeFileSync(path.join(machinesDir, `${host}.json`), content);
          this.log(`Downloaded machine descriptor: ${host}`);
        } catch { /* skip if no descriptor */ }
      }
    } catch (err) {
      this.log(`Machine descriptor download failed: ${err}`);
    }
  }

  getMachineDescriptorsDir(): string {
    return path.join(this.cacheDir, '..', 'machines');
  }

  private async syncHistoryFile(): Promise<void> {
    if (!this.client) { return; }

    const claudeDirs = this.parser.getClaudeDirs();
    const primaryDir = claudeDirs.find(d => d.dir !== this.cacheDir)?.dir;
    if (!primaryDir) { return; }

    const localPath = path.join(primaryDir, 'history.jsonl');
    const localContent = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf-8') : '';

    try {
      // Upload this machine's history to its host directory (no conflict)
      if (localContent) {
        await this.client.upload(`${this.hostPrefix}/history.jsonl`, localContent);
      }

      // Download and merge history from all other hosts
      const hosts = await this.listRemoteHosts();
      let merged = localContent;
      for (const host of hosts) {
        if (host === this.hostname) { continue; }
        try {
          const remoteContent = await this.client.download(`/hosts/${host}/history.jsonl`);
          merged = this.mergeHistoryFiles(merged, remoteContent.toString('utf-8'));
        } catch { /* skip if no history */ }
      }

      // Write merged locally (includes all machines' entries)
      if (merged !== localContent) {
        fs.writeFileSync(localPath, merged);
        this.log('Merged history.jsonl from all hosts');
      }
    } catch (err) {
      this.log(`history.jsonl sync failed: ${err}`);
    }
  }

  private mergeHistoryFiles(localContent: string, remoteContent: string): string {
    const entries = new Map<string, { line: string; timestamp: number }>();

    const parseLines = (content: string) => {
      for (const line of content.split('\n')) {
        if (!line.trim()) { continue; }
        try {
          const entry = JSON.parse(line);
          if (entry.sessionId) {
            const existing = entries.get(entry.sessionId);
            if (!existing || entry.timestamp > existing.timestamp) {
              entries.set(entry.sessionId, { line, timestamp: entry.timestamp });
            }
          }
        } catch { /* skip */ }
      }
    };

    parseLines(localContent);
    parseLines(remoteContent);

    const sorted = Array.from(entries.values())
      .sort((a, b) => b.timestamp - a.timestamp);

    return sorted.map(e => e.line).join('\n') + '\n';
  }

  private async syncSessionNames(): Promise<void> {
    if (!this.client) { return; }

    const claudeDirs = this.parser.getClaudeDirs();
    const primaryDir = claudeDirs.find(d => d.dir !== this.cacheDir)?.dir;
    if (!primaryDir) { return; }

    const localPath = path.join(primaryDir, 'session-names.json');
    const localContent = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf-8') : '{}';

    try {
      const remoteExists = await this.client.exists('/session-names.json');
      if (remoteExists) {
        const remoteContent = await this.client.download('/session-names.json');
        const local = JSON.parse(localContent) as Record<string, string>;
        const remote = JSON.parse(remoteContent.toString('utf-8')) as Record<string, string>;

        const merged = { ...local, ...remote };
        const mergedStr = JSON.stringify(merged, null, 2);

        fs.writeFileSync(localPath, mergedStr);
        await this.client.upload('/session-names.json', mergedStr);
        this.log('Merged session-names.json');
      } else if (localContent !== '{}') {
        await this.client.upload('/session-names.json', localContent);
        this.log('Uploaded session-names.json');
      }
    } catch (err) {
      this.log(`session-names.json sync failed: ${err}`);
    }
  }

  // ---- Delete ----

  async deleteRemote(filePath: string): Promise<void> {
    if (!this.client) {
      await this.initialize();
    }
    if (!this.client) { return; }

    const parts = filePath.replace(/\\/g, '/').split('/');
    const fileName = parts[parts.length - 1];
    const projectDir = parts[parts.length - 2];
    const relativePath = `hosts/${this.hostname}/projects/${projectDir}/${fileName}`;

    try {
      await this.client.delete('/' + relativePath);
      this.log(`Deleted remote: ${relativePath}`);
    } catch (err) {
      this.log(`Remote delete failed: ${relativePath} - ${err}`);
    }

    this.manifest.removeEntry(relativePath);
    this.manifest.save();

    const cachePath = path.join(this.cacheDir, relativePath);
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
    }
  }

  // ---- Auto-sync ----

  startAutoSync(intervalSeconds: number): void {
    this.stopAutoSync();
    const interval = Math.max(intervalSeconds, 60) * 1000;
    this.autoSyncTimer = setInterval(async () => {
      if (!this.syncLock && this.client) {
        try {
          await this.syncNow();
        } catch {
          // auto-sync errors are logged but not shown
        }
      }
    }, interval);
    this.log(`Auto-sync started: every ${intervalSeconds}s`);
  }

  stopAutoSync(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = undefined;
    }
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  dispose(): void {
    this.stopAutoSync();
    this._onStatusChange.dispose();
    this.outputChannel.dispose();
  }
}
