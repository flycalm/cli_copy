import * as crypto from "node:crypto";
import * as path from "node:path";
import { spawn } from "node:child_process";
import * as vscode from "vscode";

type ClipboardImageResult =
  | { kind: "image"; bytes: Uint8Array }
  | { kind: "not-image" }
  | { kind: "error"; message: string };

type MaterializedImage = {
  fileUri: vscode.Uri;
  remotePath: string;
  workspaceRelativePath: string;
  fileName: string;
};

type ExtensionConfig = {
  remoteDirectory: string;
  fileNameTemplate: string;
  insertTemplate: string;
  autoAddGitIgnore: boolean;
  maxFileSizeBytes: number;
  cleanupMaxFiles: number;
  cleanupMaxAgeDays: number;
  confirmBeforeUpload: boolean;
  outputChannelVerbose: boolean;
  shortcut: "ctrlShiftV" | "ctrlAltV" | "altV" | "none";
};

type RemoteTarget = {
  directoryUri: vscode.Uri;
  fileUri: vscode.Uri;
  remotePath: string;
  workspaceRelativePath: string;
  fileName: string;
};

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Remote Terminal Image Paste");
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand("remoteTerminalImagePaste.pasteImage", async () => {
      await runPaste(output);
    }),
    vscode.commands.registerCommand("remoteTerminalImagePaste.cleanupSavedImages", async () => {
      try {
        const config = getConfig();
        const workspaceFolder = getWorkspaceFolder();
        const target = buildRemoteTarget(config, workspaceFolder);
        const deleted = await cleanupRemoteDirectory(target.directoryUri, config, output);
        vscode.window.showInformationMessage(`Removed ${deleted} saved image file(s).`);
      } catch (error) {
        reportError(error, output);
      }
    }),
  );
}

export function deactivate(): void {}

async function runPaste(output: vscode.OutputChannel): Promise<void> {
  try {
    const config = getConfig();
    const terminal = getActiveTerminal();
    const workspaceFolder = getWorkspaceFolder();
    const clipboard = await readWindowsClipboardImageAsPng();

    if (clipboard.kind === "not-image") {
      await fallbackToDefaultPaste(output, "Clipboard did not contain an image.");
      return;
    }
    if (clipboard.kind === "error") {
      throw new Error(clipboard.message);
    }

    enforceSizeLimit(clipboard.bytes, config);

    if (config.confirmBeforeUpload) {
      const shouldContinue = await confirmUpload(clipboard.bytes.length);
      if (!shouldContinue) {
        return;
      }
    }

    const target = buildRemoteTarget(config, workspaceFolder);
    log(output, config, `Writing image to ${target.remotePath}`);

    await vscode.workspace.fs.createDirectory(target.directoryUri);
    await vscode.workspace.fs.writeFile(target.fileUri, clipboard.bytes);

    const materialized = toMaterialized(target);
    await postMaterializeHousekeeping(materialized, target, config, output, workspaceFolder);

    terminal.sendText(renderInsertText(config.insertTemplate, materialized), false);
    vscode.window.setStatusBarMessage(
      `Image pasted to remote path: ${materialized.workspaceRelativePath}`,
      3000,
    );
  } catch (error) {
    reportError(error, output);
  }
}

async function fallbackToDefaultPaste(
  output: vscode.OutputChannel,
  reason: string,
): Promise<void> {
  output.appendLine(`[fallback] ${reason}`);
  await vscode.commands.executeCommand("workbench.action.terminal.paste");
}

function getConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration("remoteTerminalImagePaste");
  return {
    remoteDirectory: config.get<string>("remoteDirectory", ".vscode-ai-images"),
    fileNameTemplate: config.get<string>("fileNameTemplate", "clip-{timestamp}.png"),
    insertTemplate: config.get<string>("insertTemplate", "{path}"),
    autoAddGitIgnore: config.get<boolean>("autoAddGitIgnore", true),
    maxFileSizeBytes: Math.round(config.get<number>("maxFileSizeMb", 20) * 1024 * 1024),
    cleanupMaxFiles: config.get<number>("cleanup.maxFiles", 30),
    cleanupMaxAgeDays: config.get<number>("cleanup.maxAgeDays", 14),
    confirmBeforeUpload: config.get<boolean>("confirmBeforeUpload", false),
    outputChannelVerbose: config.get<boolean>("outputChannelVerbose", true),
    shortcut: config.get<ExtensionConfig["shortcut"]>("shortcut", "ctrlAltV"),
  };
}

