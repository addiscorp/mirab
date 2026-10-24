import { expect, test } from 'bun:test'
import {
  PLACEHOLDER,
  anthropicKeyRoute,
  claudeGuestEnvironment,
  claudeRoute,
} from './routes'

const station = {
  harar: { socket: '/s' },
  models: {
    anthropic: { key: 'personal/anthropic/API_KEY' },
    claude: { token: 'personal/claude/OAUTH_TOKEN' },
  },
}

test("Claude Code's route adds the token as a bearer, only on the messages API", () => {
  const route = claudeRoute(station)!
  expect(route.upstream).toBe('https://api.anthropic.com')
  expect(route.header).toBe('authorization')
  expect(route.format!('sk-ant-oat01-x')).toBe('Bearer sk-ant-oat01-x')
  expect(route.paths).toEqual(['/v1/messages'])
  expect(claudeRoute({ ...station, models: {} })).toBeUndefined()
  expect(anthropicKeyRoute(station)!.header).toBe('x-api-key')
})

test('Claude Code in the guest holds only the placeholder, and talks to nothing but the route', () => {
  const env = claudeGuestEnvironment()
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(PLACEHOLDER)
  expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8790/claude')
  expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
  expect(env.DISABLE_AUTOUPDATER).toBe('1')
  expect(Object.keys(env).sort()).toEqual([
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'DISABLE_AUTOUPDATER',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
  ])
})
