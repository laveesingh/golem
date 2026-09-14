You are authorized to coordinate this named fixture spec through SDD.

Spec: LARGE-pipeline-split — two independently owned implementation slices with one
shared integration acceptance: (a) a build output manifest, (b) a consumer that
validates that manifest in CI. Both must agree on the manifest schema; neither owns
the other.

Decompose: create child specs where the work boundaries are meaningful, keep the
shared integration acceptance and dependencies in the parent, and say exactly what
the parent keeps. Do not split by word count; if one slice is not meaningfully
independent, keep it in the parent and say why.
