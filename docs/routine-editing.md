# Routine inspection and parameter proposals

`pulse routine-contract` reads one JSON document from stdin: `{yaml, patches}`. It validates the pipeline without executing any action and returns a redacted `view`. Each step has its installed path, action, connection label, visible parameters and editable field descriptors. Nested bodies and named parallel branches retain their order. Bindings remain distinct from literal values. Unknown and private values are hidden.

When `patches` is nonempty, the result also contains the validated YAML for the routine owner to commit. This YAML is private owner input and must not be sent to a browser or model. Pulse preserves unrelated YAML fields, comments and ownership markers. A patch can change only a field declared editable by Pulse's contract. The first contract supports retry attempts, backoff and delays, derived from the same schema used by retry validation and execution. Other primitives and plain actions remain read-only.

`pulse compose --request "use four attempts" --routine-edit '<redacted view JSON>' --json` uses the configured composer model route and returns `{status:"edit", patches:[...]}`. It sends only the declared editable field paths, schemas and current safe values to the model. It validates the returned field paths and values before replying. It neither writes the installed flow nor executes it. The caller must show the proposed changes, obtain explicit confirmation and use the routine owner's current revision when applying them.

Model configuration uses the existing `compose` flags and environment. No additional provider is selected by this command. Ownership checks, revision checks and atomic file updates belong to the routine owner, not Pulse.
