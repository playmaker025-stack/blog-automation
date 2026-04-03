import { getGitHubClient, getRepoConfig } from "./client";

export interface FileContent {
  content: string;
  sha: string;
}

export interface FileEntry {
  name: string;
  path: string;
  sha: string;
  type: "file" | "dir";
}

// ============================================================
// 파일 읽기
// ============================================================

export async function readFile(filePath: string): Promise<FileContent> {
  const octokit = getGitHubClient();
  const { owner, repo, branch } = getRepoConfig();

  const response = await octokit.repos.getContent({
    owner,
    repo,
    path: filePath,
    ref: branch,
  });

  const data = response.data;
  if (Array.isArray(data) || data.type !== "file") {
    throw new Error(`"${filePath}"는 파일이 아닙니다.`);
  }

  const content = Buffer.from(data.content, "base64").toString("utf-8");
  return { content, sha: data.sha };
}

export async function readJsonFile<T>(filePath: string): Promise<{ data: T; sha: string }> {
  const { content, sha } = await readFile(filePath);
  return { data: JSON.parse(content) as T, sha };
}

// ============================================================
// 파일 쓰기 (생성 또는 업데이트)
// ============================================================

export async function writeFile(
  filePath: string,
  content: string,
  message: string,
  sha: string | null = null
): Promise<string> {
  const octokit = getGitHubClient();
  const { owner, repo, branch } = getRepoConfig();

  const encoded = Buffer.from(content, "utf-8").toString("base64");

  // [skip ci] — 데이터 커밋이 Railway 재배포를 트리거하지 않도록
  const commitMessage = message.includes("[skip ci]")
    ? message
    : `${message} [skip ci]`;

  const response = await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message: commitMessage,
    content: encoded,
    branch,
    ...(sha ? { sha } : {}),
  });

  return response.data.content?.sha ?? "";
}

export async function writeJsonFile<T>(
  filePath: string,
  data: T,
  message: string,
  sha: string | null = null
): Promise<string> {
  const content = JSON.stringify(data, null, 2);
  return writeFile(filePath, content, message, sha);
}

// ============================================================
// 파일 존재 여부 확인
// ============================================================

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "status" in err &&
      (err as { status: number }).status === 404
    ) {
      return false;
    }
    throw err;
  }
}

// ============================================================
// 디렉토리 내 파일 목록
// ============================================================

export async function listFiles(dirPath: string): Promise<FileEntry[]> {
  const octokit = getGitHubClient();
  const { owner, repo, branch } = getRepoConfig();

  const response = await octokit.repos.getContent({
    owner,
    repo,
    path: dirPath,
    ref: branch,
  });

  const data = response.data;
  if (!Array.isArray(data)) {
    throw new Error(`"${dirPath}"는 디렉토리가 아닙니다.`);
  }

  return data.map((item) => ({
    name: item.name,
    path: item.path,
    sha: item.sha,
    type: item.type as "file" | "dir",
  }));
}
