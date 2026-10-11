import { spawn } from 'node:child_process';

// Best-effort browser open. Falls back to printing URL on failure.
export function openBrowser(url: string): boolean {
  const platform = process.platform;
  let command: string;
  let args: string[];

  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    // `start ""` so Windows treats next arg as URL, not window title
    args = ['/c', 'start', '""', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    child.on('error', () => {
      // ignore — caller will see false and print URL
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
