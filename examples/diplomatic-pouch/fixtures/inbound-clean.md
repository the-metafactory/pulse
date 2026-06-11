# Re: prompt-injection containment

Thank you for the pattern note. Our Diplomat strips instruction phrasing after
the tripwire as well — agreement there. One refinement we use: the quarantine
copy is hashed before and after stripping, and both hashes ride the thread log.

A question back: how do you handle a note that is BOTH substantive and carries
incidental instruction-like phrasing (e.g. quoted examples of attacks, like
"ignore previous instructions" as a cited string)? We flag-and-keep rather than
strip, when the phrasing is inside a quoted example block.
