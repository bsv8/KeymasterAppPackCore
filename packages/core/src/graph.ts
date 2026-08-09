import { ERROR_CODES, KeymasterError } from "./errors.js";
import { validateLogicalPath } from "./path.js";

export interface BundleGraph {
  nodes: readonly string[];
  dependencies: ReadonlyMap<string, ReadonlySet<string>>;
}

export function createBundleGraph(input: ReadonlyMap<string, Iterable<string>>): BundleGraph {
  const names = [...input.keys()].sort();
  const all = new Set(names);
  const dependencies = new Map<string, ReadonlySet<string>>();
  for (const name of names) {
    validateLogicalPath(name);
    const refs = new Set<string>();
    for (const dependency of input.get(name) ?? []) {
      validateLogicalPath(dependency);
      if (!all.has(dependency))
        throw new KeymasterError(
          ERROR_CODES.REFERENCE_MISSING,
          `${name} references missing ${dependency}`,
          { from: name, to: dependency },
        );
      refs.add(dependency);
    }
    dependencies.set(name, refs);
  }
  return { nodes: names, dependencies };
}

export function stableDependencyOrder(graph: BundleGraph): string[] {
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const result: string[] = [];
  const visit = (node: string): void => {
    const current = state.get(node) ?? 0;
    if (current === 2) return;
    if (current === 1) {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node];
      throw new KeymasterError(
        ERROR_CODES.BUNDLE_CYCLE,
        `bundle dependency cycle: ${cycle.join(" -> ")}`,
        { cycle },
      );
    }
    state.set(node, 1);
    stack.push(node);
    for (const dependency of [...(graph.dependencies.get(node) ?? [])].sort()) visit(dependency);
    stack.pop();
    state.set(node, 2);
    result.push(node);
  };
  for (const node of [...graph.nodes].sort()) visit(node);
  return result;
}

export function stableCycle(graph: BundleGraph): string[] | undefined {
  try {
    stableDependencyOrder(graph);
    return undefined;
  } catch (error) {
    if (error instanceof KeymasterError && error.code === ERROR_CODES.BUNDLE_CYCLE)
      return error.context.cycle as string[];
    throw error;
  }
}
