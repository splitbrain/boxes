import { describe, expect, it } from 'vitest';
import { hostMatches, hostPatternProblem, splitHostPattern } from '../../shared/hosts.ts';
import type { EgressBoxPolicy, EgressPolicy } from '../../shared/types.ts';
import {
  boxFromAuthorization,
  credentialsForHost,
  decideCredentials,
  EMPTY_POLICY,
  hostAllowed,
  isInjectionHost,
  parsePolicy,
  policyHash,
  swapCredentialValue,
  upstreamBoxPolicy,
  upstreamCaCerts,
  upstreamCasFor,
} from './policy.ts';

/** The Claude credential. */
const CLAUDE = {
  id: 'claude',
  hosts: ['api.anthropic.com'],
  headers: ['authorization', 'x-api-key'],
  placeholder: 'sk-ant-oat01-PLACEHOLDER',
  secret: 'sk-ant-oat01-realrealreal',
};

/**
 * The OpenAI credential that Codex sends. Its placeholder starts with sk-, as
 * the Claude placeholder does, so the tests show that a swap needs the full
 * placeholder at the host of its credential.
 */
const OPENAI = {
  id: 'openai',
  hosts: ['api.openai.com'],
  headers: ['authorization'],
  placeholder: 'sk-PLACEHOLDER',
  secret: 'sk-proj-realrealreal',
};

/** The GitHub credential, with a wildcard host. */
const GITHUB = {
  id: 'github',
  hosts: ['github.com', 'api.github.com', '*.githubusercontent.com'],
  headers: ['authorization'],
  placeholder: 'ghp_PLACEHOLDER',
  secret: 'ghp_realrealreal',
};

/** A user's own API key, which names no header and so may travel in any. */
const OPENROUTER = {
  id: 'openrouter',
  hosts: ['openrouter.ai'],
  headers: [],
  placeholder: 'sk-or-v1-PLACEHOLDER',
  secret: 'sk-or-v1-realrealreal',
};

/**
 * Makes the policy of a box.
 *
 * @param open True for the open mode.
 * @param hosts The host patterns of the box.
 * @returns The policy of a box with the id box-1.
 */
const box = (open: boolean, ...hosts: string[]): EgressBoxPolicy => ({
  box: 'box-1',
  token: 'a'.repeat(64),
  open,
  hosts,
});

/**
 * Makes the value of a Proxy-Authorization header with the Basic scheme.
 *
 * @param decoded The user and the password, as user:password.
 * @returns The header value.
 */
const basic = (decoded: string): string => `Basic ${Buffer.from(decoded).toString('base64')}`;

/**
 * Makes a policy that holds the Claude, OpenAI and GitHub credentials.
 *
 * @param over The fields to replace.
 * @returns The policy.
 */
const policy = (over: Partial<EgressPolicy> = {}): EgressPolicy => ({
  boxes: [],
  ca: { key: 'KEY', cert: 'CERT' },
  credentials: [CLAUDE, OPENAI, GITHUB],
  ...over,
});

