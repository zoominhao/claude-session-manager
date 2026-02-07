import * as vscode from 'vscode';
import { SessionInfo, SessionParser } from './sessionParser';

class MachineTreeItem extends vscode.TreeItem {
  constructor(
    public readonly machineName: string,
    public readonly sessionCount: number,
    public readonly hasActive: boolean,
  ) {
    super(machineName, vscode.TreeItemCollapsibleState.Expanded);

    this.contextValue = 'machine';
    this.description = `${sessionCount} sessions`;
    this.iconPath = new vscode.ThemeIcon(
      hasActive ? 'vm-running' : 'vm',
      hasActive ? new vscode.ThemeColor('charts.green') : undefined
    );
  }
}

export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly session: SessionInfo,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    const label = session.displayName.length > 50
      ? session.displayName.substring(0, 50) + '...'
      : session.displayName;
    super(label, collapsibleState);

    this.contextValue = 'session';
    this.tooltip = this.buildTooltip();
    this.description = this.buildDescription();
    this.iconPath = this.getIcon();

    // Use custom URI scheme for FileDecorationProvider to color active sessions
    this.resourceUri = vscode.Uri.parse(
      `claude-session://session/${session.isActive ? 'active' : 'inactive'}/${session.sessionId}`
    );
  }

  private buildTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    const created = this.session.createdAt.toLocaleString();
    const modified = this.session.lastModified.toLocaleString();
    const size = this.formatSize(this.session.fileSizeBytes);

    md.appendMarkdown(`**${this.session.displayName}**\n\n`);
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`| | |\n|---|---|\n`);
    md.appendMarkdown(`| **Session ID** | \`${this.session.sessionId}\` |\n`);
    md.appendMarkdown(`| **Status** | ${this.session.isActive ? '🟢 Active' : '⚪ Inactive'} |\n`);
    md.appendMarkdown(`| **Created** | ${created} |\n`);
    md.appendMarkdown(`| **Last Modified** | ${modified} |\n`);
    md.appendMarkdown(`| **Context Size** | ${size} |\n`);
    md.appendMarkdown(`| **Messages** | ${this.session.messageCount} (👤${this.session.userMessageCount} / 🤖${this.session.assistantMessageCount}) |\n`);
    md.appendMarkdown(`| **Tool Calls** | ${this.session.toolCallCount} |\n`);
    md.appendMarkdown(`| **Version** | ${this.session.version || 'N/A'} |\n`);
    md.appendMarkdown(`| **Project** | ${this.session.projectDisplay} |\n`);
    md.appendMarkdown(`| **Machine** | ${this.session.machine} |\n`);
    if (this.session.source) {
      md.appendMarkdown(`| **Source** | ${this.session.source} |\n`);
    }
    if (this.session.firstMessage) {
      md.appendMarkdown(`\n---\n\n`);
      md.appendMarkdown(`**First Message:**\n\n${this.session.firstMessage}\n`);
    }

    return md;
  }

  private buildDescription(): string {
    const parts: string[] = [];

    if (this.session.isActive) {
      parts.push('$(pulse) Active');
    }

    const size = this.formatSize(this.session.fileSizeBytes);
    parts.push(size);

    parts.push(`${this.session.messageCount} msgs`);

    const timeAgo = this.timeAgo(this.session.lastModified);
    parts.push(timeAgo);

    return parts.join(' · ');
  }

  private getIcon(): vscode.ThemeIcon {
    if (this.session.isActive) {
      return new vscode.ThemeIcon('pulse', new vscode.ThemeColor('charts.green'));
    }
    return new vscode.ThemeIcon('comment-discussion');
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  private timeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) { return 'just now'; }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) { return `${minutes}m ago`; }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) { return `${hours}h ago`; }
    const days = Math.floor(hours / 24);
    if (days < 30) { return `${days}d ago`; }
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  }
}

class SessionDetailItem extends vscode.TreeItem {
  constructor(label: string, value: string, icon?: string) {
    super(`${label}: ${value}`, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon || 'info');
    this.contextValue = 'detail';
  }
}

