import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { loadConfig, type Config } from './config.ts';
import * as dk from './docker.ts';
import { deploymentImages, resetImagesForTests } from './images.ts';

/**
 * Which build of each image a deployment is running.
 *
 * The orchestrator's own entry is reached exactly as the proxy's is — the
 * image behind a container — differing only in that the container is found by
 * reading this process's own cgroup rather than by name, so the cases below
 * exercise it through the proxy.
 */

const SESSION_IMAGE = 'ghcr.io/example/boxes/session:latest';
const PROXY_CONTAINER = 'boxes-egress-proxy';

/** An inspect answer, as the daemon shapes one. */
interface FakeImage {
  Id: string;
  RepoDigests?: string[];
  Created?: string;
  Size?: number;
}

/** The daemon this suite pretends to talk to. */
interface Fake {
  /** Image reference — a tag or an id — to what inspecting it answers. */
  images: Map<string, FakeImage>;
  /** Container name to the image id it was created from. */
  containers: Map<string, string>;
  /** Every image reference inspected, in order, so the cache can be seen. */
  inspected: string[];
}

let fake: Fake;
let dirs: string[] = [];

function notFound(what: string): Error {
  return Object.assign(new Error(`no such ${what}`), { statusCode: 404 });
}

function install(): void {
  dk.setDockerForTests({
    getImage: (name: string) => ({
      inspect: async () => {
        fake.inspected.push(name);
        const image = fake.images.get(name);
        if (!image) throw notFound('image');
        return image;
      },
    }),
    getContainer: (name: string) => ({
      inspect: async () => {
        const image = fake.containers.get(name);
        if (!image) throw notFound('container');
        return { Image: image };
      },
    }),
  } as unknown as Docker);
}

/** A config pointed at the fake's two names, over a throwaway data directory. */
function cfg(): Config {
  const dir = mkdtempSync(join(tmpdir(), 'boxes-images-'));
  dirs.push(dir);
  return loadConfig({
    DATA_DIR: dir,
    SESSION_IMAGE,
    EGRESS_PROXY_CONTAINER: PROXY_CONTAINER,
  });
}

beforeEach(() => {
  fake = { images: new Map(), containers: new Map(), inspected: [] };
  install();
  resetImagesForTests();
});

afterEach(() => {
  dk.setDockerForTests(null);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('deploymentImages', () => {
  it('reports the registry digest of a pulled image, not the local id', async () => {
    fake.images.set(SESSION_IMAGE, {
      Id: 'sha256:localconfigid',
      RepoDigests: [`${SESSION_IMAGE.split(':')[0]}@sha256:published`],
      Created: '2026-08-12T22:40:00Z',
      Size: 4_509_715_661,
    });

    const images = await deploymentImages(cfg());

    // The digest the tag was published under is what a deployment following
    // that tag can compare against; the config id means nothing off this host.
    assert.deepEqual(images.session, {
      digest: 'sha256:published',
      builtAt: Date.parse('2026-08-12T22:40:00Z'),
      sizeBytes: 4_509_715_661,
    });
  });

  it('falls back to the local id for an image built on this host', async () => {
    // What `docker compose build` leaves: a real image that has never been in
    // a registry, so there is no manifest digest to report.
    fake.images.set(SESSION_IMAGE, {
      Id: 'sha256:builthere',
      RepoDigests: [],
      Created: '2026-08-12T22:40:00Z',
    });

    const images = await deploymentImages(cfg());

    assert.equal(images.session?.digest, 'sha256:builthere');
  });

  it('reads the proxy image through the container it is running as', async () => {
    fake.containers.set(PROXY_CONTAINER, 'sha256:proxyimage');
    fake.images.set('sha256:proxyimage', {
      Id: 'sha256:proxyimage',
      RepoDigests: ['ghcr.io/example/boxes/egress-proxy@sha256:proxypublished'],
      Created: '2026-08-30T09:15:00Z',
      Size: 188_743_680,
    });

    const images = await deploymentImages(cfg());

    assert.deepEqual(images.proxy, {
      digest: 'sha256:proxypublished',
      builtAt: Date.parse('2026-08-30T09:15:00Z'),
      sizeBytes: 188_743_680,
    });
  });

  it('says nothing for an image the daemon does not have', async () => {
    const images = await deploymentImages(cfg());

    // Every one of these is a legitimate state: no proxy container up, and a
    // session image not pulled yet.
    assert.equal(images.proxy, null);
    assert.equal(images.session, null);
  });

  it('says nothing rather than failing when the daemon is unwell', async () => {
    dk.setDockerForTests({
      getImage: () => ({
        inspect: async () => {
          throw Object.assign(new Error('daemon is down'), { statusCode: 500 });
        },
      }),
      getContainer: () => ({
        inspect: async () => {
          throw new Error('connect ENOENT /var/run/docker.sock');
        },
      }),
    } as unknown as Docker);

    // The health probe this hangs off must still answer, so a footer with
    // nothing in it is the whole of the failure.
    const images = await deploymentImages(cfg());

    assert.deepEqual(images, { orchestrator: null, proxy: null, session: null });
  });

  it('reports no build date and no size rather than what cannot be rendered', async () => {
    // A NaN date and an absent size both serialize to null over JSON anyway;
    // saying so here is what keeps the type honest about it.
    fake.images.set(SESSION_IMAGE, { Id: 'sha256:nodate', Created: '' });

    const images = await deploymentImages(cfg());

    assert.equal(images.session?.builtAt, null);
    assert.equal(images.session?.sizeBytes, null);
  });

  it('asks the daemon once for a run of calls', async () => {
    fake.images.set(SESSION_IMAGE, { Id: 'sha256:one', Created: '2026-08-12T22:40:00Z' });
    const config = cfg();

    await deploymentImages(config);
    const first = fake.inspected.length;
    await deploymentImages(config);

    // The probe this answers is polled by every open tab, and none of these
    // move often enough to be worth an inspect apiece.
    assert.equal(fake.inspected.length, first);
  });
});