describe('hostMatches', () => {
  it('matches exact names case-insensitively and ignores a trailing dot', () => {
    expect(hostMatches('api.github.com', 443, 'api.github.com')).toBe(true);
    expect(hostMatches('API.GitHub.com', 443, 'api.github.com')).toBe(true);
    expect(hostMatches('api.github.com.', 443, 'api.github.com')).toBe(true);
    expect(hostMatches('api.github.com', 443, 'github.com')).toBe(false);
  });

  it('lets a wildcard stand for exactly one label', () => {
    expect(hostMatches('raw.githubusercontent.com', 443, '*.githubusercontent.com')).toBe(true);
    expect(hostMatches('githubusercontent.com', 443, '*.githubusercontent.com')).toBe(false);
    expect(hostMatches('a.b.githubusercontent.com', 443, '*.githubusercontent.com')).toBe(false);
    expect(hostMatches('.githubusercontent.com', 443, '*.githubusercontent.com')).toBe(false);
  });

  it('never lets a wildcard match an address literal', () => {
    expect(hostMatches('1.1.1.1', 443, '*.1.1.1')).toBe(false);
    expect(hostMatches('1.1.1.1', 443, '1.1.1.1')).toBe(true);
    expect(hostMatches('::1', 443, '*.1')).toBe(false);
  });

  it('rejects empty patterns and hosts', () => {
    expect(hostMatches('', 443, 'github.com')).toBe(false);
    expect(hostMatches('github.com', 443, '')).toBe(false);
    expect(hostMatches('github.com', 443, '*.')).toBe(false);
  });

  it('matches a pattern without a port on the ports 80 and 443 only', () => {
    expect(hostMatches('github.com', 80, 'github.com')).toBe(true);
    expect(hostMatches('github.com', 8443, 'github.com')).toBe(false);
  });

  it('matches a pattern with a port on that port only', () => {
    expect(hostMatches('mcp.example.com', 8443, 'mcp.example.com:8443')).toBe(true);
    expect(hostMatches('mcp.example.com', 443, 'mcp.example.com:8443')).toBe(false);
    expect(hostMatches('a.example.com', 8443, '*.example.com:8443')).toBe(true);
    expect(hostMatches('2001:db8::1', 8443, '[2001:db8::1]:8443')).toBe(true);
    expect(hostMatches('2001:db8::1', 443, '2001:db8::1')).toBe(true);
  });
});

describe('splitHostPattern', () => {
  it('splits off an optional port', () => {
    expect(splitHostPattern('example.com')).toEqual({ host: 'example.com', port: null });
    expect(splitHostPattern('example.com:8443')).toEqual({ host: 'example.com', port: 8443 });
    expect(splitHostPattern('2001:db8::1')).toEqual({ host: '2001:db8::1', port: null });
    expect(splitHostPattern('[2001:db8::1]:8443')).toEqual({ host: '2001:db8::1', port: 8443 });
  });
});

describe('hostPatternProblem', () => {
  it('accepts a name, a leading wildcard, an IP literal and a valid port', () => {
    for (const pattern of [
      'github.com',
      '*.githubusercontent.com',
      'mcp.example.com:8443',
      '*.example.com:1',
      '[2001:db8::1]:65535',
      '10.0.0.1',
    ]) {
      expect(hostPatternProblem(pattern)).toBeNull();
    }
  });

  it('refuses a bare star, an inner wildcard and a port out of range', () => {
    expect(hostPatternProblem('*')).toMatch(/bare \*/);
    expect(hostPatternProblem('api.*.com')).toMatch(/leading \*\./);
    expect(hostPatternProblem('*.*.example.com')).toMatch(/leading \*\./);
    expect(hostPatternProblem('example.com:0')).toMatch(/no valid port/);
    expect(hostPatternProblem('example.com:65536')).toMatch(/no valid port/);
  });
});

describe('hostAllowed', () => {
  it('allows every host on the ports 80 and 443 for an open box', () => {
    expect(hostAllowed('example.com', 443, box(true))).toBe(true);
    expect(hostAllowed('example.com', 80, box(true))).toBe(true);
    expect(hostAllowed('1.1.1.1', 443, box(true))).toBe(true);
    expect(hostAllowed('example.com', 8443, box(true))).toBe(false);
  });

  it('allows only the listed hosts for a closed box', () => {
    const closed = box(false, 'registry.npmjs.org', '*.example.com');
    expect(hostAllowed('registry.npmjs.org', 443, closed)).toBe(true);
    expect(hostAllowed('a.example.com', 443, closed)).toBe(true);
    expect(hostAllowed('example.com', 443, closed)).toBe(false);
    expect(hostAllowed('evil.com', 443, closed)).toBe(false);
    expect(hostAllowed('1.1.1.1', 443, closed)).toBe(false);
    expect(hostAllowed('example.com', 443, box(false))).toBe(false);
  });

  it('does not imply the credential hosts', () => {
    expect(hostAllowed('api.anthropic.com', 443, box(false, 'registry.npmjs.org'))).toBe(false);
  });

  it('allows another port only when a pattern names it', () => {
    for (const open of [true, false]) {
      const keyed = box(open, 'mcp.example.com:8443');
      expect(hostAllowed('mcp.example.com', 8443, keyed)).toBe(true);
      expect(hostAllowed('mcp.example.com', 9000, keyed)).toBe(false);
      expect(hostAllowed('other.example.com', 8443, keyed)).toBe(false);
    }
    expect(hostAllowed('mcp.example.com', 443, box(false, 'mcp.example.com:8443'))).toBe(false);
  });
});

