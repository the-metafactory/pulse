import type { SeatSpec, SeatVote, TribunalDiversity, TribunalRuling } from "../types/tribunal";
export declare function abstainVote(seat: string, cause: string, model?: string): SeatVote;
export declare function parseSeatVote(seat: string, output: unknown, model?: string): SeatVote;
export interface AggregateResult {
    outcome: TribunalRuling | "tie";
    reason: string;
}
export declare function aggregate(votes: SeatVote[], confidenceBar?: number): AggregateResult;
export interface DiversityPlan {
    seats: SeatSpec[];
    diversity: TribunalDiversity;
}
export declare function planDiversity(seats: SeatSpec[]): DiversityPlan;
export declare function checkPosthocDiversity(votes: SeatVote[], diversity: TribunalDiversity): TribunalDiversity;
export declare function applyDiversityDowngrade(result: {
    outcome: TribunalRuling;
    reason: string;
}, diversity: TribunalDiversity): {
    outcome: TribunalRuling;
    reason: string;
};
export declare const VOTE_FORMAT_INSTRUCTION = "\n\nRespond with ONLY a JSON object in this exact shape:\n{\"verdict\": \"allow\" | \"deny\" | \"abstain\", \"confidence\": <number 0..1>, \"reason\": \"<one line>\"}";
