import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import { afterEach, beforeEach, describe, it } from 'vitest';
import { buildApp, type Orchestrator } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb, type Db } from './db.ts';
import * as dk from './docker.ts';

/**
 * Keeping a session on the current session image.
 *
 * The orchestrator creates session containers, so nothing outside it may
 * recreate one — the id in the database and the runtime proxy attachment
 * would both be lost. Moving a session onto a new image is therefore the
 * orchestrator's own job, and start is the only moment it is safe: under a
 * running container it would kill the adapter exec mid-turn.
 */

const IMAGE = 'ghcr.io/example/session:latest';

/** The daemon this suite pretends to talk to. */
interface Fake {
  /** Image reference to the id it currently resolves to. */
  images: Map<string, string>;
  /**
   * Container id to the image id it was created from, whether it runs, and
   * the destinations it has mounts at — which the start path asks about, to
   * recognise a container from before a mount existed.
   */
  containers: Map<string, { image: string; running: boolean; mounts: string[] }>;
  created: Array<Record<string, unknown>>;
  removed: string[];
  pulled: string[];
  /**
   * Image ids on the host that carry no tag, and the label each was built
   * with. A pull that moves the tag puts the id it moved off in here, the way
   * the daemon does.
   */
  untagged: Map<string, Record<string, string>>;
  /** Image ids a container still uses, which the daemon refuses to remove. */
  imagesInUse: Set<string>;
  /** Image ids removed, in the order they went. */
  imagesRemoved: string[];
  /** What a pull does to `images`, which is how a tag moves in a test. */
  onPull?: (image: string) => void;
  next: number;
}

function notFound(what: string): Error {
  return Object.assign(new Error(`no such ${what}`), { statusCode: 404 });
}

function install(fake: Fake): void {
  dk.setDockerForTests({
    getImage: (name: string) => ({
      inspect: async () => {
        const id = fake.images.get(name);
        if (!id) throw notFound('image');
        return { Id: id };
      },
      remove: async () => {
        if (fake.imagesInUse.has(name)) {
          throw Object.assign(new Error('image is in use'), { statusCode: 409 });
        }
        if (!fake.untagged.delete(name)) throw notFound('image');
        fake.imagesRemoved.push(name);
      },
    }),
    listImages: async (opts: { filters?: { label?: string[] } }) => {
      const wanted = opts.filters?.label ?? [];
      return [...fake.untagged]
        .filter(([, labels]) =>
          wanted.every((l) => {
            const [key, value] = l.split('=');
            return labels[key ?? ''] === value;
          }),
        )
        .map(([Id]) => ({ Id, RepoTags: [] }));
    },
    getContainer: (id: string) => ({
      inspect: async () => {
        const c = fake.containers.get(id);
        if (!c) throw notFound('container');
        return {
          Image: c.image,
          State: { Running: c.running },
          Mounts: c.mounts.map((Destination) => ({ Destination })),
        };
      },
      start: async () => {
        const c = fake.containers.get(id);
        if (c) c.running = true;
      },
      stop: async () => {
        const c = fake.containers.get(id);
        if (c) c.running = false;
      },
      remove: async () => {
        fake.removed.push(id);
        fake.containers.delete(id);
      },
    }),
    createContainer: async (opts: Record<string, unknown>) => {
      fake.created.push(opts);
      const id = `container-${++fake.next}`;
      const binds = (opts['HostConfig'] as { Binds?: string[] } | undefined)?.Binds ?? [];
      fake.containers.set(id, {
        image: fake.images.get(opts['Image'] as string) ?? 'unresolved',
        running: false,
        // A container's mounts come from what it was created with, so the
        // daemon reports back whatever containerSpec asked for.
        mounts: binds.map((bind) => bind.split(':')[1] ?? ''),
      });
      return { id };
    },
    pull: async (image: string) => {
      fake.pulled.push(image);
      fake.onPull?.(image);
      return new PassThrough();
    },
    // Networks are not this suite's subject, and every call the start path
    // makes on one already tolerates a daemon that says no.
    getNetwork: () => ({
      inspect: async () => {
        throw notFound('network');
      },
    }),
    modem: {
      followProgress: (
        _stream: NodeJS.ReadableStream,
        onFinished: (err: Error | null, out: unknown[]) => void,
      ) => onFinished(null, []),
    },
  } as unknown as Docker);
}

let dir: string;
let db: Db;
let orchestrator: Orchestrator;
let fake: Fake;

