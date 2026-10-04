"""Data-level access rules shared by RAG, ontology and agents.

Contract for every stored chunk / ontology node (metadata):
    classification: int          1=공개 2=사내 3=대외비 4=극비 (required)
    allowed_groups: list[str]    optional; if set, user must be in at least one
    meeting_id:     str          optional; reserved for meeting-scoped access
    source:         str          where it came from (DART, news URL, file name...)

Retrieval must apply `retrieval_filter(ctx)` inside the vector/graph query itself,
BEFORE similarity search. Never fetch first and let the LLM "ignore" what the
user may not see.
"""

from shared.user_context import UserContext


def retrieval_filter(ctx: UserContext) -> dict:
    """Filter values to push down into the vector DB / graph query.

    pgvector example:
        WHERE classification <= :max_classification
          AND (allowed_groups IS NULL OR allowed_groups && :groups)
    """
    return {
        "max_classification": ctx.clearance,
        "groups": sorted(ctx.groups),
    }


def can_read(ctx: UserContext, metadata: dict) -> bool:
    """Same rule as `retrieval_filter`, for checking a single item in Python."""
    if metadata["classification"] > ctx.clearance:
        return False
    allowed_groups = metadata.get("allowed_groups")
    if allowed_groups and not ctx.groups.intersection(allowed_groups):
        return False
    return True