describe('boxFromAuthorization', () => {
  /** A policy with two boxes. */
  const boxes = policy({
    boxes: [box(false), { box: 'box-2', token: 'b'.repeat(64), open: true, hosts: [] }],
  });

  it('finds the box from its id and its token', () => {
    expect(boxFromAuthorization(basic(`box-1:${'a'.repeat(64)}`), boxes)).toEqual(box(false));
    expect(boxFromAuthorization(basic(`box-2:${'b'.repeat(64)}`), boxes)?.box).toBe('box-2');
    // The scheme name matches in any case.
    const lower = `basic ${Buffer.from(`box-1:${'a'.repeat(64)}`).toString('base64')}`;
    expect(boxFromAuthorization(lower, boxes)?.box).toBe('box-1');
  });

  it('refuses a token that no box has', () => {
    expect(boxFromAuthorization(basic(`box-1:${'c'.repeat(64)}`), boxes)).toBeNull();
    expect(boxFromAuthorization(basic(`box-1:${'a'.repeat(63)}`), boxes)).toBeNull();
    expect(boxFromAuthorization(basic('box-1:'), boxes)).toBeNull();
  });

  it('refuses the token of a box together with the id of another box', () => {
    expect(boxFromAuthorization(basic(`box-2:${'a'.repeat(64)}`), boxes)).toBeNull();
    expect(boxFromAuthorization(basic(`box-3:${'a'.repeat(64)}`), boxes)).toBeNull();
  });

  it('refuses a missing or malformed header', () => {
    expect(boxFromAuthorization(undefined, boxes)).toBeNull();
    expect(boxFromAuthorization('', boxes)).toBeNull();
    expect(boxFromAuthorization(`Bearer ${'a'.repeat(64)}`, boxes)).toBeNull();
    expect(boxFromAuthorization('Basic !!!', boxes)).toBeNull();
    expect(boxFromAuthorization('Basic', boxes)).toBeNull();
  });

  it('refuses a decoded value without a colon', () => {
    expect(boxFromAuthorization(basic('a'.repeat(64)), boxes)).toBeNull();
  });
});

describe('upstreamBoxPolicy', () => {
  it('is closed and holds the hosts of all credentials', () => {
    const upstream = upstreamBoxPolicy(policy({ boxes: [box(true, 'example.com')] }));
    expect(upstream.open).toBe(false);
    expect(upstream.hosts).toEqual([
      'api.anthropic.com',
      'api.openai.com',
      'github.com',
      'api.github.com',
      '*.githubusercontent.com',
    ]);
    expect(hostAllowed('raw.githubusercontent.com', 443, upstream)).toBe(true);
    expect(hostAllowed('example.com', 443, upstream)).toBe(false);
  });

  it('holds the hosts of the upstream CAs of all boxes', () => {
    const withCa: EgressBoxPolicy = {
      ...box(false),
      upstreamCas: [{ host: 'mcp.internal:8443', cert: 'PRIVATE CA' }],
    };
    const upstream = upstreamBoxPolicy(policy({ credentials: [], boxes: [withCa] }));
    expect(upstream.hosts).toEqual(['mcp.internal:8443']);
  });
});

