import type { DeploymentImages, ImageInfo } from '../../shared/types.ts';
import type { Config } from './config.ts';
import * as dk from './docker.ts';
import { log } from './log.ts';

/**
 * Which build of each of the deployment's three images is running here.
 *
 * A deployment that follows `latest` moves when a watchtower says so rather
 * than when a person does. Each image is reached differently: the
 * orchestrator's own is whatever its container was created from, the proxy's
 * is whatever the container named by EGRESS_PROXY_CONTAINER was created from,
 * and the session image is named by SESSION_IMAGE outright, so no container
 * has to exist for it.
 */

/** How long one reading is served before the daemon is asked again, in ms. */
const CACHE_MS = 60_000;

/** The last reading and when it was taken, or null before the first. */
let cached: { at: number; images: DeploymentImages } | null = null;

/** Test seam: forget the cached reading. */
export function resetImagesForTests(): void {
  cached = null;
}

/**
 * One image's reading, or null where anything went wrong.
 *
 * Absence is a legitimate answer: a proxy container that is not up, a session
 * image not pulled yet, an orchestrator running from a checkout rather than a
 * container, a daemon that cannot be reached. Logged at debug, because on a
 * deployment where this cannot work it would otherwise be a line a minute.
 */
async function safely(
  what: string,
  read: () => Promise<ImageInfo | null>,
): Promise<ImageInfo | null> {
  try {
    return await read();
  } catch (err) {
    log.debug('could not read an image', { what, error: (err as Error).message });
    return null;
  }
}

/** The image behind a container, by container name or id. */
async function imageOfContainer(container: string | null): Promise<ImageInfo | null> {
  if (!container) return null;
  const id = await dk.containerImageId(container);
  return id ? dk.imageInfo(id) : null;
}

/**
 * All three images, from a short-lived cache.
 *
 * Cached because the health probe this hangs off is polled by every open tab,
 * and nothing moves one of these but a registry pull.
 */
export async function deploymentImages(cfg: Config): Promise<DeploymentImages> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.images;

  const [orchestrator, proxy, session] = await Promise.all([
    safely('orchestrator', () => imageOfContainer(dk.selfContainerId())),
    safely('proxy', () => imageOfContainer(cfg.EGRESS_PROXY_CONTAINER)),
    safely('session', () => dk.imageInfo(cfg.SESSION_IMAGE)),
  ]);

  cached = { at: now, images: { orchestrator, proxy, session } };
  return cached.images;
}
