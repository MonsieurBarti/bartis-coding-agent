import type { Blueprint } from "./schema";

export class CycleError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Dependency cycle detected: ${cycle.join(" -> ")}`);
    this.name = "CycleError";
  }
}

/**
 * Topological sort of blueprint nodes using Kahn's algorithm.
 * Returns node IDs in execution order.
 * @throws CycleError if the dependency graph contains a cycle.
 */
export function topoSort(blueprint: Blueprint): string[] {
  const nodes = Object.keys(blueprint.nodes);
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const id of nodes) {
    inDegree.set(id, 0);
    dependents.set(id, []);
  }

  for (const id of nodes) {
    const deps = blueprint.nodes[id].deps;
    for (const dep of deps) {
      if (!inDegree.has(dep)) {
        throw new Error(`Node "${id}" depends on unknown node "${dep}"`);
      }
      dependents.get(dep)!.push(id);
    }
    inDegree.set(id, deps.length);
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const dep of dependents.get(current)!) {
      const newDegree = inDegree.get(dep)! - 1;
      inDegree.set(dep, newDegree);
      if (newDegree === 0) queue.push(dep);
    }
  }

  if (sorted.length !== nodes.length) {
    const remaining = nodes.filter((id) => !sorted.includes(id));
    throw new CycleError(remaining);
  }

  return sorted;
}
