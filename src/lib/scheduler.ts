import type { PulseNode, PulseResult, NodeStatus } from "../types/pulse";

export class Scheduler {
  private nodes = new Map<string, PulseNode>();
  private statuses = new Map<string, NodeStatus>();
  private results = new Map<string, PulseResult>();

  initialize(nodes: PulseNode[]): void {
    this.nodes.clear();
    this.statuses.clear();
    this.results.clear();

    for (const node of nodes) {
      this.nodes.set(node.id, node);
      this.statuses.set(node.id, "pending");
    }
  }

  /** Get node IDs that are ready to execute (all deps satisfied) */
  getReady(): string[] {
    const ready: string[] = [];
    for (const [id, status] of this.statuses) {
      if (status !== "pending") continue;
      if (this.checkDependencies(id)) {
        ready.push(id);
      }
    }
    return ready;
  }

  /** Check if all dependencies of a node are done */
  checkDependencies(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    for (const dep of node.dependsOn ?? []) {
      if (this.statuses.get(dep) !== "done") return false;
    }
    return true;
  }

  markRunning(nodeId: string): void {
    this.statuses.set(nodeId, "running");
  }

  markDone(nodeId: string, result: PulseResult): void {
    this.statuses.set(nodeId, "done");
    this.results.set(nodeId, result);
  }

  markFailed(nodeId: string, result: PulseResult): void {
    this.statuses.set(nodeId, "failed");
    this.results.set(nodeId, result);
  }

  /** Mark all descendants as skipped when a node exhausts retries */
  skipSubtree(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;

    for (const childId of node.children) {
      const childStatus = this.statuses.get(childId);
      if (childStatus === "pending") {
        this.statuses.set(childId, "skipped");
        this.results.set(childId, {
          nodeId: childId,
          status: "skipped",
          attempts: 0,
        });
        // Recursively skip children of children
        this.skipSubtree(childId);
      }
    }
  }

  getStatus(nodeId: string): NodeStatus | undefined {
    return this.statuses.get(nodeId);
  }

  getResult(nodeId: string): PulseResult | undefined {
    return this.results.get(nodeId);
  }

  getAllResults(): Map<string, PulseResult> {
    return new Map(this.results);
  }

  /** Check if all nodes are in a terminal state */
  isComplete(): boolean {
    for (const status of this.statuses.values()) {
      if (status === "pending" || status === "running") return false;
    }
    return true;
  }
}
