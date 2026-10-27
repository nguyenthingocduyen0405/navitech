"""RAG, 온톨로지, Agent가 함께 쓰는 자료 접근 규칙.

저장되는 모든 chunk / 온톨로지 node의 메타데이터 규약:
    classification: int          1=공개 2=사내 3=대외비 4=극비 (필수)
    allowed_groups: list[str]    선택; 지정하면 사용자가 그중 하나 이상에 속해야 함
    meeting_id:     str          선택; 회의 단위 접근 제어용으로 예약
    source:         str          출처 (DART, 뉴스 URL, 파일명 등)

검색 시에는 유사도 검색 *이전에* 벡터/그래프 쿼리 안에서 `retrieval_filter(ctx)`를
적용해야 합니다. 먼저 가져온 뒤 LLM에게 사용자가 볼 수 없는 내용을 "무시"하라고 해서는 안 됩니다.
"""

from shared.user_context import UserContext


def retrieval_filter(ctx: UserContext) -> dict:
    """벡터 DB / 그래프 쿼리에 넣을 필터 값.

    pgvector 예시:
        WHERE classification <= :max_classification
          AND (allowed_groups IS NULL OR allowed_groups && :groups)
    """
    return {
        "max_classification": ctx.clearance,
        "groups": sorted(ctx.groups),
    }


def can_read(ctx: UserContext, metadata: dict) -> bool:
    """`retrieval_filter`와 같은 규칙을 Python에서 항목 하나에 적용합니다."""
    if metadata["classification"] > ctx.clearance:
        return False
    allowed_groups = metadata.get("allowed_groups")
    if allowed_groups and not ctx.groups.intersection(allowed_groups):
        return False
    return True