describe('upstreamCasFor', () => {
  /** A box with upstream CAs for two host patterns. */
  const withCas: EgressBoxPolicy = {
    box: 'box-1',
    token: 'a'.repeat(64),
    open: false,
    hosts: [],
    upstreamCas: [
      { host: 'mcp.internal:8443', cert: 'CA ONE' },
      { host: '*.corp.example', cert: 'CA TWO' },
    ],
  };

  it('finds the CAs whose host pattern matches the host and the port', () => {
    expect(upstreamCasFor('mcp.internal', 8443, withCas)).toEqual(['CA ONE']);
    expect(upstreamCasFor('mcp.internal', 443, withCas)).toEqual([]);
    expect(upstreamCasFor('git.corp.example', 443, withCas)).toEqual(['CA TWO']);
    expect(upstreamCasFor('git.corp.example', 443, { ...withCas, upstreamCas: undefined })).toEqual(
      [],
    );
  });

  it('lists the certificates of all boxes once', () => {
    const other: EgressBoxPolicy = {
      ...withCas,
      box: 'box-2',
      token: 'b'.repeat(64),
      upstreamCas: [{ host: 'mcp.internal:8443', cert: 'CA ONE' }],
    };
    expect(upstreamCaCerts(policy({ boxes: [withCas, other, box(true)] }))).toEqual([
      'CA ONE',
      'CA TWO',
    ]);
  });
});

describe('isInjectionHost', () => {
  it('is true only for a credential host, and only with a CA to intercept with', () => {
    expect(isInjectionHost('api.github.com', 443, policy())).toBe(true);
    expect(isInjectionHost('example.com', 443, policy())).toBe(false);
    expect(isInjectionHost('api.github.com', 443, policy({ ca: null }))).toBe(false);
    expect(isInjectionHost('api.github.com', 443, policy({ credentials: [CLAUDE] }))).toBe(false);
  });

  it('takes the port into account', () => {
    expect(isInjectionHost('api.github.com', 8443, policy())).toBe(false);
    const keyed = policy({ credentials: [{ ...GITHUB, hosts: ['mcp.example.com:8443'] }] });
    expect(isInjectionHost('mcp.example.com', 8443, keyed)).toBe(true);
    expect(isInjectionHost('mcp.example.com', 443, keyed)).toBe(false);
  });
});

describe('credentialsForHost', () => {
  it('maps a host to only its own credentials', () => {
    expect(credentialsForHost('api.anthropic.com', 443, policy()).map((c) => c.id)).toEqual([
      'claude',
    ]);
    expect(credentialsForHost('github.com', 443, policy()).map((c) => c.id)).toEqual(['github']);
  });
});

describe('swapCredentialValue', () => {
  it('swaps a bearer, a token and a bare value', () => {
    expect(swapCredentialValue('Bearer ghp_PLACEHOLDER', GITHUB.placeholder, GITHUB.secret)).toBe(
      'Bearer ghp_realrealreal',
    );
    expect(swapCredentialValue('token ghp_PLACEHOLDER', GITHUB.placeholder, GITHUB.secret)).toBe(
      'token ghp_realrealreal',
    );
    expect(swapCredentialValue('ghp_PLACEHOLDER', GITHUB.placeholder, GITHUB.secret)).toBe(
      'ghp_realrealreal',
    );
  });

  it('swaps the password inside HTTP Basic, which is what git sends', () => {
    const basic = `Basic ${Buffer.from(`x-access-token:${GITHUB.placeholder}`).toString('base64')}`;
    const swapped = swapCredentialValue(basic, GITHUB.placeholder, GITHUB.secret);
    expect(swapped).not.toBeNull();
    const decoded = Buffer.from(swapped!.slice('Basic '.length), 'base64').toString('utf8');
    expect(decoded).toBe(`x-access-token:${GITHUB.secret}`);
  });

  it('reports a value that does not carry the placeholder', () => {
    expect(
      swapCredentialValue('Bearer somebody-elses-token', GITHUB.placeholder, GITHUB.secret),
    ).toBeNull();
    const basic = `Basic ${Buffer.from('user:somebody-elses-token').toString('base64')}`;
    expect(swapCredentialValue(basic, GITHUB.placeholder, GITHUB.secret)).toBeNull();
    expect(swapCredentialValue('Bearer x', '', GITHUB.secret)).toBeNull();
  });
});

