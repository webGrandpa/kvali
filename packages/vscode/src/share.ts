import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { WeekStats } from '@kvali/core';
import type { FromShare } from './messages.ts';

/** Where a post may open: the networks the panel offers, nothing a message could slip in. */
const SHARE_HOSTS = new Set(['x.com', 'twitter.com', 'www.linkedin.com']);

/**
 * "Kvali: Share My Week": the week's counts as an image (wide or tall) to save or copy, and a
 * post to go with it. One panel; asking again shows it with fresh numbers.
 */
export class SharePanel {
  private static current: SharePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private stats: WeekStats;

  static show(extensionUri: vscode.Uri, stats: WeekStats): void {
    if (SharePanel.current) {
      SharePanel.current.stats = stats;
      SharePanel.current.panel.reveal(vscode.ViewColumn.Active);
      SharePanel.current.flush();
      return;
    }
    SharePanel.current = new SharePanel(extensionUri, stats);
  }

  private constructor(extensionUri: vscode.Uri, stats: WeekStats) {
    this.stats = stats;
    const root = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
    this.panel = vscode.window.createWebviewPanel('kvali.share', 'Kvali: Your Week', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [root],
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.png');
    this.panel.webview.html = this.html(root);
    this.panel.webview.onDidReceiveMessage((m: FromShare) => void this.onMessage(m));
    this.panel.onDidDispose(() => {
      SharePanel.current = undefined;
    });
  }

  private flush(): void {
    void this.panel.webview.postMessage({ type: 'stats', stats: this.stats });
  }

  private async onMessage(m: FromShare): Promise<void> {
    switch (m?.type) {
      case 'ready':
        this.flush();
        return;
      case 'save': {
        const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(m.dataUrl ?? '');
        if (!match) return;
        const downloads = path.join(os.homedir(), 'Downloads');
        const day = this.stats.days[this.stats.days.length - 1]?.day ?? 'week';
        const name = `kvali-week-${day}${m.format === 'portrait' ? '-tall' : ''}.png`;
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(existsSync(downloads) ? downloads : os.homedir(), name)),
          filters: { Images: ['png'] },
          saveLabel: 'Save image',
        });
        if (!target) return;
        await writeFile(target.fsPath, Buffer.from(match[1]!, 'base64'));
        const choice = await vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}.`, 'Show in folder');
        if (choice) await vscode.commands.executeCommand('revealFileInOS', target);
        return;
      }
      case 'copyText':
        if (typeof m.text === 'string' && m.text.length <= 3_000) {
          await vscode.env.clipboard.writeText(m.text);
          void vscode.window.setStatusBarMessage('Kvali: post text copied', 2_500);
        }
        return;
      case 'copyFailed':
        void vscode.window.showInformationMessage('This editor does not let a panel copy images. Save the PNG instead and attach it to your post.');
        return;
      case 'open': {
        let url: URL;
        try {
          url = new URL(m.url);
        } catch {
          return;
        }
        if (url.protocol === 'https:' && SHARE_HOSTS.has(url.host)) await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
        return;
      }
      default:
        return;
    }
  }

  private html(root: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(root, 'share.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(root, 'share.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data: blob:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Kvali: Your Week</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
