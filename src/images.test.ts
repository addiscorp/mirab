import { expect, test } from 'bun:test'
import { imageKey, upgradesIn } from './images'

test("an image's key is its base and its package list, order and repeats aside", () => {
  const a = imageKey('base-1', ['jq', 'git', 'jq'])
  expect(imageKey('base-1', ['git', 'jq'])).toBe(a)
  expect(imageKey('base-2', ['git', 'jq'])).not.toBe(a)
  expect(imageKey('base-1', ['git'])).not.toBe(a)
  expect(a).toMatch(/^[0-9a-f]{32}$/)
})

test("a dry-run upgrade's Inst lines are the packages it would upgrade", () => {
  const lines = [
    'Reading package lists...',
    'The following packages will be upgraded:',
    '  libc6 openssl',
    '2 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.',
    'Inst libc6 [2.39-0ubuntu8.9] (2.39-0ubuntu8.10 Ubuntu:24.04/noble-updates [amd64])',
    'Inst openssl [3.0.13-0ubuntu3.5] (3.0.13-0ubuntu3.6 Ubuntu:24.04/noble-security [amd64])',
    'Conf libc6 (2.39-0ubuntu8.10 Ubuntu:24.04/noble-updates [amd64])',
  ]
  expect(upgradesIn(lines)).toEqual(['libc6', 'openssl'])
  expect(upgradesIn(['0 upgraded, 0 newly installed'])).toEqual([])
})