describe('decideCredentials', () => {
  it('passes a host with no credential configured straight through', () => {
    expect(
      decideCredentials('example.com', 443, { authorization: 'Bearer anything' }, policy()),
    ).toEqual({ action: 'pass' });
  });

  it('passes an unauthenticated request to a credential host', () => {
    expect(decideCredentials('api.github.com', 443, { accept: '*/*' }, policy())).toEqual({
      action: 'pass',
    });
    expect(decideCredentials('api.github.com', 443, { authorization: '  ' }, policy())).toEqual({
      action: 'pass',
    });
  });

  it('swaps the placeholder for the real credential', () => {
    const verdict = decideCredentials(
      'api.github.com',
      443,
      { authorization: `Bearer ${GITHUB.placeholder}` },
      policy(),
    );
    expect(verdict).toEqual({
      action: 'swap',
      headers: { authorization: `Bearer ${GITHUB.secret}` },
      credentialIds: ['github'],
    });
  });

  it('forwards every value without a placeholder unchanged', () => {
    const basicJwt = `Basic ${Buffer.from('someone:eyJhbGciOi.x.y').toString('base64')}`;
    for (const authorization of [
      'Bearer ghp_someoneElsesToken',
      'tunnel eyJhbGciOi.x.y',
      'RemoteAuth abc',
      basicJwt,
    ]) {
      expect(decideCredentials('api.github.com', 443, { authorization }, policy())).toEqual({
        action: 'pass',
      });
    }
  });

  it('reads only the first value of a repeated header', () => {
    expect(
      decideCredentials(
        'api.github.com',
        443,
        { authorization: [`Bearer ${GITHUB.placeholder}`, 'Bearer ghp_someoneElsesToken'] },
        policy(),
      ),
    ).toEqual({
      action: 'swap',
      headers: { authorization: `Bearer ${GITHUB.secret}` },
      credentialIds: ['github'],
    });
    expect(
      decideCredentials(
        'api.github.com',
        443,
        { authorization: ['Bearer ghp_someoneElsesToken', `Bearer ${GITHUB.placeholder}`] },
        policy(),
      ),
    ).toEqual({ action: 'pass' });
  });

  it('swaps a credential that names no header in whatever header carries it', () => {
    const anyHeader = policy({ credentials: [OPENROUTER] });
    expect(
      decideCredentials(
        'openrouter.ai',
        443,
        { 'x-custom-key': OPENROUTER.placeholder, accept: '*/*' },
        anyHeader,
      ),
    ).toEqual({
      action: 'swap',
      headers: { 'x-custom-key': OPENROUTER.secret },
      credentialIds: ['openrouter'],
    });
  });

  it('passes other values for a credential that names no header', () => {
    const anyHeader = policy({ credentials: [OPENROUTER] });
    expect(
      decideCredentials(
        'openrouter.ai',
        443,
        { authorization: 'Bearer sk-or-v1-other' },
        anyHeader,
      ),
    ).toEqual({ action: 'pass' });
  });

  it("does not swap another credential host's placeholder, so hosts do not share", () => {
    const verdict = decideCredentials(
      'api.github.com',
      443,
      { authorization: `Bearer ${CLAUDE.placeholder}` },
      policy(),
    );
    expect(verdict).toEqual({ action: 'pass' });
  });

  it('swaps the key Codex sends at api.openai.com', () => {
    expect(
      decideCredentials(
        'api.openai.com',
        443,
        { authorization: `Bearer ${OPENAI.placeholder}` },
        policy(),
      ),
    ).toEqual({
      action: 'swap',
      headers: { authorization: `Bearer ${OPENAI.secret}` },
      credentialIds: ['openai'],
    });
    expect(
      decideCredentials(
        'api.openai.com',
        443,
        { authorization: 'Bearer sk-somebodyelses' },
        policy(),
      ),
    ).toEqual({ action: 'pass' });
    expect(
      decideCredentials(
        'api.openai.com',
        443,
        { authorization: `Bearer ${CLAUDE.placeholder}` },
        policy(),
      ),
    ).toEqual({ action: 'pass' });
    // chatgpt.com, the subscription endpoint, has no credential, so any value passes there.
    expect(isInjectionHost('chatgpt.com', 443, policy())).toBe(false);
    expect(
      decideCredentials('chatgpt.com', 443, { authorization: 'Bearer whatever' }, policy()),
    ).toEqual({ action: 'pass' });
  });

  it('checks every header a credential may travel in', () => {
    expect(
      decideCredentials('api.anthropic.com', 443, { 'x-api-key': CLAUDE.placeholder }, policy()),
    ).toEqual({
      action: 'swap',
      headers: { 'x-api-key': CLAUDE.secret },
      credentialIds: ['claude'],
    });
    expect(
      decideCredentials('api.anthropic.com', 443, { 'x-api-key': 'sk-ant-someoneelse' }, policy()),
    ).toEqual({ action: 'pass' });
  });
});

