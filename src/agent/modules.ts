// The modules an agent's own files import ('mirab', 'mirab/tools', 'zod'),
// given by mirab itself: in a VM there is no node_modules, and one zod means
// a tool's schema is checked by the same zod that made it. They win over a
// project's own node_modules (its pinned mirab or zod is not used), for the
// whole process once registered.
import * as zod from 'zod'
import * as mirab from '../index'
import * as tools from '../tools'

let registered = false

export function registerAgentModules() {
  if (registered) return
  registered = true
  Bun.plugin({
    name: 'mirab-agent-modules',
    setup(build) {
      build.module('mirab', () => ({ exports: mirab, loader: 'object' }))
      build.module('mirab/tools', () => ({ exports: tools, loader: 'object' }))
      build.module('zod', () => ({ exports: zod, loader: 'object' }))
    },
  })
}
