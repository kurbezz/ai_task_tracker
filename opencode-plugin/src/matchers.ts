export function isCommitCommand(command: string): boolean {
  return /(^|&&|;|\|)\s*git\s+commit\b/.test(command);
}

export function isPushOrPrCommand(command: string): boolean {
  return (
    /(^|&&|;|\|)\s*git\s+push\b/.test(command) ||
    /(^|&&|;|\|)\s*gh\s+pr\s+create\b/.test(command) ||
    /(^|&&|;|\|)\s*glab\s+mr\s+create\b/.test(command)
  );
}

export function isDeployCommand(command: string): boolean {
  return (
    /\bdeploy(ed)?\b/i.test(command) ||
    /(^|&&|;|\|)\s*docker\s+push\b/.test(command) ||
    /(^|&&|;|\|)\s*(flyctl|fly)\s+deploy\b/.test(command) ||
    /(^|&&|;|\|)\s*vercel\b.*--prod\b/.test(command) ||
    /(^|&&|;|\|)\s*railway\s+up\b/.test(command) ||
    /(^|&&|;|\|)\s*kubectl\s+(apply|rollout)\b/.test(command)
  );
}

export function isPlanOrSpecPath(path: string): boolean {
  return /docs\/.*\/(specs|plans)\/[^/]+\.md$/.test(path);
}

export function extractTrackerToolName(toolId: string): string | null {
  const match = /task[-_]tracker[-_](.+)$/i.exec(toolId);
  return match ? match[1].toLowerCase() : null;
}

export function toolNameIncludes(toolId: string, needle: string): boolean {
  return toolId.toLowerCase().includes(needle.toLowerCase());
}