export class SessionTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter();
  readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private parser: SessionParser;
  private sessions: SessionInfo[] = [];
  private projectFilter: string | undefined;
  // Group sessions by machine
  private machineGroups: Map<string, SessionInfo[]> = new Map();

  constructor(parser: SessionParser) {
    this.parser = parser;
  }

  refresh(): void {
    this.sessions = this.parser.getAllSessions(this.projectFilter);
    this.buildMachineGroups();
    this._onDidChangeTreeData.fire();
  }

  private buildMachineGroups(): void {
    this.machineGroups.clear();
    for (const session of this.sessions) {
      const machine = session.machine || 'Unknown';
      let group = this.machineGroups.get(machine);
      if (!group) {
        group = [];
        this.machineGroups.set(machine, group);
      }
      group.push(session);
    }
  }

  setProjectFilter(project: string | undefined): void {
    this.projectFilter = project;
    this.refresh();
  }

  getProjectFilter(): string | undefined {
    return this.projectFilter;
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
    if (!element) {
      // Root level
      if (this.sessions.length === 0) {
        this.sessions = this.parser.getAllSessions(this.projectFilter);
        this.buildMachineGroups();
      }

      if (this.sessions.length === 0) {
        const noSessions = new vscode.TreeItem('No sessions found');
        noSessions.iconPath = new vscode.ThemeIcon('info');
        return [noSessions];
      }

      // If only one machine, show sessions directly (no grouping)
      if (this.machineGroups.size <= 1) {
        return this.sessions.map(
          s => new SessionTreeItem(s, vscode.TreeItemCollapsibleState.Collapsed)
        );
      }

      // Multiple machines: show machine groups
      const items: MachineTreeItem[] = [];
      for (const [machine, sessions] of this.machineGroups) {
        const hasActive = sessions.some(s => s.isActive);
        items.push(new MachineTreeItem(machine, sessions.length, hasActive));
      }
      return items;
    }

    // Machine group -> show sessions
    if (element instanceof MachineTreeItem) {
      const sessions = this.machineGroups.get(element.machineName) || [];
      return sessions.map(
        s => new SessionTreeItem(s, vscode.TreeItemCollapsibleState.Collapsed)
      );
    }

    // Session -> show details
    if (element instanceof SessionTreeItem) {
      const s = element.session;
      const created = s.createdAt.toLocaleString();
      const modified = s.lastModified.toLocaleString();
      const size = this.formatSize(s.fileSizeBytes);

      return [
        new SessionDetailItem('Status', s.isActive ? 'Active' : 'Inactive', s.isActive ? 'pulse' : 'circle-outline'),
        new SessionDetailItem('Session ID', s.sessionId.substring(0, 16) + '...', 'key'),
        new SessionDetailItem('Created', created, 'calendar'),
        new SessionDetailItem('Last Modified', modified, 'history'),
        new SessionDetailItem('Context Size', size, 'database'),
        new SessionDetailItem('Messages', `${s.messageCount} (User: ${s.userMessageCount}, Assistant: ${s.assistantMessageCount})`, 'comment'),
        new SessionDetailItem('Tool Calls', `${s.toolCallCount}`, 'tools'),
        new SessionDetailItem('Version', s.version || 'N/A', 'versions'),
        new SessionDetailItem('Project', s.projectDisplay, 'folder'),
        new SessionDetailItem('Machine', s.machine, 'vm'),
        new SessionDetailItem('Source', s.source || 'Local', 'cloud'),
        new SessionDetailItem('First Message', s.firstMessage, 'quote'),
      ];
    }

    return [];
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}

export class SessionDecorationProvider implements vscode.FileDecorationProvider {
  private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'claude-session') {
      return undefined;
    }

    if (uri.path.startsWith('/active/')) {
      return {
        color: new vscode.ThemeColor('charts.green'),
        badge: '\u25CF', // ●
        tooltip: 'Active session',
      };
    }

    return undefined;
  }

  fireChange(): void {
    this._onDidChangeFileDecorations.fire(undefined);
  }
}
