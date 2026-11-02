import { describe, expect, it } from 'vitest';
import { isPublicAddress } from '../src/index.ts';

describe('isPublicAddress', () => {
  it('AC-026-9: адреса всех непубличных диапазонов 4.7 → false', () => {
    const blocked = [
      // IPv4
      '0.0.0.0',
      '0.255.255.255',
      '10.0.0.5',
      '100.64.0.1',
      '100.127.255.255',
      '127.0.0.1',
      '169.254.10.10',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.8',
      '192.168.1.1',
      '198.18.0.1',
      '198.19.255.255',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
      // IPv6
      '::',
      '::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'febf::1',
      'ff02::1',
      // IPv4-mapped
      '::ffff:127.0.0.1',
      '::ffff:10.1.2.3',
      '::ffff:7f00:1',
    ];
    for (const address of blocked) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it('AC-026-9: публичные адреса → true', () => {
    for (const address of [
      '1.1.1.1',
      '93.184.215.14',
      '100.63.255.255',
      '172.15.0.1',
      '172.32.0.1',
      '198.17.255.255',
      '2606:4700::1111',
      '::ffff:1.1.1.1',
    ]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });

  it('AC-026-9: неразобранные адреса и зона → false', () => {
    for (const address of [
      '',
      'example.com',
      '1.2.3',
      '256.1.1.1',
      'fe80::1%eth0',
      'g::1',
      '1:2:3',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
});
