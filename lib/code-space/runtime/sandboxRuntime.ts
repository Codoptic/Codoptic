export type SandboxDenial = 'network' | 'path' | 'syscall';

export function classifySandboxError(message: string): SandboxDenial | null {
  if (/EPERM|EACCES|sandbox|seatbelt|landlock/i.test(message)) return 'syscall';
  if (/ENETUNREACH|ECONNREFUSED|network off|CONNECT 403/i.test(message)) return 'network';
  if (/outside workspace|path guard/i.test(message)) return 'path';
  return null;
}

export function formatSandboxDenied(kind: SandboxDenial, detail: string): string {
  return `SANDBOX_DENIED [${kind}]: ${detail}. Request elevated approval if this command is required.`;
}

export function sandboxEnabled(): boolean {
  return process.env.CODE_SPACE_SANDBOX === '1';
}

export function wrapSandboxedCommand(command: string, args: string[], root: string): { command: string; args: string[] } {
  if (!sandboxEnabled()) return { command, args };
  if (process.platform === 'darwin') {
    const profile = `(version 1)(allow default)(deny network*)(deny file-write* (regex "^/"))(allow file-write* (subpath "${root}"))`;
    return { command: 'sandbox-exec', args: ['-p', profile, command, ...args] };
  }
  return { command, args };
}
