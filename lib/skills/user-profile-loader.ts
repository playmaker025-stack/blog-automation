import { readJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import type { UserProfile, ForbiddenExpressions } from "@/lib/types/github-data";
import type {
  UserProfileLoaderInput,
  UserProfileLoaderOutput,
} from "@/lib/types/skill";

const DEFAULT_FORBIDDEN: ForbiddenExpressions = {
  userId: "",
  expressions: [],
  updatedAt: new Date().toISOString(),
};

export async function userProfileLoader(
  input: UserProfileLoaderInput
): Promise<UserProfileLoaderOutput> {
  const { userId } = input;

  const profilePath = Paths.userProfile(userId);
  const forbiddenPath = Paths.forbiddenExpressions(userId);

  const profileExists = await fileExists(profilePath);
  if (!profileExists) {
    throw new Error(`사용자 "${userId}"의 프로필을 찾을 수 없습니다.`);
  }

  const [{ data: profile }, forbiddenResult] = await Promise.all([
    readJsonFile<UserProfile>(profilePath),
    fileExists(forbiddenPath).then((exists) =>
      exists
        ? readJsonFile<ForbiddenExpressions>(forbiddenPath)
        : Promise.resolve({ data: { ...DEFAULT_FORBIDDEN, userId }, sha: "" })
    ),
  ]);

  return {
    profile,
    forbiddenExpressions: forbiddenResult.data,
  };
}
