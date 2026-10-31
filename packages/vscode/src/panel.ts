import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { FromWebview, ViewState } from './messages.ts';

/** The "Agents" sidebar view: a webview that renders the latest snapshot. */
export class AgentsView implements vscode.WebviewViewProvider {
  static readonly viewId = 'kvali.sessions';
  private view: vscode.WebviewView | undefined;
  private state: ViewState | undefined;
  private readonly extensionUri: vscode.Uri;
  private readonly onMessage: (m: FromWebview) => void;

  constructor(extensionUri: vscode.Uri, onMessage: (m: FromWebview) => void) {
    this.extensionUri = extensionUri;
    this.onMessage = onMessage;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const root = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    view.webview.html = this.html(view.webview, root);
    view.webview.onDidReceiveMessage((m: FromWebview) => {
      if (m?.type === 'ready') this.flush();
      this.onMessage(m);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) this.flush();
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  get visible(): boolean {
    return !!this.view?.visible;
  }

  post(state: ViewState): void {
    this.state = state;
    if (this.view?.visible) void this.view.webview.postMessage(state);
  }

  private flush(): void {
    if (this.state && this.view) void this.view.webview.postMessage(this.state);
  }

  private html(webview: vscode.Webview, root: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(root, 'main.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(root, 'main.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Kvali</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
