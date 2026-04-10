// GitHub 데이터 리포지토리 내 파일 경로 상수
// 모든 경로는 리포 루트 기준 상대 경로

export const Paths = {
  // 사용자 프로필
  userProfile: (userId: string) => `user-modeling/users/${userId}/profile.json`,

  // 금지 표현
  forbiddenExpressions: (userId: string) =>
    `user-modeling/users/${userId}/forbidden-expressions.json`,

  // 코퍼스 인덱스
  corpusIndex: (userId: string) =>
    `user-modeling/users/${userId}/corpus/index.json`,

  // 코퍼스 샘플 본문
  corpusSample: (userId: string, sampleId: string) =>
    `user-modeling/users/${userId}/corpus/samples/${sampleId}.md`,

  // 토픽 인덱스
  topicsIndex: () => `data/index/topics.json`,

  // 포스팅 목록
  postingListIndex: () => `data/posting-list/index.json`,

  // 포스팅 메타
  postMeta: (postId: string) => `data/posting-list/posts/${postId}/meta.json`,

  // 포스팅 본문 (Master Writer가 생성한 최종본)
  postContent: (postId: string) =>
    `data/posting-list/posts/${postId}/content.md`,

  // Eval 케이스 인덱스
  evalCasesIndex: () => `evals/cases/index.json`,

  // Eval 베이스라인 결과
  evalBaselines: () => `evals/baselines/results.json`,

  // Eval 실행 결과
  evalRun: (runId: string) => `evals/runs/${runId}.json`,

  // Baseline — scenario별 승격된 최신 baseline
  baseline: (scenarioId: string) => `evals/baselines/${scenarioId}/latest.json`,

  // Baseline candidates — 수동 승격 대기 목록
  baselineCandidates: (scenarioId: string) =>
    `evals/baselines/${scenarioId}/candidates.json`,

  // exemplar index
  exemplarIndex: (userId: string) =>
    `user-modeling/users/${userId}/corpus/exemplar_index.json`,

  // 앱 설정 (토큰 등 런타임 설정값)
  appConfig: () => `data/config/app.json`,

  // 파이프라인 승인 체크포인트 (서버 재시작 복구용)
  approvalRecord: (pipelineId: string) => `data/approvals/${pipelineId}.json`,
} as const;
