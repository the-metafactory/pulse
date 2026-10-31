import type { AgentSovereignty } from "./agent";
export interface SeatSpec {
    name: string;
    capability: string;
    prompt: string;
    sovereignty?: AgentSovereignty;
    timeout_ms?: number;
}
export type SeatVerdict = "allow" | "deny" | "abstain";
export type TribunalRuling = "allow" | "deny" | "defer";
export interface SeatVote {
    seat: string;
    verdict: SeatVerdict;
    confidence: number;
    reason: string;
    model?: string;
    abstain_cause?: string;
}
export interface TribunalDiversity {
    classes: string[];
    reassigned_seat?: string;
    unsatisfiable?: boolean;
    posthoc_monoculture?: boolean;
}
export interface TribunalVerdict {
    name: string;
    verdict: TribunalRuling;
    reason: string;
    votes: SeatVote[];
    diversity: TribunalDiversity;
    tiebreak?: SeatVote;
    convened_at: string;
    ruled_at: string;
}
export interface TribunalStepSpec {
    name: string;
    seats: SeatSpec[];
    tiebreaker?: SeatSpec;
    confidence_bar?: number;
    on_defer?: "fail" | "continue";
    timeout_ms?: number;
    collect?: string;
}
export type TribunalEvent = {
    type: "tribunal.convened";
    name: string;
    seats: string[];
    convened_at: string;
} | {
    type: "tribunal.seat_voted";
    name: string;
    vote: SeatVote;
} | {
    type: "tribunal.tiebreak";
    name: string;
    vote: SeatVote;
} | {
    type: "tribunal.verdict";
    name: string;
    verdict: TribunalVerdict;
};
