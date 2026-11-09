import assert from 'node:assert/strict';
import { test } from 'vitest';
import { addressKind, answerKind } from '../../shared/cidr.ts';

test('sorts private networks as private, so an explicit host can open them', () => {
  for (const addr of [
    '10.0.0.1',
    '10.43.27.38',
    '10.200.5.2',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '192.168.0.0',
    '100.64.0.1',
    '100.101.102.103',
    '198.18.0.1',
    'fd7a:115c:a1e0::1',
    'fd12:3456::1',
    'fc00::1',
  ]) {
    assert.equal(addressKind(addr), 'private', `${addr} should be private`);
  }
});

test('sorts loopback, link-local, multicast and reserved as forbidden', () => {
  for (const addr of [
    '127.0.0.1',
    '127.255.255.255',
    '169.254.169.254', // cloud metadata
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'ff02::1',
  ]) {
    assert.equal(addressKind(addr), 'forbidden', `${addr} should be forbidden`);
  }
});

test('sorts public addresses as public', () => {
  for (const addr of [
    '1.1.1.1',
    '8.8.8.8',
    '140.82.121.4',
    '172.15.0.1',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
  ]) {
    assert.equal(addressKind(addr), 'public', `${addr} should be public`);
  }
});

test('172.16/12 boundary is exact', () => {
  assert.equal(addressKind('172.15.255.255'), 'public');
  assert.equal(addressKind('172.16.0.0'), 'private');
  assert.equal(addressKind('172.31.255.255'), 'private');
  assert.equal(addressKind('172.32.0.0'), 'public');
});

test('vets v4-mapped IPv6 as the IPv4 address it reaches', () => {
  assert.equal(addressKind('::ffff:192.168.1.1'), 'private');
  assert.equal(addressKind('::ffff:127.0.0.1'), 'forbidden');
  assert.equal(addressKind('::ffff:10.0.0.1'), 'private');
  assert.equal(addressKind('::ffff:8.8.8.8'), 'public');
});

test('vets v4-compatible IPv6 as the IPv4 address it reaches', () => {
  assert.equal(addressKind('::192.168.1.1'), 'private');
  assert.equal(addressKind('::8.8.8.8'), 'public');
});

test('vets v4-translated IPv6 as the IPv4 address it reaches', () => {
  assert.equal(addressKind('::ffff:0:192.168.1.1'), 'private');
  assert.equal(addressKind('::ffff:0:8.8.8.8'), 'public');
});

test('vets NAT64 and 6to4 addresses as the IPv4 address they reach', () => {
  assert.equal(addressKind('64:ff9b::192.168.1.1'), 'private');
  assert.equal(addressKind('64:ff9b::169.254.169.254'), 'forbidden');
  assert.equal(addressKind('64:ff9b::c0a8:101'), 'private');
  assert.equal(addressKind('64:ff9b::8.8.8.8'), 'public');
  assert.equal(addressKind('2002:c0a8:0101::1'), 'private');
  assert.equal(addressKind('2002:7f00:0001::1'), 'forbidden');
  assert.equal(addressKind('2002:0808:0808::1'), 'public');
});

test('handles bracketed and zoned IPv6 literals', () => {
  assert.equal(addressKind('[::1]'), 'forbidden');
  assert.equal(addressKind('fe80::1%eth0'), 'forbidden');
});

test('fails closed on unparseable input', () => {
  for (const addr of ['', '   ', 'not-an-ip', '10.0.0', '10.0.0.256', 'gggg::1', '1::2::3']) {
    assert.equal(addressKind(addr), 'forbidden', `${addr} should fail closed`);
  }
});

test('a DNS answer takes the most restricted kind of its addresses', () => {
  // DNS rebinding gives one public answer and one private answer.
  assert.equal(answerKind(['8.8.8.8', '1.1.1.1']), 'public');
  assert.equal(answerKind(['8.8.8.8', '10.0.0.1']), 'private');
  assert.equal(answerKind(['10.0.0.1', '8.8.8.8']), 'private');
  assert.equal(answerKind(['10.0.0.1', '127.0.0.1']), 'forbidden');
});

test('an empty answer set fails closed', () => {
  assert.equal(answerKind([]), 'forbidden');
});
