// What a host that serves runners imports (woreda): the VM side of runners.
// A runner definition itself imports only `defineRunner` from 'mirab'.
export * from './define'
export {
  buildSteps,
  cachedRunnerImage,
  runnerImage,
  runnerImageKey,
  runnerImagesDir,
  runnerRecipe,
} from './image'
export type { RunnerImage, RunnerImageMeta, RunnerRecipe } from './image'
export {
  admission,
  hostLabel,
  jobEnv,
  redact,
  runnerLabels,
  runnersDir,
  serveRunners,
  startRunnerVm,
  stepArgv,
} from './serve'
export type {
  RunnerState,
  ServeDeps,
  ServeOptions,
  SlotPhase,
  SlotState,
} from './serve'
export { HostBudget } from './budget'
export type { BudgetSnapshot, Lease, Need } from './budget'
export { resolveTools, TOOL_CACHE } from './toolsets'
/** The VM this host runs runners on: the published guest image (fetched on
 *  first use) and the backend's settings from <config dir>/isolation.json. */
export { requireVm as runnerHostVm } from '../isolation'
// For a forge adapter's Linux service install (woreda): the VM network for
// its service user, and the pinned Firecracker.
export {
  removeLinuxNetwork,
  setupLinuxNetwork,
} from '../isolation/linux-network-setup'
export {
  FIRECRACKER_PIN,
  installFirecracker,
} from '../isolation/firecracker-install'
/** This copy's package version: with the commit a package pins mirab at, it
 *  names that commit's canary (`<version>-canary-<sha7>`) for runnerHostVm. */
export { MIRAB_VERSION } from '../isolation/image'
export type { ResolvedTool } from './toolsets'
