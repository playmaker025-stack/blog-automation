# /compose — 블로그 포스팅 생성

주어진 토픽 ID와 사용자 ID로 전체 포스팅 파이프라인을 실행한다.

## 사용법

```
/compose topicId=<토픽ID> userId=<사용자ID>
```

## 실행 흐름

1. orchestrator 에이전트를 호출하여 파이프라인 시작
2. strategy-planner로 전략 수립
3. 제목/방향 변경 감지 및 승인 요청 (필요시)
4. master-writer로 본문 생성 (SSE 스트리밍)
5. harness-evaluator로 품질 평가
6. posting-list + index 교차 업데이트

## 예시

```
/compose topicId=topic-abc123 userId=user-001
```
