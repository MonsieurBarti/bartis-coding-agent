import {
  type EngineEvents,
  type EngineResult,
  execute,
  loadBlueprint,
  PiAgentRunner,
} from "../blueprint";
import { loadProfile } from "../profile";
import { buildDefaultBlueprint } from "./default-blueprint";

export interface DispatchOptions {
  /** Human-readable task description (from the slung bead). */
  task: string;
  /** Absolute path to the project root (must contain .pi/pipeline.yaml). */
  projectRoot: string;
  /** Working directory for agent execution (defaults to projectRoot). */
  cwd?: string;
  /** Path to a custom blueprint YAML file. When omitted, uses the default coding pipeline. */
  blueprintPath?: string;
  /** Optional engine event hooks for progress reporting. */
  events?: EngineEvents;
}

export interface DispatchResult {
  /** Whether all blueprint nodes succeeded. */
  success: boolean;
  /** The engine result with per-node states. */
  engine: EngineResult;
}

/**
 * Dispatch a task through the Pi SDK pipeline.
 *
 * This is the Gas Town integration entry point. When a polecat is slung work,
 * it calls dispatch() which:
 *
 * 1. Loads the project profile from .pi/pipeline.yaml
 * 2. Loads or builds a blueprint (custom YAML or default coding pipeline)
 * 3. Wires the PiAgentRunner as the agent backend
 * 4. Runs the blueprint engine to completion
 */
export async function dispatch(options: DispatchOptions): Promise<DispatchResult> {
  const { task, projectRoot, cwd = projectRoot, blueprintPath, events } = options;

  // 1. Load project profile
  const profile = await loadProfile(projectRoot);

  // 2. Load or build blueprint
  const blueprint = blueprintPath
    ? await loadBlueprint(blueprintPath)
    : buildDefaultBlueprint(task, profile.commands.test);

  // 3. Run the blueprint engine with Pi SDK agent runner
  const engine = await execute(blueprint, {
    events,
    projectPath: projectRoot,
    agentRunner: new PiAgentRunner(),
    profile,
  });

  return { success: engine.success, engine };
}