/** A stopped, directory-backed session with a container on `imageId`. */
function insertSession(id: string, containerId: string, imageId: string): void {
  const now = Date.now();
  fake.containers.set(containerId, {
    image: imageId,
    running: false,
    // Every mount a container created today has. What this suite is about is
    // the image moving under a session, not a container from before a mount
    // existed — sessions.ts has its own path for that.
    mounts: [dk.WORKSPACE_DIR, '/home/agent', dk.AGENT_CONFIG_DIR],
  });
  db.prepare(
    `INSERT INTO sessions (id, name, profile, image, agent_cmd, container_id,
       network_name, subnet, ws_volume, home_volume, workspace_dir, status,
       current_thread_id, created_at, last_active_at)
     VALUES (?, 'test', 'DEFAULT', ?, '["claude-agent-acp"]', ?,
       ?, '10.200.0.0/24', '', ?, ?, 'stopped', NULL, ?, ?)`,
  ).run(id, IMAGE, containerId, `sn-${id}`, `home-${id}`, `${dir}/workspaces/${id}`, now, now);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'boxes-image-'));
  fake = {
    images: new Map([[IMAGE, 'sha256:one']]),
    containers: new Map(),
    created: [],
    removed: [],
    pulled: [],
    untagged: new Map(),
    imagesInUse: new Set(),
    imagesRemoved: [],
    next: 0,
  };
  install(fake);
  db = openDb(dir);
  orchestrator = buildApp(loadConfig({ DATA_DIR: dir, SESSION_IMAGE: IMAGE }), db);
  await orchestrator.egress.prepare();
});

