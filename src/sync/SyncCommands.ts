import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SyncService, SyncStatus } from './SyncService';
import { SessionTreeProvider } from '../sessionTreeProvider';
import { SessionParser } from '../sessionParser';

export function registerSyncCommands(
  context: vscode.ExtensionContext,
  syncService: SyncService,
  treeProvider: SessionTreeProvider,
  parser: SessionParser,
): void {
  const currentHostname = os.hostname();

  const refreshHostSources = () => {
    const hostsDir = path.join(syncService.getCacheDir(), 'hosts');
    const machinesDir = syncService.getMachineDescriptorsDir();
    parser.setMachineDescriptorsDir(machinesDir);
    if (fs.existsSync(hostsDir)) {
      try {
        const hostDirs = fs.readdirSync(hostsDir).filter(d =>
          fs.statSync(path.join(hostsDir, d)).isDirectory()
        );
        for (const host of hostDirs) {
          if (host === currentHostname) { continue; }
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
    }
  };

  // Configure sync
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSessions.syncConfigure', async () => {
      const success = await syncService.configure();
      if (success) {
        await syncService.syncNow();
        refreshHostSources();
        parser.reloadCustomNames();
        treeProvider.refresh();
      }
    })
  );

  // Sync now
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSessions.syncNow', async () => {
      await syncService.syncNow();
      refreshHostSources();
      parser.reloadCustomNames();
      treeProvider.refresh();
    })
  );

  // Status bar item
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right, 100
  );
  statusBarItem.command = 'claudeSessions.syncNow';
  context.subscriptions.push(statusBarItem);

  syncService.onStatusChange((status) => {
    switch (status) {
      case SyncStatus.Idle:
        statusBarItem.text = '$(cloud) Sessions Synced';
        statusBarItem.tooltip = 'Click to sync Claude sessions now';
        statusBarItem.show();
        break;
      case SyncStatus.Syncing:
        statusBarItem.text = '$(sync~spin) Syncing Sessions...';
        statusBarItem.tooltip = 'Sync in progress...';
        statusBarItem.show();
        break;
      case SyncStatus.Error:
        statusBarItem.text = '$(cloud-offline) Sync Error';
        statusBarItem.tooltip = 'Last sync failed. Click to retry.';
        statusBarItem.show();
        break;
      case SyncStatus.Disabled:
        statusBarItem.hide();
        break;
    }
  });
}
