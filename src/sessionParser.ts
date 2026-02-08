import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SessionSource {
  path: string;
  platform?: 'darwin' | 'win32' | 'linux' | 'all';
  hostname?: string;  // only match on this hostname
  name?: string;      // machine display name
  label?: string;     // source label
}

export interface SessionInfo {
  sessionId: string;
  displayName: string; // custom name or first user message
  firstMessage: string;
  project: string;        // raw project dir name
  projectDisplay: string; // human-readable project name (after mapping)
  machine: string;        // machine display name (e.g. "MacBook Pro (macOS)")
  source: string;         // label of the source directory
  createdAt: Date;
  lastModified: Date;
  fileSizeBytes: number;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  isActive: boolean;
  version: string;
  filePath: string;
}

interface HistoryEntry {
  display: string;
  timestamp: number;
  project: string;
  sessionId: string;
}

interface SessionLine {
  type?: string;
  sessionId?: string;
  timestamp?: string;
  version?: string;
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string }> | string;
  };
  operation?: string;
}

export class SessionParser {
  private claudeDirs: { dir: string; label: string; name?: string; platform?: string }[];
  private customNames: Map<string, string> = new Map();
  private customNamesPath: string;
  // Cache: encoded dir name -> machine display label
  private machineCache: Map<string, string> = new Map();
  // Cache: source dir -> machine display label
  private sourceMachineCache: Map<string, string> = new Map();
  // Cache: hostname -> { name, platform } from all sources (not just resolved ones)
  private hostnameMap: Map<string, { name: string; platform: string }> = new Map();

  constructor(sources?: SessionSource[]) {
    // Build hostname map from ALL sources (before platform/hostname filtering)
    if (sources) {
      for (const src of sources) {
        if (src.hostname && src.name) {
          this.hostnameMap.set(src.hostname, {
            name: src.name,
            platform: src.platform && src.platform !== 'all' ? src.platform : os.platform(),
          });
        }
      }
    }
    this.claudeDirs = SessionParser.resolveSources(sources);
    this.buildMachineCache();

    // Store custom names in the first available directory
    const primaryDir = this.claudeDirs.length > 0
      ? this.claudeDirs[0].dir
      : path.join(os.homedir(), '.claude');
    this.customNamesPath = path.join(primaryDir, 'session-names.json');
    this.loadCustomNames();
  }

  static resolveSources(sources?: SessionSource[]): { dir: string; label: string; name?: string; platform?: string }[] {
    const currentPlatform = os.platform();
    const result: { dir: string; label: string; name?: string; platform?: string }[] = [];

    if (!sources || sources.length === 0) {
      const defaultDir = path.join(os.homedir(), '.claude');
      if (fs.existsSync(defaultDir)) {
        result.push({ dir: defaultDir, label: 'Local', platform: currentPlatform });
      }
      return result;
    }

    const currentHostname = os.hostname();

    for (const src of sources) {
      // Filter by platform
      if (src.platform && src.platform !== 'all' && src.platform !== currentPlatform) {
        continue;
      }
      // Filter by hostname (if specified)
      if (src.hostname && src.hostname !== currentHostname) {
        continue;
      }

      const resolved = src.path.replace(/^~/, os.homedir());
      if (fs.existsSync(resolved)) {
        result.push({
          dir: resolved,
          label: src.label || path.basename(resolved),
          name: src.name,
          platform: src.platform === 'all' ? currentPlatform : (src.platform || currentPlatform),
        });
      }
    }

    if (result.length === 0) {
      const defaultDir = path.join(os.homedir(), '.claude');
      if (fs.existsSync(defaultDir)) {
        result.push({ dir: defaultDir, label: 'Local', platform: currentPlatform });
      }
    }

    return result;
  }

  getClaudeDirs(): { dir: string; label: string; name?: string; platform?: string }[] {
    return this.claudeDirs;
  }

  addRuntimeSource(dir: string, label: string, name?: string, platform?: string): void {
    if (!this.claudeDirs.some(d => d.dir === dir)) {
      this.claudeDirs.push({ dir, label, name, platform });
    }
  }

  /**
   * Convert a filesystem path to the encoded project dir name that Claude uses.
   * Verified against actual Claude behavior:
   *   macOS: "/Users/zoomin.hao/Documents/AI_Work" -> "-Users-zoomin-hao-Documents-AI-Work"
   *   Windows: "C:\Work\AI_Work" -> "c--Work-AI-Work" (lowercase drive, colon->hyphen, backslash->hyphen)
   */
  static encodeProjectPath(p: string): string {
    // Lowercase drive letter only (C: -> c:)
    let result = p.replace(/^([A-Z]):/, (_, d) => d.toLowerCase() + ':');
    return result
      .replace(/:/g, '-')              // colon -> hyphen
      .replace(/[\\/]/g, '-')          // slashes -> hyphen
      .replace(/[_.]/g, '-');          // underscores, dots -> hyphens
  }

