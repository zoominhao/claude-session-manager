import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SessionParser, SessionSource } from './sessionParser';
import { SessionTreeProvider, SessionTreeItem, SessionDecorationProvider } from './sessionTreeProvider';
import { SyncService } from './sync/SyncService';
import { registerSyncCommands } from './sync/SyncCommands';

let fileWatchers: fs.FSWatcher[] = [];
let autoRefreshTimer: ReturnType<typeof setInterval> | undefined;

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('claudeSessionManager');
  const sources = config.get<SessionSource[]>('claudeDirs') || [];

  const parser = new SessionParser(sources);
  const treeProvider = new SessionTreeProvider(parser);

  const decorationProvider = new SessionDecorationProvider();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorationProvider)
  );

  // Initialize sync service
  const syncService = new SyncService(context, parser);
  context.subscriptions.push(syncService);

  // Add WebDAV cached hosts as runtime sources (skip current machine - already loaded from local)
  const syncCacheDir = syncService.getCacheDir();
  const hostsDir = path.join(syncCacheDir, 'hosts');
  const currentHostname = require('os').hostname();
  const addCachedHosts = () => {
    if (!fs.existsSync(hostsDir)) { return; }
    try {
      const hostDirs = fs.readdirSync(hostsDir).filter(d =>
        fs.statSync(path.join(hostsDir, d)).isDirectory()
      );
      const machinesDir = syncService.getMachineDescriptorsDir();
      for (const host of hostDirs) {
        if (host === currentHostname) { continue; }
        // Read machine descriptor for name/platform
        let name: string | undefined;
        let platform: string | undefined;
        const descPath = path.join(machinesDir, `${host}.json`);
        if (fs.existsSync(descPath)) {
          try {
            const desc = JSON.parse(fs.readFileSync(descPath, 'utf-8'));
            name = desc.name;
            platform = desc.platform;
          } catch { /* skip */ }
        }
        parser.addRuntimeSource(path.join(hostsDir, host), `WebDAV (${host})`, name, platform);
      }
    } catch { /* skip */ }
  };
  addCachedHosts();

  // Point parser to machine descriptors directory for auto-detection
  parser.setMachineDescriptorsDir(syncService.getMachineDescriptorsDir());

  // Register sync commands
  registerSyncCommands(context, syncService, treeProvider, parser);

  const treeView = vscode.window.createTreeView('claudeSessionsView', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  // Initial load
  treeProvider.refresh();

  // Auto-refresh
  const refreshInterval = config.get<number>('autoRefreshInterval') || 10;
  if (refreshInterval > 0) {
    autoRefreshTimer = setInterval(() => {
      treeProvider.refresh();
      decorationProvider.fireChange();
    }, refreshInterval * 1000);
  }

  // Watch for file changes in all source projects directories
  for (const { dir } of parser.getClaudeDirs()) {
    const projectsDir = path.join(dir, 'projects');
    if (fs.existsSync(projectsDir)) {
      try {
        const watcher = fs.watch(projectsDir, { recursive: true }, () => {
          setTimeout(() => treeProvider.refresh(), 500);
        });
        fileWatchers.push(watcher);
      } catch {
        // fs.watch may not work on all platforms
      }
    }
  }

  // Startup sync
  const syncConfig = vscode.workspace.getConfiguration('claudeSessionManager.sync');
  if (syncConfig.get<boolean>('enabled') && syncConfig.get<boolean>('syncOnStartup', true)) {
    syncService.initialize().then(() => {
      syncService.syncNow().then(() => {
        parser.reloadCustomNames();
        treeProvider.refresh();
      }).catch(() => { /* startup sync failure is non-fatal */ });
    });
  }

  // Auto-sync timer
  const autoSyncInterval = syncConfig.get<number>('autoSyncInterval') || 300;
  if (syncConfig.get<boolean>('enabled') && autoSyncInterval > 0) {
    syncService.initialize().then(() => {
      syncService.startAutoSync(Math.max(autoSyncInterval, 60));
    });
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSessions.refresh', () => {
      treeProvider.refresh();
      decorationProvider.fireChange();
      vscode.window.setStatusBarMessage('Claude sessions refreshed', 2000);
    }),

    vscode.commands.registerCommand('claudeSessions.rename', async (item: SessionTreeItem) => {
      if (!item?.session) { return; }

      const newName = await vscode.window.showInputBox({
        prompt: 'Enter new session name',
        value: item.session.displayName,
        placeHolder: 'Session name',
      });

      if (newName !== undefined && newName.trim()) {
        parser.saveCustomName(item.session.sessionId, newName.trim());
        treeProvider.refresh();
        vscode.window.setStatusBarMessage(`Session renamed to "${newName.trim()}"`, 2000);
      }
    }),

    vscode.commands.registerCommand('claudeSessions.copyId', (item: SessionTreeItem) => {
      if (!item?.session) { return; }
      vscode.env.clipboard.writeText(item.session.sessionId);
      vscode.window.setStatusBarMessage('Session ID copied to clipboard', 2000);
    }),

    vscode.commands.registerCommand('claudeSessions.openFile', (item: SessionTreeItem) => {
      if (!item?.session) { return; }
      vscode.window.showTextDocument(vscode.Uri.file(item.session.filePath));
    }),

    vscode.commands.registerCommand('claudeSessions.resume', (item: SessionTreeItem) => {
      if (!item?.session) { return; }

      const session = item.session;
      const cacheDir = syncService.getCacheDir();

      // If session file is in WebDAV cache (from another machine),
      // copy it to a local project dir so Claude CLI can find it
      if (session.filePath.startsWith(cacheDir)) {
        const localClaudeDirs = parser.getClaudeDirs().filter(d => d.dir !== cacheDir);
        if (localClaudeDirs.length > 0) {
          const localDir = localClaudeDirs[0].dir;
          // Find or create a local project dir
          const localProjectsDir = path.join(localDir, 'projects');
          if (fs.existsSync(localProjectsDir)) {
            const localProjectDirs = fs.readdirSync(localProjectsDir)
              .filter(d => fs.statSync(path.join(localProjectsDir, d)).isDirectory() && !d.startsWith('.'));
            if (localProjectDirs.length > 0) {
              const targetDir = path.join(localProjectsDir, localProjectDirs[0]);
              const targetFile = path.join(targetDir, `${session.sessionId}.jsonl`);
              if (!fs.existsSync(targetFile)) {
                fs.copyFileSync(session.filePath, targetFile);
              }
            }
          }
        }
      }

      const terminal = vscode.window.createTerminal({
        name: `Claude: ${session.displayName}`,
      });
      terminal.show();
      terminal.sendText(`claude --resume ${session.sessionId}`);
    }),

    vscode.commands.registerCommand('claudeSessions.delete', async (item: SessionTreeItem) => {
      if (!item?.session) { return; }

      if (item.session.isActive) {
        vscode.window.showWarningMessage('Cannot delete an active session.');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Delete session "${item.session.displayName}"? This cannot be undone.`,
        { modal: true },
        'Delete'
      );

      if (confirm === 'Delete') {
        try {
          parser.deleteSession(item.session.sessionId, item.session.filePath);
          // Also delete from remote if sync is configured
          if (syncService.isConfigured()) {
            await syncService.deleteRemote(item.session.filePath);
          }
          treeProvider.refresh();
          vscode.window.setStatusBarMessage('Session deleted', 2000);
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to delete session: ${err}`);
        }
      }
    }),

    vscode.commands.registerCommand('claudeSessions.filterProject', async () => {
      const projects = parser.getProjectNames();
      const currentFilter = treeProvider.getProjectFilter();

      const items: vscode.QuickPickItem[] = [
        {
          label: 'All Projects',
          description: !currentFilter ? '(current)' : undefined,
        },
        ...projects.map(p => ({
          label: p,
          description: p === currentFilter ? '(current)' : undefined,
        })),
      ];

      const selection = await vscode.window.showQuickPick(items, {
        placeHolder: 'Filter sessions by project',
      });

      if (selection) {
        const filter = selection.label === 'All Projects' ? undefined : selection.label;
        treeProvider.setProjectFilter(filter);
      }
    }),

    treeView,
  );
}

export function deactivate() {
  for (const w of fileWatchers) {
    w.close();
  }
  fileWatchers = [];
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = undefined;
  }
}