function getActiveTerminal(): vscode.Terminal {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    throw new Error("No active terminal. Focus a terminal and try again.");
  }
  return terminal;
}

function getWorkspaceFolder(): vscode.WorkspaceFolder {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error("No workspace folder open. Open the remote workspace before pasting.");
  }
  return workspaceFolder;
}

function enforceSizeLimit(bytes: Uint8Array, config: ExtensionConfig): void {
  if (bytes.length > config.maxFileSizeBytes) {
    throw new Error(
      `Clipboard image is ${formatBytes(bytes.length)} which exceeds the configured limit of ${formatBytes(config.maxFileSizeBytes)}.`,
    );
  }
}

async function confirmUpload(sizeBytes: number): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `Upload ${formatBytes(sizeBytes)} image to the remote workspace?`,
    { modal: true },
    "Upload",
  );
  return choice === "Upload";
}

function buildRemoteTarget(
  config: ExtensionConfig,
  workspaceFolder: vscode.WorkspaceFolder,
): RemoteTarget {
  const directoryUri = resolveRemoteDirectory(workspaceFolder.uri, config.remoteDirectory);
  const fileName = renderFileName(config.fileNameTemplate);
  const fileUri = vscode.Uri.joinPath(directoryUri, fileName);
  const remotePath = normalizeRemotePath(fileUri);
  const workspaceRelativePath = toWorkspaceRelativePath(fileUri, workspaceFolder.uri);
  return {
    directoryUri,
    fileUri,
    remotePath,
    workspaceRelativePath,
    fileName,
  };
}

function resolveRemoteDirectory(rootUri: vscode.Uri, configuredPath: string): vscode.Uri {
  if (path.posix.isAbsolute(configuredPath)) {
    return rootUri.with({ path: path.posix.normalize(configuredPath) });
  }
  return vscode.Uri.joinPath(rootUri, configuredPath);
}

function renderFileName(template: string): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const date = timestamp.slice(0, 10);
  const time = timestamp.slice(11, 19);
  const rendered = template
    .replaceAll("{timestamp}", timestamp)
    .replaceAll("{date}", date)
    .replaceAll("{time}", time)
    .replaceAll("{random}", crypto.randomBytes(4).toString("hex"));
  return rendered.endsWith(".png") ? rendered : `${rendered}.png`;
}

function normalizeRemotePath(uri: vscode.Uri): string {
  return uri.path;
}

function toWorkspaceRelativePath(fileUri: vscode.Uri, workspaceRoot: vscode.Uri): string {
  const relative = path.posix.relative(workspaceRoot.path, fileUri.path);
  return relative || path.posix.basename(fileUri.path);
}

function toMaterialized(target: RemoteTarget): MaterializedImage {
  return {
    fileUri: target.fileUri,
    remotePath: target.remotePath,
    workspaceRelativePath: target.workspaceRelativePath,
    fileName: target.fileName,
  };
}

async function postMaterializeHousekeeping(
  materialized: MaterializedImage,
  target: RemoteTarget,
  config: ExtensionConfig,
  output: vscode.OutputChannel,
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<void> {
  if (config.autoAddGitIgnore && isWithinWorkspace(target.directoryUri, workspaceFolder.uri)) {
    await ensureGitIgnoreEntry(target.directoryUri, workspaceFolder, output, config);
  }
  const deleted = await cleanupRemoteDirectory(target.directoryUri, config, output);
  if (deleted > 0) {
    log(output, config, `Cleanup removed ${deleted} stale file(s).`);
  }
  log(output, config, `Materialized ${materialized.remotePath}`);
}

async function ensureGitIgnoreEntry(
  directoryUri: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder,
  output: vscode.OutputChannel,
  config: ExtensionConfig,
): Promise<void> {
  const gitIgnoreUri = vscode.Uri.joinPath(workspaceFolder.uri, ".gitignore");
  const entry = buildGitIgnoreEntry(directoryUri, workspaceFolder.uri);

  let existing = "";
  try {
    const bytes = await vscode.workspace.fs.readFile(gitIgnoreUri);
    existing = Buffer.from(bytes).toString("utf8");
  } catch {
    existing = "";
  }

  const normalized = existing.split(/\r?\n/).map((line) => line.trim());
  if (normalized.includes(entry)) {
    return;
  }

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const nextContent = `${existing}${prefix}${entry}\n`;
  await vscode.workspace.fs.writeFile(gitIgnoreUri, Buffer.from(nextContent, "utf8"));
  log(output, config, `Added ${entry} to remote .gitignore`);
}

function buildGitIgnoreEntry(directoryUri: vscode.Uri, workspaceRoot: vscode.Uri): string {
  const relative = toWorkspaceRelativePath(directoryUri, workspaceRoot).replace(/\\/g, "/");
  return `/${relative.replace(/\/$/, "")}/`;
}

function isWithinWorkspace(targetUri: vscode.Uri, workspaceRoot: vscode.Uri): boolean {
  const relative = path.posix.relative(workspaceRoot.path, targetUri.path);
  return relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative);
}

