import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { GatewayConfig } from '../gateway/config.js';

export interface RuntimePaths {
  root: string;
  config: string;
  actions: {
    root: string;
    pending: string;
    running: string;
    completed: string;
    paused: string;
    unknown: string;
  };
  payloads: string;
  approvals: string;
  locks: string;
  audit: string;
  diagnostics: string;
}

export async function resolveRuntimePaths(config: GatewayConfig): Promise<RuntimePaths> {
  const workspaceRoot = path.resolve(config.workspace_root);
  const root = path.isAbsolute(config.runtime_dir)
    ? path.resolve(config.runtime_dir)
    : path.resolve(workspaceRoot, config.runtime_dir);
  if (!validatePath(root, [workspaceRoot])) {
    throw new Error('runtime_dir 必须位于 workspace_root 内部');
  }
  const actionsRoot = path.join(root, 'actions');

  return {
    root,
    config: path.join(root, 'config'),
    actions: {
      root: actionsRoot,
      pending: path.join(actionsRoot, 'pending'),
      running: path.join(actionsRoot, 'running'),
      completed: path.join(actionsRoot, 'completed'),
      paused: path.join(actionsRoot, 'paused'),
      unknown: path.join(actionsRoot, 'unknown'),
    },
    payloads: path.join(root, 'payloads'),
    approvals: path.join(root, 'approvals'),
    locks: path.join(root, 'locks'),
    audit: path.join(root, 'audit'),
    diagnostics: path.join(root, 'diagnostics'),
  };
}

export async function ensureRuntimeDirs(paths: RuntimePaths): Promise<void> {
  const dirs = [
    paths.root,
    paths.config,
    paths.actions.root,
    paths.actions.pending,
    paths.actions.running,
    paths.actions.completed,
    paths.actions.paused,
    paths.actions.unknown,
    paths.payloads,
    paths.approvals,
    paths.locks,
    paths.audit,
    paths.diagnostics,
  ];
  await Promise.all(dirs.map((dir) => fs.mkdir(dir, { recursive: true })));
}

/** Resolve first, then enforce directory containment. Prefix-string checks are unsafe (`/safe/a2`). */
export function validatePath(candidatePath: string, allowedRoots: string[]): boolean {
  const candidate = path.resolve(candidatePath);
  return allowedRoots.some((rootPath) => {
    const root = path.resolve(rootPath);
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}
