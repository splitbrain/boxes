import { config, type Config } from './config.ts';
import { dockerFileAccess } from './fileaccess/docker-fileaccess.ts';
import { kubernetesFileAccess } from './fileaccess/kubernetes-fileaccess.ts';
import type { FileAccess } from './fileaccess/types.ts';

/**
 * Contained file access for the deployment's own runtime: a box's
 * workspace and home read and written directly for Docker, over its pod's
 * exec for Kubernetes. See runtime.ts, whose own singleton this mirrors.
 */
let forTests: FileAccess | null = null;

export function fileAccess(cfg: Config = config()): FileAccess {
  if (forTests) return forTests;
  return cfg.RUNTIME === 'kubernetes' ? kubernetesFileAccess(cfg) : dockerFileAccess(cfg);
}

/** Test seam: install a FileAccess, or null to go back to the real one. */
export function setFileAccessForTests(f: FileAccess | null): void {
  forTests = f;
}