async function cleanupRemoteDirectory(
  directoryUri: vscode.Uri,
  config: ExtensionConfig,
  output: vscode.OutputChannel,
): Promise<number> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(directoryUri);
  } catch {
    return 0;
  }

  const fileStats: Array<{ uri: vscode.Uri; mtime: number }> = [];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File) {
      continue;
    }
    const uri = vscode.Uri.joinPath(directoryUri, name);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      fileStats.push({ uri, mtime: stat.mtime });
    } catch {
      continue;
    }
  }

  fileStats.sort((left, right) => right.mtime - left.mtime);
  const toDelete = new Set<string>();

  if (config.cleanupMaxFiles > 0 && fileStats.length > config.cleanupMaxFiles) {
    for (const item of fileStats.slice(config.cleanupMaxFiles)) {
      toDelete.add(item.uri.toString());
    }
  }

  if (config.cleanupMaxAgeDays > 0) {
    const cutoff = Date.now() - config.cleanupMaxAgeDays * 24 * 60 * 60 * 1000;
    for (const item of fileStats) {
      if (item.mtime < cutoff) {
        toDelete.add(item.uri.toString());
      }
    }
  }

  let deleted = 0;
  for (const id of toDelete) {
    await vscode.workspace.fs.delete(vscode.Uri.parse(id), { useTrash: false });
    deleted += 1;
  }

  if (deleted > 0) {
    log(output, config, `Deleted ${deleted} stale remote image(s) in ${directoryUri.path}`);
  }
  return deleted;
}

function renderInsertText(template: string, image: MaterializedImage): string {
  return fillPlaceholders(template, {
    path: image.remotePath,
    quotedPath: shellQuote(image.remotePath),
    workspaceRelativePath: image.workspaceRelativePath,
    fileName: image.fileName,
  });
}

function fillPlaceholders(template: string, values: Record<string, string>): string {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{${key}}`, value);
  }
  return rendered;
}

async function readWindowsClipboardImageAsPng(): Promise<ClipboardImageResult> {
  if (process.platform !== "win32") {
    return {
      kind: "error",
      message: "Image clipboard capture is implemented with Windows PowerShell and only works on Windows.",
    };
  }

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    "  Add-Type -AssemblyName System.Drawing | Out-Null",
    "  $img = Get-Clipboard -Format Image",
    "  if ($null -eq $img) { [Console]::Out.Write('NO_IMAGE'); exit 0 }",
    "  $ms = New-Object System.IO.MemoryStream",
    "  $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
    "  $b64 = [Convert]::ToBase64String($ms.ToArray())",
    "  [Console]::Out.Write('OK:' + $b64)",
    "} catch {",
    "  [Console]::Out.Write('ERR:' + $_.Exception.Message)",
    "}",
  ].join("; ");

  const output = await captureProcessOutput("powershell.exe", [
    "-NoProfile",
    "-Sta",
    "-Command",
    script,
  ]);

  if (output.startsWith("OK:")) {
    return {
      kind: "image",
      bytes: Uint8Array.from(Buffer.from(output.slice(3), "base64")),
    };
  }
  if (output.startsWith("NO_IMAGE")) {
    return { kind: "not-image" };
  }
  if (output.startsWith("ERR:")) {
    return {
      kind: "error",
      message: `PowerShell clipboard read failed: ${output.slice(4).trim()}`,
    };
  }
  return { kind: "error", message: "Unexpected PowerShell output while reading the clipboard." };
}

function captureProcessOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

function reportError(error: unknown, output: vscode.OutputChannel): void {
  const message = error instanceof Error ? error.message : String(error);
  output.appendLine(`[error] ${message}`);
  void vscode.window.showErrorMessage(message);
}

function log(output: vscode.OutputChannel, config: ExtensionConfig, message: string): void {
  if (!config.outputChannelVerbose) {
    return;
  }
  output.appendLine(message);
}

function shellQuote(input: string): string {
  return `'${input.replace(/'/g, `'\\''`)}'`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