  /**
   * Resolve a raw project dir name to a display name.
   * Extracts the last meaningful path segment.
   * e.g. "-Users-zoomin-hao-Documents-AI-Work" -> "AI-Work"
   */
  resolveProjectDisplay(rawDirName: string): string {
    const segments = rawDirName.split('-').filter(s => s);
    if (segments.length > 0) {
      return segments[segments.length - 1];
    }
    return rawDirName;
  }

  /**
   * Resolve a raw project dir name to a canonical key for grouping/filtering.
   */
  resolveProjectKey(rawDirName: string): string {
    return rawDirName;
  }

  private static platformLabel(p: string): string {
    switch (p) {
      case 'darwin': return 'macOS';
      case 'win32': return 'Windows';
      case 'linux': return 'Linux';
      default: return p;
    }
  }

  private static platformIcon(p: string): string {
    switch (p) {
      case 'darwin': return '\uD83C\uDF4E';  // 🍎
      case 'win32': return '\uD83E\uDE9F';   // 🪟
      case 'linux': return '\uD83D\uDC27';   // 🐧
      default: return '\uD83D\uDCBB';        // 💻
    }
  }

  private machineDescriptorsDir: string | null = null;

  setMachineDescriptorsDir(dir: string): void {
    this.machineDescriptorsDir = dir;
    this.buildMachineCache();
  }

  /** Get the display label for the local machine (used for sorting machine groups) */
  getLocalMachineName(): string {
    const info = this.hostnameMap.get(os.hostname());
    if (info) {
      return this.buildMachineNameLabel(info.name);
    }
    const icon = SessionParser.platformIcon(os.platform());
    const label = SessionParser.platformLabel(os.platform());
    return `${icon} ${os.hostname()} (${label})`;
  }

