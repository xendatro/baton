/**
 * The comment tree of an issue or task (BAT-13), Reddit style: which replies a view shows, at
 * what depth and in what order. Pure: it works on the thread's skeleton (ids, parents, times,
 * deleted flags), so the service loads full rows only for what it returns.
 */

export interface ReplySkeleton {
  id: string;
  parentReplyId: string | null;
  createdAt: Date;
  deleted: boolean;
}

export interface TreeViewOptions {
  /** Show only this reply and its answers; it is the tree's root at depth 0. */
  root?: string | undefined;
  /** Comments to select, oldest first. */
  limit: number;
  /** Levels selected: depth 0 … depth - 1. */
  depth: number;
  /** Replies whose answers are wanted as well, each up to `limit` more. */
  expand?: readonly string[] | undefined;
  /** Replies to select with their ancestors whatever the limits. */
  include?: readonly string[] | undefined;
}

export interface TreeNode {
  id: string;
  depth: number;
  /** Visible answers, selected or not. */
  replyCount: number;
}

export interface TreeView {
  /** Pre-order: parents before their answers, siblings oldest first. */
  nodes: TreeNode[];
  /** Visible comments in scope (the whole thread, or `root` and everything under it). */
  total: number;
  /** Visible top-level comments, or answers to `root`. */
  topLevelCount: number;
  /** Ancestors of `root`, outermost first. */
  ancestors: string[];
}

export class ReplyTree {
  private readonly byId = new Map<string, ReplySkeleton>();
  private readonly rank = new Map<string, number>();
  /** Visible answers per reply (`null`: top level), oldest first. */
  private readonly children = new Map<string | null, ReplySkeleton[]>();

  /** `rows` in any order; a reply whose parent is missing counts as top level. */
  constructor(rows: readonly ReplySkeleton[]) {
    const sorted = [...rows].sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    sorted.forEach((row, index) => {
      this.byId.set(row.id, row);
      this.rank.set(row.id, index);
    });
    const all = new Map<string | null, ReplySkeleton[]>();
    for (const row of sorted) {
      const parent = this.parentOf(row);
      const list = all.get(parent);
      if (list) list.push(row);
      else all.set(parent, [row]);
    }
    // Parents before answers (breadth first from the top level), then visibility bottom-up: a
    // deleted reply stays in the tree as a placeholder while any answer under it is visible.
    const order: ReplySkeleton[] = [];
    const queue = [...(all.get(null) ?? [])];
    for (let index = 0; index < queue.length; index += 1) {
      const row = queue[index]!;
      order.push(row);
      queue.push(...(all.get(row.id) ?? []));
    }
    const visible = new Set<string>();
    for (let index = order.length - 1; index >= 0; index -= 1) {
      const row = order[index]!;
      const answers = (all.get(row.id) ?? []).filter((answer) => visible.has(answer.id));
      if (!row.deleted || answers.length > 0) visible.add(row.id);
      if (answers.length > 0) this.children.set(row.id, answers);
    }
    this.children.set(
      null,
      (all.get(null) ?? []).filter((row) => visible.has(row.id)),
    );
    for (const id of [...this.byId.keys()]) {
      if (!visible.has(id)) this.byId.delete(id);
    }
  }

  private parentOf(row: ReplySkeleton): string | null {
    const parent = row.parentReplyId;
    return parent && parent !== row.id && this.byId.has(parent) ? parent : null;
  }

  /** A visible reply (live, or a placeholder with visible answers). */
  get(id: string): ReplySkeleton | undefined {
    return this.byId.get(id);
  }

  answers(id: string | null): ReplySkeleton[] {
    return this.children.get(id) ?? [];
  }

  /** Ancestors of a visible reply, outermost first. */
  ancestorsOf(id: string): string[] {
    const chain: string[] = [];
    let current = this.byId.get(id);
    while (current) {
      const parent = current.parentReplyId ? this.byId.get(current.parentReplyId) : undefined;
      if (!parent) break;
      chain.unshift(parent.id);
      current = parent;
    }
    return chain;
  }

  /** Visible comments under `id` (the whole thread for `null`). */
  countUnder(id: string | null): number {
    let count = 0;
    const stack = [...this.answers(id)];
    while (stack.length > 0) {
      const row = stack.pop()!;
      count += 1;
      stack.push(...this.answers(row.id));
    }
    return count;
  }

  /**
   * The comments a view shows. The oldest `limit` comments of the scope within `depth` levels,
   * where a comment is reachable once its parent is selected (answers are newer than what they
   * answer, so this is the oldest comments overall); then up to `limit` more under each `expand`
   * reply; then each `include` reply with its ancestors. Returns null when `root` is not a visible reply.
   */
  view(options: TreeViewOptions): TreeView | null {
    const rootId = options.root ?? null;
    if (rootId !== null && !this.byId.has(rootId)) return null;
    const depthOf = new Map<string, number>();

    const walk = (starts: readonly ReplySkeleton[], startDepth: number, budget: number) => {
      // Frontier kept sorted by age (rank), oldest first.
      const frontier: { row: ReplySkeleton; depth: number; rank: number }[] = [];
      const push = (row: ReplySkeleton, depth: number) => {
        if (depth >= options.depth) return;
        const rank = this.rank.get(row.id) ?? 0;
        let low = 0;
        let high = frontier.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (frontier[middle]!.rank < rank) low = middle + 1;
          else high = middle;
        }
        frontier.splice(low, 0, { row, depth, rank });
      };
      for (const row of starts) push(row, startDepth);
      let left = budget;
      while (left > 0 && frontier.length > 0) {
        const { row, depth } = frontier.shift()!;
        if (!depthOf.has(row.id)) {
          depthOf.set(row.id, depth);
          left -= 1;
        }
        for (const answer of this.answers(row.id)) {
          if (!depthOf.has(answer.id)) push(answer, depth + 1);
        }
      }
    };

    if (rootId === null) walk(this.answers(null), 0, options.limit);
    else {
      depthOf.set(rootId, 0);
      walk(this.answers(rootId), 1, options.limit);
    }
    for (const id of options.expand ?? []) {
      const depth = depthOf.get(id);
      if (depth === undefined) continue;
      walk(
        this.answers(id).filter((row) => !depthOf.has(row.id)),
        depth + 1,
        options.limit,
      );
    }
    for (const id of options.include ?? []) {
      if (!this.byId.has(id)) continue;
      const chain = [...this.ancestorsOf(id), id];
      const start = rootId === null ? 0 : chain.indexOf(rootId);
      if (start < 0) continue;
      chain.slice(start).forEach((ancestor, index) => {
        if (!depthOf.has(ancestor)) depthOf.set(ancestor, index);
      });
    }

    // Pre-order over the selection.
    const nodes: TreeNode[] = [];
    const stack: ReplySkeleton[] =
      rootId === null ? [...this.answers(null)].reverse() : [this.byId.get(rootId)!];
    while (stack.length > 0) {
      const row = stack.pop()!;
      const depth = depthOf.get(row.id);
      if (depth === undefined) continue;
      const answers = this.answers(row.id);
      nodes.push({ id: row.id, depth, replyCount: answers.length });
      for (let index = answers.length - 1; index >= 0; index -= 1) stack.push(answers[index]!);
    }
    return {
      nodes,
      total: rootId === null ? this.countUnder(null) : this.countUnder(rootId) + 1,
      topLevelCount: this.answers(rootId).length,
      ancestors: rootId === null ? [] : this.ancestorsOf(rootId),
    };
  }
}
