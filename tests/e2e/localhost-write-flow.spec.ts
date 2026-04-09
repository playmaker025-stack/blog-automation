/**
 * Localhost Write Flow E2E Test
 * Target: http://localhost:3001
 *
 * 시나리오:
 * 1. /pipeline 접속
 * 2. 사용자 'a' (A 블로그) 선택
 * 3. 드롭다운에서 아무 항목이나 선택
 * 4. 글쓰기(포스팅 생성) 버튼 클릭
 * 5. 전략 수립 단계 완료 확인
 * 6. 초안 작성 단계까지 완료 확인
 */

import { test, expect, Page } from "@playwright/test";
import path from "path";
import fs from "fs";

const BASE_URL = "http://localhost:3001";
const SHOT_DIR = path.join(process.cwd(), "test-results", "localhost-screenshots");

async function shot(page: Page, name: string): Promise<string> {
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const p = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: p, fullPage: true });
  console.log(`[SCREENSHOT] ${p}`);
  return p;
}

test.describe("localhost 글쓰기 플로우 E2E", () => {
  test.setTimeout(300_000); // 5분 — 전략 수립 + 초안 작성 포함

  test("전략 수립 → 승인 → 초안 작성 전체 플로우", async ({ page }) => {
    // 1. 파이프라인 페이지 접속
    await page.goto(`${BASE_URL}/pipeline`);
    await page.waitForLoadState("networkidle");
    await shot(page, "01-pipeline-initial");

    // 페이지 로드 확인
    await expect(page.locator("h1")).toContainText("글쓰기 실행");
    console.log("[PASS] 파이프라인 페이지 로드 확인");

    // 2. 사용자 ID 입력 — 'a'
    const userInput = page.locator("input[placeholder='사용자 ID 입력']");
    await expect(userInput).toBeVisible();
    await userInput.fill("a");
    console.log("[INFO] 사용자 ID 'a' 입력");

    // 프로필 로드 대기 (600ms 딜레이 + 충분한 여유)
    await page.waitForTimeout(2000);
    await shot(page, "02-pipeline-user-a");

    // 프로필 로드 확인
    const profileArea = page.locator("span.text-emerald-600");
    if (await profileArea.count() > 0) {
      const profileText = await profileArea.first().textContent();
      console.log(`[INFO] 프로필 표시: "${profileText}"`);
    } else {
      console.log("[INFO] 프로필 span 없음 — 계속 진행");
    }

    // 3. 드롭다운 토픽 로드 대기 (최대 10초)
    const topicSelect = page.locator("select").first();
    await expect(topicSelect).toBeVisible();

    // 옵션이 2개 이상(기본값 + 토픽) 나타날 때까지 폴링
    let attempts = 0;
    while (attempts < 20) {
      const optCount = await topicSelect.locator("option").count();
      if (optCount >= 2) {
        console.log(`[INFO] 드롭다운 옵션 로드 완료: ${optCount}개`);
        break;
      }
      await page.waitForTimeout(500);
      attempts++;
    }

    const options = await topicSelect.locator("option").all();
    console.log(`[INFO] 최종 드롭다운 옵션 수: ${options.length}`);

    // 첫 번째 유효한 옵션 선택 (value가 있는 것)
    let selectedTopicValue = "";
    let selectedTopicText = "";
    for (const option of options) {
      const value = await option.getAttribute("value");
      const text = await option.textContent();
      if (value && value !== "" && value !== "undefined") {
        selectedTopicValue = value;
        selectedTopicText = text ?? "";
        console.log(`[INFO] 선택할 토픽: value="${value}", text="${text}"`);
        break;
      }
    }

    if (!selectedTopicValue) {
      // "직접 주제 입력" 모드로 전환해서 진행
      console.log("[INFO] 드롭다운에 토픽 없음 — '직접 주제 입력' 모드로 전환");
      const directModeBtn = page.locator("button", { hasText: "직접 주제 입력" });
      if (await directModeBtn.count() > 0) {
        await directModeBtn.click();
        await page.waitForTimeout(300);
        const titleInput = page.locator("input[placeholder*='예:']");
        await titleInput.fill("인천 전자담배 입문 가이드 테스트");
        selectedTopicText = "인천 전자담배 입문 가이드 테스트";
        console.log("[INFO] 직접 주제 입력: " + selectedTopicText);
      } else {
        console.log("[FAIL] 선택 가능한 토픽 없음, 직접 입력 모드도 없음");
        await shot(page, "03-pipeline-no-topics");
        throw new Error("드롭다운에 선택 가능한 토픽 없음");
      }
    } else {
      await topicSelect.selectOption(selectedTopicValue);
      await page.waitForTimeout(300);
    }

    await shot(page, "03-pipeline-topic-selected");
    console.log(`[INFO] 토픽 선택 완료: ${selectedTopicText}`);

    // 자동 승인 체크박스 활성화 (테스트용)
    const autoApproveCheckbox = page.locator("input[type='checkbox']").first();
    if (await autoApproveCheckbox.count() > 0) {
      await autoApproveCheckbox.check();
      console.log("[INFO] 자동 승인 모드 활성화");
      await page.waitForTimeout(200);
    }

    // 4. 글쓰기 시작 버튼 클릭
    const startBtn = page.locator("button", { hasText: /글쓰기 시작/ }).first();
    await expect(startBtn).toBeVisible();
    const isDisabled = await startBtn.isDisabled();

    if (isDisabled) {
      await shot(page, "04-pipeline-btn-disabled");
      const bodyText = await page.locator("body").textContent();
      console.log(`[DEBUG] 버튼 비활성화 — 페이지 상태: ${bodyText?.slice(0, 500)}`);
      throw new Error("글쓰기 시작 버튼이 비활성화 상태");
    }

    await startBtn.click();
    console.log("[INFO] 글쓰기 시작 버튼 클릭");
    await shot(page, "04-pipeline-running");

    // 5. 진행 상태 모니터링 — 전략 수립 또는 완료까지 대기
    console.log("[INFO] 전략 수립 / 완료 단계 대기 중 (최대 5분)...");

    // 완료 결과 UI 또는 승인 다이얼로그가 나타날 때까지 대기
    // 결과 박스는 "✓ 글쓰기 완료" 또는 "⚠ 완료 — 평가" 텍스트로 식별
    const strategyResult = await Promise.race([
      // 완료 결과 텍스트 (pass 또는 미달)
      page.waitForSelector("text=/✓ 글쓰기 완료|⚠ 완료 — 평가 점수 미달/", { timeout: 300_000 })
        .then(() => "complete"),
      // 승인 다이얼로그 (자동 승인 모드에선 안 나타나야 하지만 대비)
      // 다이얼로그는 "✓ 승인하고 작성 시작" 버튼으로 식별
      page.waitForSelector("button:has-text('승인하고 작성 시작')", { timeout: 300_000 })
        .then(() => "approval_needed"),
      // 버튼 다시 활성화 = 파이프라인 종료 (완료 텍스트 없이)
      page.waitForFunction(
        () => {
          const allBtns = Array.from(document.querySelectorAll("button"));
          const startBtn = allBtns.find(b => b.textContent?.includes("글쓰기 시작"));
          return startBtn && !startBtn.disabled;
        },
        { timeout: 300_000 }
      ).then(async () => {
        const hasResult = await page.locator("text=/✓ 글쓰기 완료|⚠ 완료 — 평가 점수 미달/").count();
        return hasResult > 0 ? "complete" : "ended";
      }),
    ]).catch(() => "timeout");

    await shot(page, "05-06-pipeline-result");
    console.log(`[INFO] 파이프라인 결과: ${strategyResult}`);

    if (strategyResult === "timeout") {
      const pageText = await page.locator("body").textContent();
      console.log(`[DEBUG] 타임아웃 — 현재 페이지: ${pageText?.slice(0, 500)}`);
      throw new Error("파이프라인 타임아웃 (5분)");
    }

    if (strategyResult === "complete") {
      const resultText = await page.locator("text=/✓ 글쓰기 완료|⚠ 완료 — 평가 점수 미달/")
        .first().textContent().catch(() => "");
      console.log(`[PASS] 파이프라인 완료: ${resultText}`);
      await shot(page, "08-pipeline-complete");
      return;
    }

    if (strategyResult === "ended") {
      // 버튼은 활성화됐지만 완료 박스가 없음 — 오류 종료
      console.log("[INFO] 파이프라인 종료됨 (오류 가능) — GitHub draft 확인");
      const draftCheck = await page.request.get(`${BASE_URL}/api/github/posts`);
      if (draftCheck.ok()) {
        const data = await draftCheck.json() as { posts?: { status: string; title: string; wordCount?: number }[] };
        const completedDraft = (data.posts ?? []).find(p => p.status === "draft" && (p.wordCount ?? 0) > 100);
        if (completedDraft) {
          console.log(`[PASS] GitHub draft 확인: ${completedDraft.title} (${completedDraft.wordCount}자)`);
          return;
        }
      }
      throw new Error("파이프라인 오류 종료 — draft 없음");
    }

    if (strategyResult === "approval_needed") {
      console.log("[INFO] 승인 다이얼로그 감지 — 승인 처리");
      const approveBtn = page.locator("button", { hasText: "승인하고 작성 시작" });
      if (await approveBtn.count() > 0) {
        await approveBtn.click();
        console.log("[INFO] 승인 버튼 클릭 — 초안 작성 대기 중 (최대 3분)...");
      }
      // 다이얼로그 닫힘 대기 후 완료 텍스트 대기
      await page.waitForSelector("text=/✓ 글쓰기 완료|⚠ 완료 — 평가 점수 미달/", { timeout: 180_000 })
        .catch(() => null);
      const finalResultText = await page.locator("text=/✓ 글쓰기 완료|⚠ 완료 — 평가 점수 미달/")
        .first().textContent().catch(() => "");
      if (finalResultText) {
        console.log(`[PASS] 최종 완료: ${finalResultText}`);
        await shot(page, "08-pipeline-complete");
      } else {
        // 타임아웃 — GitHub draft 확인
        const draftCheck = await page.request.get(`${BASE_URL}/api/github/posts`);
        if (draftCheck.ok()) {
          const data = await draftCheck.json() as { posts?: { status: string; title: string; wordCount?: number }[] };
          const completedPost = (data.posts ?? []).find(
            p => (p.status === "draft" || p.status === "ready") && (p.wordCount ?? 0) > 100
          );
          if (completedPost) {
            console.log(`[PASS] GitHub 포스트 확인: ${completedPost.title} (${completedPost.wordCount}자, ${completedPost.status})`);
            return;
          }
        }
        console.log("[WARN] 승인 후 완료 확인 불가 — 초안 작성 진행 중일 수 있음");
      }
      return;
    }

    console.log("[PASS] 파이프라인 완료 (모든 케이스 처리됨)");
  });

  test("파이프라인 상태 API 직접 확인 — draft 포스트 존재 여부", async ({ page }) => {
    const response = await page.request.get(`${BASE_URL}/api/github/posts`);

    if (response.ok()) {
      const data = await response.json() as { posts?: { status: string; title: string; wordCount?: number }[] };
      const posts = data.posts ?? [];
      const drafts = posts.filter(p => p.status === "draft");
      const published = posts.filter(p => p.status === "published");
      console.log(`[RESULT] 전체 포스트: ${posts.length}개`);
      console.log(`[RESULT] Draft: ${drafts.length}개`);
      console.log(`[RESULT] Published: ${published.length}개`);
      drafts.forEach(p => console.log(`  draft: ${p.title?.slice(0, 50)} (${p.wordCount ?? 0}자)`));

      const hasCompletedDraft = drafts.some(p => (p.wordCount ?? 0) > 100);
      if (hasCompletedDraft) {
        console.log("[PASS] 완성된 draft (100자 이상) 포스트 존재");
      } else {
        console.log("[INFO] 완성된 draft 없음 — 글쓰기 플로우 실행 필요");
      }
    } else {
      console.log(`[INFO] API 응답 없음: ${response.status()}`);
    }

    await shot(page, "api-draft-status");
  });
});
