import { type PipelineDef } from "./pipeline";
import type { ActionManifest } from "../types/action";
import type { FlowDef } from "../types/flow";
export interface ArcAction {
    manifest: ActionManifest;
    actionDir: string;
    packageName: string;
}
export interface ArcPipeline {
    pipeline: PipelineDef;
    yamlPath: string;
    baseDir: string;
    packageName: string;
}
export interface ArcFlow {
    flow: FlowDef;
    yamlPath: string;
    baseDir: string;
    packageName: string;
}
export declare function discoverArcActions(reposDir?: string): Promise<ArcAction[]>;
export declare function discoverArcPipelines(reposDir?: string): Promise<ArcPipeline[]>;
export declare function discoverArcFlows(reposDir?: string): Promise<ArcFlow[]>;
export declare function createArcActionDirs(reposDir?: string): Promise<string[]>;