  // Build a lookup: machine name -> display label (with icon)
  private buildMachineNameLabel(machineName: string): string {
    // Try to find platform from claudeDirs config
    for (const src of this.claudeDirs) {
      if (src.name === machineName) {
        const plat = src.platform || os.platform();
        return `${SessionParser.platformIcon(plat)} ${machineName}`;
      }
    }
    // Try hostnameMap (covers all claudeDirs entries including other platforms)
    for (const [, info] of this.hostnameMap) {
      if (info.name === machineName) {
        return `${SessionParser.platformIcon(info.platform)} ${machineName}`;
      }
    }
    // Try machine descriptors
    if (this.machineDescriptorsDir && fs.existsSync(this.machineDescriptorsDir)) {
      try {
        const files = fs.readdirSync(this.machineDescriptorsDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
          try {
            const desc = JSON.parse(fs.readFileSync(path.join(this.machineDescriptorsDir, file), 'utf-8'));
            if (desc.name === machineName && desc.platform) {
              return `${SessionParser.platformIcon(desc.platform)} ${machineName}`;
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
    return `\uD83D\uDCBB ${machineName}`; // 💻 fallback
  }

  /**
   * Resolve a hostname to the configured machine name.
   * Checks claudeDirs config first, then synced machine descriptors.
   */
  private buildMachineCache(): void {
    this.machineCache.clear();
    this.sourceMachineCache.clear();

    // 1. From claudeDirs: source dir name -> machine label, and all project dirs under it
    for (const src of this.claudeDirs) {
      if (src.name) {
        const machineLabel = this.buildMachineNameLabel(src.name);
        this.sourceMachineCache.set(src.dir, machineLabel);

        const projectsDir = path.join(src.dir, 'projects');
        if (fs.existsSync(projectsDir)) {
          try {
            const dirs = fs.readdirSync(projectsDir).filter(d => {
              const full = path.join(projectsDir, d);
              return fs.statSync(full).isDirectory() && !d.startsWith('.');
            });
            for (const d of dirs) {
              this.machineCache.set(d, machineLabel);
            }
          } catch { /* skip */ }
        }
      }
    }

    // 2. Load from synced machine descriptors (auto, won't overwrite existing)
    const currentHostname = os.hostname();
    if (this.machineDescriptorsDir && fs.existsSync(this.machineDescriptorsDir)) {
      try {
        const files = fs.readdirSync(this.machineDescriptorsDir)
          .filter(f => f.endsWith('.json'));
        for (const file of files) {
          try {
            const content = fs.readFileSync(
              path.join(this.machineDescriptorsDir, file), 'utf-8'
            );
            const desc = JSON.parse(content) as {
              name: string;
              platform: string;
              hostname: string;
              projectDirs: string[];
            };
            // Skip current machine's descriptor (already handled by claudeDirs)
            if (desc.hostname === currentHostname) { continue; }

            const label = this.buildMachineNameLabel(desc.name);
            for (const dirName of desc.projectDirs) {
              if (!this.machineCache.has(dirName)) {
                this.machineCache.set(dirName, label);
              }
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  }

  /**
   * Resolve which machine a session belongs to from its project dir name.
   */
  resolveMachine(rawDirName: string): string {
    // Check machine cache (from config + descriptors)
    const cached = this.machineCache.get(rawDirName);
    if (cached) { return cached; }

    // Infer platform from project dir encoding pattern
    const platform = SessionParser.inferPlatform(rawDirName);
    const icon = SessionParser.platformIcon(platform);
    const label = SessionParser.platformLabel(platform);

    if (platform === os.platform()) {
      return `${icon} ${os.hostname()} (${label})`;
    }

    return `${icon} ${label}`;
  }

  /**
   * Infer the platform from an encoded project dir name.
   */
  private static inferPlatform(encoded: string): string {
    // macOS: -Users-xxx-...
    if (encoded.startsWith('-Users-')) { return 'darwin'; }
    // Linux: -home-xxx-...
    if (encoded.startsWith('-home-')) { return 'linux'; }
    // Windows: C-Users-xxx-... (drive letter then Users)
    if (/^[A-Z]-Users-/.test(encoded)) { return 'win32'; }
    // Default to current platform
    return os.platform();
  }

  getMachineNames(): string[] {
    const names = new Set<string>();
    for (const { dir } of this.claudeDirs) {
      for (const projectDir of this.getProjectDirsForSource(dir)) {
        const raw = path.basename(projectDir);
        names.add(this.resolveMachine(raw));
      }
    }
    return Array.from(names).sort();
  }

  reloadCustomNames(): void {
    this.loadCustomNames();
  }

  private loadCustomNames(): void {
    try {
      if (fs.existsSync(this.customNamesPath)) {
        const data = JSON.parse(fs.readFileSync(this.customNamesPath, 'utf-8'));
        this.customNames = new Map(Object.entries(data));
      }
    } catch {
      this.customNames = new Map();
    }
  }

  saveCustomName(sessionId: string, name: string): void {
    this.customNames.set(sessionId, name);
    const obj = Object.fromEntries(this.customNames);
    fs.writeFileSync(this.customNamesPath, JSON.stringify(obj, null, 2));
  }

  getCustomName(sessionId: string): string | undefined {
    return this.customNames.get(sessionId);
  }

  private getProjectDirsForSource(claudeDir: string): string[] {
    const projectsDir = path.join(claudeDir, 'projects');
    if (!fs.existsSync(projectsDir)) {
      return [];
    }
    return fs.readdirSync(projectsDir)
      .filter(d => {
        const full = path.join(projectsDir, d);
        return fs.statSync(full).isDirectory() && !d.startsWith('.');
      })
      .map(d => path.join(projectsDir, d));
  }

  private getHistoryEntriesForSource(claudeDir: string): Map<string, HistoryEntry> {
    const historyPath = path.join(claudeDir, 'history.jsonl');
    const entries = new Map<string, HistoryEntry>();

    if (!fs.existsSync(historyPath)) {
      return entries;
    }

    try {
      const content = fs.readFileSync(historyPath, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) { continue; }
        try {
          const entry = JSON.parse(line) as HistoryEntry;
          if (entry.sessionId) {
            if (!entries.has(entry.sessionId)) {
              entries.set(entry.sessionId, entry);
            }
          }
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // ignore read errors
    }

    return entries;
  }

  parseSessionFile(filePath: string): SessionInfo | null {
    try {
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      if (lines.length === 0) { return null; }

      let sessionId = '';
      let firstMessage = '';
      let createdAt: Date | null = null;
      let version = '';
      let messageCount = 0;
      let userMessageCount = 0;
      let assistantMessageCount = 0;
      let toolCallCount = 0;
      let lastQueueOp = '';

      for (const line of lines) {
        try {
          const obj: SessionLine = JSON.parse(line);

          if (obj.type === 'queue-operation') {
            lastQueueOp = obj.operation || '';
            if (!sessionId && obj.sessionId) {
              sessionId = obj.sessionId;
            }
            continue;
          }

          if (obj.type === 'file-history-snapshot') {
            continue;
          }

          if (obj.sessionId && !sessionId) {
            sessionId = obj.sessionId;
          }

          if (obj.version && !version) {
            version = obj.version;
          }

          if (obj.type === 'user' || obj.type === 'assistant') {
            messageCount++;

            if (obj.timestamp) {
              const ts = new Date(obj.timestamp);
              if (!createdAt || ts < createdAt) {
                createdAt = ts;
              }
            }

            if (obj.type === 'user') {
              userMessageCount++;
              if (!firstMessage && obj.message?.content) {
                const content = obj.message.content;
                if (Array.isArray(content)) {
                  for (const block of content) {
                    if (block.type === 'text' && block.text) {
                      const text = block.text.trim();
                      // Skip IDE selection metadata
                      if (!text.startsWith('<ide_selection>') && !text.startsWith('<ide_opened_file>')) {
                        firstMessage = text.substring(0, 100);
                        break;
                      }
                    }
                  }
                } else if (typeof content === 'string') {
                  firstMessage = content.substring(0, 100);
                }
              }
            }

            if (obj.type === 'assistant') {
              assistantMessageCount++;
              const msgContent = obj.message?.content;
              if (Array.isArray(msgContent)) {
                for (const block of msgContent) {
                  if (block.type === 'tool_use') {
                    toolCallCount++;
                  }
                }
              }
            }
          }
        } catch {
          // skip malformed lines
        }
      }

      if (!sessionId) {
        const basename = path.basename(filePath, '.jsonl');
        sessionId = basename;
      }

      const isActive = lastQueueOp === 'dequeue' &&
        (Date.now() - stat.mtimeMs) < 30000;

      const customName = this.getCustomName(sessionId);

      return {
        sessionId,
        displayName: customName || firstMessage || sessionId.substring(0, 8),
        firstMessage: firstMessage || '(empty session)',
        project: '',
        projectDisplay: '',
        machine: '',
        source: '',
        createdAt: createdAt || stat.birthtime,
        lastModified: stat.mtime,
        fileSizeBytes: stat.size,
        messageCount,
        userMessageCount,
        assistantMessageCount,
        toolCallCount,
        isActive,
        version,
        filePath,
      };
    } catch {
      return null;
    }
  }

  getAllSessions(projectFilter?: string): SessionInfo[] {
    const sessions: SessionInfo[] = [];
    for (const src of this.claudeDirs) {
      const claudeDir = src.dir;
      const sourceLabel = src.label;
      // Machine label from source (highest priority)
      const sourceMachine = src.name ? this.buildMachineNameLabel(src.name) : undefined;
      const historyEntries = this.getHistoryEntriesForSource(claudeDir);
      const projectDirs = this.getProjectDirsForSource(claudeDir);

      for (const projectDir of projectDirs) {
        const projectName = path.basename(projectDir);
        const projectKey = this.resolveProjectKey(projectName);

        if (projectFilter && projectKey !== projectFilter) {
          continue;
        }

        try {
          const files = fs.readdirSync(projectDir);
          for (const file of files) {
            if (!file.endsWith('.jsonl')) { continue; }
            if (file.startsWith('agent-')) { continue; }

            const filePath = path.join(projectDir, file);
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) { continue; }
            if (stat.size === 0) { continue; }

            const session = this.parseSessionFile(filePath);
            if (!session) { continue; }
            if (session.messageCount === 0) { continue; }

            session.project = projectName;
            session.projectDisplay = this.resolveProjectDisplay(projectName);
            session.machine = sourceMachine || this.resolveMachine(projectName);
            session.source = sourceLabel;

            // Enrich with history data
            const historyEntry = historyEntries.get(session.sessionId);
            if (historyEntry && !this.getCustomName(session.sessionId)) {
              if (historyEntry.display) {
                session.displayName = historyEntry.display;
              }
            }
            if (historyEntry?.timestamp && !session.createdAt) {
              session.createdAt = new Date(historyEntry.timestamp);
            }

            sessions.push(session);
          }
        } catch {
          // skip inaccessible dirs
        }
      }
    }

    sessions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return sessions;
  }

  getProjectNames(): string[] {
    const names = new Set<string>();
    for (const { dir } of this.claudeDirs) {
      for (const projectDir of this.getProjectDirsForSource(dir)) {
        const raw = path.basename(projectDir);
        names.add(this.resolveProjectKey(raw));
      }
    }
    return Array.from(names);
  }

  deleteSession(sessionId: string, filePath: string): void {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    const dirPath = filePath.replace('.jsonl', '');
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      fs.rmSync(dirPath, { recursive: true });
    }
    if (this.customNames.has(sessionId)) {
      this.customNames.delete(sessionId);
      const obj = Object.fromEntries(this.customNames);
      fs.writeFileSync(this.customNamesPath, JSON.stringify(obj, null, 2));
    }
  }
}