describe('policyHash', () => {
  it('is stable across ordering and case, and changes with the secret', () => {
    const a = policy();
    const b = policy({ credentials: [GITHUB, OPENAI, CLAUDE] });
    expect(policyHash(a)).toBe(policyHash(b));
    expect(policyHash(policy({ credentials: [{ ...GITHUB, secret: 'other' }, CLAUDE] }))).not.toBe(
      policyHash(a),
    );
  });

  it('covers the boxes, but not their order or the case of their hosts', () => {
    const one = box(false, 'B.com', 'a.com');
    const two: EgressBoxPolicy = { box: 'box-2', token: 'b'.repeat(64), open: true, hosts: [] };
    const hash = policyHash(policy({ boxes: [one, two] }));
    expect(policyHash(policy({ boxes: [two, { ...one, hosts: ['a.com', 'b.com'] }] }))).toBe(hash);
    expect(policyHash(policy())).not.toBe(hash);
    expect(policyHash(policy({ boxes: [{ ...one, open: true }, two] }))).not.toBe(hash);
    expect(policyHash(policy({ boxes: [{ ...one, hosts: ['a.com'] }, two] }))).not.toBe(hash);
    expect(policyHash(policy({ boxes: [{ ...one, token: 'c'.repeat(64) }, two] }))).not.toBe(hash);
    const ca = { host: 'mcp.internal', cert: 'PRIVATE CA' };
    const withCa = policyHash(policy({ boxes: [{ ...one, upstreamCas: [ca] }, two] }));
    expect(withCa).not.toBe(hash);
    expect(
      policyHash(policy({ boxes: [{ ...one, upstreamCas: [{ ...ca, cert: 'OTHER CA' }] }, two] })),
    ).not.toBe(withCa);
  });

  it('never echoes a secret', () => {
    const hash = policyHash(policy());
    expect(hash).not.toContain(GITHUB.secret);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('parsePolicy', () => {
  /** A valid box. */
  const validBox = { box: 'box-1', token: 'a'.repeat(64), open: false, hosts: ['github.com'] };

  /** A valid policy with one box and one credential. */
  const valid = {
    boxes: [validBox],
    ca: { key: 'K', cert: 'C' },
    credentials: [GITHUB],
  };

  /**
   * Parses the valid policy with one changed box.
   *
   * @param over The fields of the box to replace.
   * @returns The parsed policy.
   */
  const withBox = (over: Record<string, unknown>): EgressPolicy =>
    parsePolicy({ ...valid, boxes: [{ ...validBox, ...over }] });

  it('accepts a well-formed policy and lowercases header names', () => {
    const parsed = parsePolicy({
      ...valid,
      credentials: [{ ...GITHUB, headers: ['Authorization'] }],
    });
    expect(parsed.credentials[0]?.headers).toEqual(['authorization']);
    expect(parsed.boxes).toEqual([validBox]);
  });

  it('keeps the oauth flag of a credential, and refuses a flag that is not a boolean', () => {
    const parsed = parsePolicy({ ...valid, credentials: [{ ...GITHUB, oauth: true }, GITHUB] });
    expect(parsed.credentials.map((c) => c.oauth)).toEqual([true, undefined]);
    expect(policyHash(parsed)).not.toBe(
      policyHash(parsePolicy({ ...valid, credentials: [GITHUB, GITHUB] })),
    );
    expect(() => parsePolicy({ ...valid, credentials: [{ ...GITHUB, oauth: 'yes' }] })).toThrow(
      /oauth flag/,
    );
  });

  it('trims and lowercases the hosts of a box', () => {
    expect(withBox({ open: true, hosts: [' GitHub.com ', '*.Example.com'] }).boxes).toEqual([
      { ...validBox, open: true, hosts: ['github.com', '*.example.com'] },
    ]);
  });

  it('keeps the upstream CAs of a box with lowercased hosts, and refuses a bad one', () => {
    expect(
      withBox({ upstreamCas: [{ host: ' MCP.internal:8443 ', cert: 'PRIVATE CA' }] }).boxes,
    ).toEqual([{ ...validBox, upstreamCas: [{ host: 'mcp.internal:8443', cert: 'PRIVATE CA' }] }]);
    expect(withBox({ upstreamCas: [] }).boxes).toEqual([validBox]);
    expect(() => withBox({ upstreamCas: 'PRIVATE CA' })).toThrow(/must be an array/);
    expect(() => withBox({ upstreamCas: [{ host: 'mcp.internal', cert: '' }] })).toThrow(
      /needs a host and a cert/,
    );
    expect(() => withBox({ upstreamCas: [{ host: '*', cert: 'PRIVATE CA' }] })).toThrow(
      /would allow every host/,
    );
  });

  it('accepts the empty policy the proxy boots with', () => {
    expect(parsePolicy({ boxes: [], ca: null, credentials: [] })).toEqual(EMPTY_POLICY);
  });

  it('rejects a box without an id, with a colon in its id, or without a token', () => {
    expect(() => withBox({ box: '' })).toThrow(/without a colon/);
    expect(() => withBox({ box: 'box:1' })).toThrow(/without a colon/);
    expect(() => withBox({ token: '' })).toThrow(/needs a token/);
    expect(() => withBox({ token: undefined })).toThrow(/needs a token/);
  });

  it('rejects two boxes with the same token', () => {
    expect(() =>
      parsePolicy({ ...valid, boxes: [validBox, { ...validBox, box: 'box-2' }] }),
    ).toThrow(/token of another box/);
  });

  it('rejects a box without a boolean open flag', () => {
    expect(() => withBox({ open: 'true' })).toThrow(/open flag/);
    expect(() => withBox({ open: undefined })).toThrow(/open flag/);
  });

  it('rejects a host pattern that would allow everything', () => {
    expect(() => withBox({ hosts: ['*'] })).toThrow(/bare \*/);
    expect(() => withBox({ hosts: ['api.*.com'] })).toThrow(/leading/);
  });

  it('accepts a host pattern with a port and rejects a port out of range', () => {
    expect(withBox({ hosts: ['mcp.example.com:8443'] }).boxes[0]?.hosts).toEqual([
      'mcp.example.com:8443',
    ]);
    expect(() => withBox({ hosts: ['mcp.example.com:0'] })).toThrow(/port/);
    expect(() => withBox({ hosts: ['mcp.example.com:70000'] })).toThrow(/port/);
    expect(() =>
      parsePolicy({ ...valid, credentials: [{ ...GITHUB, hosts: ['github.com:70000'] }] }),
    ).toThrow(/port/);
  });

  it('rejects a credential that cannot be translated or is not a translation', () => {
    expect(() => parsePolicy({ ...valid, ca: null })).toThrow(/without a CA/);
    expect(() =>
      parsePolicy({ ...valid, credentials: [{ ...GITHUB, secret: GITHUB.placeholder }] }),
    ).toThrow(/equal to its secret/);
    expect(() => parsePolicy({ ...valid, credentials: [{ ...GITHUB, hosts: [] }] })).toThrow(
      /at least one host/,
    );
  });

  it('accepts a credential that names no header', () => {
    const parsed = parsePolicy({ ...valid, credentials: [{ ...GITHUB, headers: [] }] });
    expect(parsed.credentials[0]?.headers).toEqual([]);
  });

  it('rejects anything that is not a policy at all', () => {
    expect(() => parsePolicy(null)).toThrow(/not an object/);
    expect(() => parsePolicy({ boxes: 'box-1' })).toThrow(/must be an array/);
    expect(() => parsePolicy({ boxes: [null] })).toThrow(/not an object/);
    expect(() => withBox({ hosts: 'github.com' })).toThrow(/must be an array/);
  });
});
