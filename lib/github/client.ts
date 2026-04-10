import { Octokit } from "@octokit/rest";

let _client: Octokit | null = null;

export function getGitHubClient(): Octokit {
  if (_client) return _client;

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN 환경 변수가 설정되지 않았습니다.");
  }

  _client = new Octokit({ auth: token, request: { timeout: 20_000 } });
  return _client;
}

export function parseRepo(repo: string): { owner: string; repo: string } {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`GITHUB_DATA_REPO 형식이 잘못됐습니다: "${repo}". "owner/repo" 형식이어야 합니다.`);
  }
  return { owner: parts[0], repo: parts[1] };
}

export function getRepoConfig(): { owner: string; repo: string; branch: string } {
  const repoStr = process.env.GITHUB_DATA_REPO;
  if (!repoStr) {
    throw new Error("GITHUB_DATA_REPO 환경 변수가 설정되지 않았습니다.");
  }
  const { owner, repo } = parseRepo(repoStr);
  const branch = process.env.GITHUB_DATA_REPO_BRANCH ?? "main";
  return { owner, repo, branch };
}
