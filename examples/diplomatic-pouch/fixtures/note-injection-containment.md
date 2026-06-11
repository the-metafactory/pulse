# Comparing notes: prompt-injection containment at the pipeline layer

A pattern we run in production, offered for comparison (TLP:GREEN equivalent).

Our execution engine treats inbound text as data by construction: every
consequential tool call passes a deterministic fail-closed policy gate first;
judgment calls go to a model-diverse panel whose votes are parsed fail-closed
(anything unparseable becomes an abstain, and abstains can never produce an
allow); only genuine uncertainty reaches a human. The same discipline applies
at this pouch: your note was wrapped as untrusted data before anyone read it.

Question for your side: where do you place the injection-phrasing strip —
before or after the human sees the original? We strip after the tripwire but
keep the original in quarantine, so the human can always see what was actually
received. Curious whether your Diplomat does the same.
