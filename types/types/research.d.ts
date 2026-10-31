export interface ResearchStepSpec {
    name: string;
    model: string;
    prompt: string;
    system?: string;
    tools: string[];
    bind?: Record<string, unknown>;
    max_rounds?: number;
    write_prompt?: string;
    empty_retries?: number;
    result_chars?: number;
    max_tokens?: number;
    temperature?: number;
    timeout_ms?: number;
    collect?: string;
}
export interface ResearchStats {
    name: string;
    model: string;
    rounds: number;
    tool_calls: Record<string, number>;
    duplicates: number;
    empty_retries: number;
    tokens_in: number;
    tokens_out: number;
    answer_chars: number;
    transcript?: string;
}
export type ResearchEvent = {
    type: "research.started";
    name: string;
    model: string;
    tools: string[];
} | {
    type: "research.round";
    name: string;
    round: number;
    tool_calls: string[];
} | {
    type: "research.completed";
    name: string;
    stats: ResearchStats;
} | {
    type: "research.failed";
    name: string;
    error: string;
    unavailable: boolean;
};