afterEach(async () => {
  await orchestrator.app.close();
  db.close();
  dk.setDockerForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('starting a session whose image has moved', () => {
  it('recreates the container on what the tag now resolves to', async () => {
    insertSession('a1', 'c1', 'sha256:one');
    // The tag did not change; what it points at did. That is the whole case
    // this exists for, and comparing tags would miss it.
    fake.images.set(IMAGE, 'sha256:two');

    const detail = await orchestrator.manager.start('a1');

    assert.deepEqual(fake.removed, ['c1']);
    assert.equal(fake.created.length, 1);
    assert.equal(fake.created[0]!['Image'], IMAGE);
    assert.notEqual(detail.containerId, 'c1');
    assert.equal(detail.image, IMAGE);
    // And it is actually running, not merely created.
    assert.equal(fake.containers.get(detail.containerId!)?.running, true);
  });

  it('brings the workspace and the home volume across untouched', async () => {
    insertSession('a2', 'c1', 'sha256:one');
    fake.images.set(IMAGE, 'sha256:two');

    await orchestrator.manager.start('a2');

    // Everything durable about a session lives in these two mounts, which is
    // what makes recreating the container cheap rather than destructive.
    const host = fake.created[0]!['HostConfig'] as { Binds: string[] };
    assert.deepEqual(host.Binds, [
      `${dir}/workspaces/a2:/workspace`,
      'home-a2:/home/agent',
      // The agent configuration comes across too, read-only. It is derived
      // from the database rather than durable in itself, but the mount has to
      // be there or the box starts with nothing configured.
      `${dir}/agents/a2:/boxes/agent:ro`,
    ]);
  });

  it('leaves a session already on the current image alone', async () => {
    insertSession('a3', 'c1', 'sha256:one');

    const detail = await orchestrator.manager.start('a3');

    assert.deepEqual(fake.removed, []);
    assert.equal(fake.created.length, 0);
    assert.equal(detail.containerId, 'c1');
  });

  it('defers a running container rather than killing the turn in it', async () => {
    insertSession('a4', 'c1', 'sha256:one');
    fake.containers.get('c1')!.running = true;
    fake.images.set(IMAGE, 'sha256:two');

    const detail = await orchestrator.manager.start('a4');

    // The idle reaper stops it soon enough, and the next start moves it.
    assert.deepEqual(fake.removed, []);
    assert.equal(detail.containerId, 'c1');
  });

  it('starts the session as it is when the new image is not on the host', async () => {
    insertSession('a5', 'c1', 'sha256:one');
    fake.images.delete(IMAGE);

    const detail = await orchestrator.manager.start('a5');

    assert.deepEqual(fake.removed, []);
    assert.equal(detail.containerId, 'c1');
  });
});

describe('having the session image at all', () => {
  it('pulls it when it is not on the host', async () => {
    fake.images.delete(IMAGE);
    fake.onPull = (image) => fake.images.set(image, 'sha256:pulled');

    await orchestrator.manager.ensureSessionImage();

    assert.deepEqual(fake.pulled, [IMAGE]);
  });

  it('does not pull one that is already here', async () => {
    await orchestrator.manager.ensureSessionImage();
    assert.deepEqual(fake.pulled, []);
  });

  it('refreshes on demand, so a moving tag moves on this host too', async () => {
    fake.onPull = (image) => fake.images.set(image, 'sha256:two');

    await orchestrator.manager.refreshSessionImage();

    assert.deepEqual(fake.pulled, [IMAGE]);
    assert.equal(fake.images.get(IMAGE), 'sha256:two');
  });
});

/** What a pull that moves the tag does: the old id stays, untagged. */
function moveTagTo(id: string): void {
  const before = fake.images.get(IMAGE);
  if (before) fake.untagged.set(before, { [dk.IMAGE_LABEL]: dk.SESSION_IMAGE_KIND });
  fake.images.set(IMAGE, id);
}

describe('reclaiming what a pull superseded', () => {
  it('removes the copy the tag moved off', async () => {
    fake.onPull = () => moveTagTo('sha256:two');

    await orchestrator.manager.refreshSessionImage();

    // A gigabyte or two per release, which nothing else was ever going to
    // reclaim: an untagged image is not something a deployment goes looking
    // for.
    assert.deepEqual(fake.imagesRemoved, ['sha256:one']);
  });

  it('leaves the one a session is still on, and takes it the next time round', async () => {
    // A box that has not been started since the tag moved is still on the old
    // image, and the daemon refuses to remove it. That refusal is the safety
    // property, not an error to work around.
    fake.imagesInUse.add('sha256:one');
    fake.onPull = () => moveTagTo('sha256:two');

    await orchestrator.manager.refreshSessionImage();
    assert.deepEqual(fake.imagesRemoved, []);
    assert.ok(fake.untagged.has('sha256:one'));

    // The session started, was recreated on the current image, and let go.
    fake.imagesInUse.delete('sha256:one');
    fake.onPull = () => moveTagTo('sha256:three');
    await orchestrator.manager.refreshSessionImage();

    assert.deepEqual(fake.imagesRemoved, ['sha256:one', 'sha256:two']);
  });

  it('takes what an earlier process left behind, by the image label', async () => {
    // The id this process replaced is known outright; one an orchestrator
    // that has since restarted replaced is only findable because the image
    // carries a label of its own.
    fake.untagged.set('sha256:from-last-week', { [dk.IMAGE_LABEL]: dk.SESSION_IMAGE_KIND });
    fake.onPull = () => moveTagTo('sha256:two');

    await orchestrator.manager.refreshSessionImage();

    assert.deepEqual(fake.imagesRemoved.sort(), ['sha256:from-last-week', 'sha256:one']);
  });

  it('never touches an untagged image that is not ours', async () => {
    // The orchestrator holds this host's Docker socket. An image somebody
    // else built is not its to reclaim, however unused it looks.
    fake.untagged.set('sha256:somebody-elses', { 'com.example.thing': 'yes' });
    fake.onPull = () => moveTagTo('sha256:two');

    await orchestrator.manager.refreshSessionImage();

    assert.deepEqual(fake.imagesRemoved, ['sha256:one']);
    assert.ok(fake.untagged.has('sha256:somebody-elses'));
  });

  it('removes nothing when the tag did not move', async () => {
    fake.untagged.set('sha256:from-last-week', { [dk.IMAGE_LABEL]: dk.SESSION_IMAGE_KIND });

    await orchestrator.manager.refreshSessionImage();

    // A pull that changed nothing superseded nothing, and the sweep rides
    // along with the change rather than running on its own.
    assert.deepEqual(fake.imagesRemoved, []);
  });

  it('keeps every copy when the deployment turns pruning off', async () => {
    await orchestrator.app.close();
    db.close();
    db = openDb(dir);
    orchestrator = buildApp(
      loadConfig({ DATA_DIR: dir, SESSION_IMAGE: IMAGE, SESSION_IMAGE_PRUNE: 'false' }),
      db,
    );
    fake.onPull = () => moveTagTo('sha256:two');

    await orchestrator.manager.refreshSessionImage();

    assert.deepEqual(fake.imagesRemoved, []);
  });
});

describe('reading the uid back off the session image', () => {
  /** Installs a daemon whose image reports `user` as its own `USER`. */
  function withImageUser(user: string | undefined): void {
    dk.setDockerForTests({
      getImage: () => ({
        inspect: async () => ({ Id: 'sha256:one', Config: user === undefined ? {} : { User: user } }),
      }),
    } as unknown as Docker);
  }

  it('reads a numeric USER, which is what the image is built with', async () => {
    withImageUser('1020');
    assert.equal(await dk.imageUserUid(IMAGE), 1020);
  });

  it('ignores a uid:gid pair beyond its uid', async () => {
    withImageUser('1020:1020');
    assert.equal(await dk.imageUserUid(IMAGE), 1020);
  });

  it('says nothing about an image whose USER is a name', async () => {
    // An older image, or one built elsewhere: there is no uid to compare, and
    // guessing at one would be worse than staying quiet.
    withImageUser('agent');
    assert.equal(await dk.imageUserUid(IMAGE), null);
  });

  it('says nothing about an image with no USER at all', async () => {
    withImageUser(undefined);
    assert.equal(await dk.imageUserUid(IMAGE), null);
  });
});
