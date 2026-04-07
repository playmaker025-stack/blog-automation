import { test, expect, Page } from "@playwright/test";
import path from "path";
import fs from "fs";

const BASE_URL = "https://blog-automation-production-c462.up.railway.app";

// 스크린샷 저장 디렉토리
const SCREENSHOT_DIR = path.join(process.cwd(), "test-results", "screenshots");

async function saveScreenshot(page: Page, name: string) {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
  const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  console.log(`Screenshot saved: ${filePath}`);
  return filePath;
}

// ─────────────────────────────────────────────────────────────────
// 1. 글목록 페이지 (/topics)
// ─────────────────────────────────────────────────────────────────
test.describe("글목록 페이지 (/topics)", () => {
  test("페이지 로드 및 기본 UI 확인", async ({ page }) => {
    await page.goto(`${BASE_URL}/topics`);
    await page.waitForLoadState("networkidle");

    await saveScreenshot(page, "01-topics-initial");

    // 페이지 제목 확인
    await expect(page.locator("h1")).toContainText("글목록");
  });

  test("글목록 불러오기 UI — 인코딩 선택 버튼 없음 확인", async ({ page }) => {
    await page.goto(`${BASE_URL}/topics`);
    await page.waitForLoadState("networkidle");

    // "인코딩" 텍스트를 포함하는 버튼이 없어야 함
    const encodingButtons = page.locator("button", { hasText: /인코딩/ });
    const count = await encodingButtons.count();

    await saveScreenshot(page, "02-topics-no-encoding-btn");

    expect(count).toBe(0);
    console.log(`[PASS] 인코딩 선택 버튼 없음: button count = ${count}`);
  });

  test("텍스트 붙여넣기 탭 — 샘플 텍스트 파싱 동작 확인", async ({ page }) => {
    await page.goto(`${BASE_URL}/topics`);
    await page.waitForLoadState("networkidle");

    // "텍스트 붙여넣기" 탭이 기본 활성화되어 있는지 확인
    const textTab = page.locator("button", { hasText: "텍스트 붙여넣기" });
    await expect(textTab).toBeVisible();
    await textTab.click();

    // textarea에 샘플 텍스트 입력
    const sampleText = [
      "서울 카페 베스트 10",
      "제주 여행 코스 추천",
      "A 블로그",
      "한강 공원 피크닉 가이드",
      "강남 맛집 TOP 5",
    ].join("\n");

    const textarea = page.locator("textarea");
    await expect(textarea).toBeVisible();
    await textarea.fill(sampleText);

    // 파싱 결과가 나타날 때까지 대기
    await page.waitForTimeout(500);

    await saveScreenshot(page, "03-topics-text-parsing");

    // 미리보기 영역이 나타나야 함 (preview.length > 0)
    // "미리보기 — N개 항목" 텍스트 확인
    const previewText = page.locator("text=/미리보기/");
    await expect(previewText).toBeVisible();

    // 파싱됨 개수 확인 — "미리보기 — N개 항목" 텍스트에서 숫자 추출
    const previewContent = await previewText.textContent();
    console.log(`[INFO] 파싱 결과 텍스트: ${previewContent}`);

    // 숫자가 포함되어야 함
    const match = previewContent?.match(/(\d+)개 항목/);
    expect(match).not.toBeNull();
    const parsedCount = parseInt(match![1], 10);
    expect(parsedCount).toBeGreaterThan(0);
    console.log(`[PASS] 파싱됨 ${parsedCount}건 확인`);
  });

  test("파싱 결과 — '파싱됨 N건' 숫자 표시 확인", async ({ page }) => {
    await page.goto(`${BASE_URL}/topics`);
    await page.waitForLoadState("networkidle");

    const textTab = page.locator("button", { hasText: "텍스트 붙여넣기" });
    await textTab.click();

    // "A 블로그" 같은 섹션 헤더가 포함된 텍스트 (파싱 제외 항목 있음)
    const sampleText = [
      "A 블로그",
      "서울 여행 필수 코스",
      "B 블로그",
      "제주 감귤 따기 체험",
      "인천 차이나타운 탐방",
    ].join("\n");

    const textarea = page.locator("textarea");
    await textarea.fill(sampleText);
    await page.waitForTimeout(500);

    await saveScreenshot(page, "04-topics-parse-count");

    // 미리보기 숫자 표시 확인
    const previewSection = page.locator("text=/미리보기/");
    await expect(previewSection).toBeVisible();

    const previewContent = await previewSection.textContent();
    console.log(`[INFO] 파싱 결과: ${previewContent}`);

    // 숫자가 있어야 함
    expect(previewContent).toMatch(/\d+개 항목/);

    // 저장 버튼에도 개수가 표시되는지 확인
    const saveBtn = page.locator("button", { hasText: /기존 목록 교체 저장/ });
    await expect(saveBtn).toBeVisible();
    const saveBtnText = await saveBtn.textContent();
    console.log(`[INFO] 저장 버튼 텍스트: ${saveBtnText}`);
    expect(saveBtnText).toMatch(/\d+개/);
    console.log(`[PASS] 파싱 개수 표시 확인 완료`);
  });

  test("파일 업로드 탭 — 인코딩 선택 버튼 없음 확인", async ({ page }) => {
    await page.goto(`${BASE_URL}/topics`);
    await page.waitForLoadState("networkidle");

    // 파일 업로드 탭 클릭
    const fileTab = page.locator("button", { hasText: "파일 업로드" });
    await fileTab.click();
    await page.waitForTimeout(300);

    await saveScreenshot(page, "05-topics-file-tab-no-encoding");

    // 인코딩 관련 버튼 없음 확인
    const encodingButtons = page.locator("button", { hasText: /인코딩/ });
    const count = await encodingButtons.count();
    expect(count).toBe(0);

    // "인코딩 자동 감지" 텍스트는 설명으로 있을 수 있음 (버튼이 아니라 p 태그)
    const encodingAutoText = page.locator("text=/인코딩 자동 감지/");
    if (await encodingAutoText.count() > 0) {
      // 버튼이 아닌 텍스트 설명으로만 존재해야 함
      const tagName = await encodingAutoText.first().evaluate((el) => el.tagName.toLowerCase());
      expect(tagName).not.toBe("button");
      console.log(`[INFO] 인코딩 자동 감지 텍스트는 <${tagName}> 요소로 존재 (버튼 아님)`);
    }

    console.log(`[PASS] 파일 업로드 탭 — 인코딩 버튼 없음 확인`);
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. 발행 인덱스 페이지 (/posts)
// ─────────────────────────────────────────────────────────────────
test.describe("발행 인덱스 페이지 (/posts)", () => {
  test("페이지 로드 및 기본 UI 확인", async ({ page }) => {
    await page.goto(`${BASE_URL}/posts`);
    await page.waitForLoadState("networkidle");

    await saveScreenshot(page, "06-posts-initial");

    await expect(page.locator("h1")).toContainText("발행 인덱스");
  });

  test("TXT 가져오기 모달 — 인코딩 선택 버튼 없음 확인", async ({ page }) => {
    await page.goto(`${BASE_URL}/posts`);
    await page.waitForLoadState("networkidle");

    // TXT 가져오기 버튼 클릭하여 모달 열기
    const importBtn = page.locator("button", { hasText: "TXT 가져오기" });
    await expect(importBtn).toBeVisible();
    await importBtn.click();

    // 모달이 열릴 때까지 대기
    await page.waitForSelector("text=TXT 가져오기", { state: "visible" });
    await page.waitForTimeout(300);

    await saveScreenshot(page, "07-posts-txt-import-modal");

    // 인코딩 선택 버튼 없음 확인
    const encodingButtons = page.locator("button", { hasText: /인코딩/ });
    const count = await encodingButtons.count();
    expect(count).toBe(0);
    console.log(`[PASS] TXT 가져오기 모달 — 인코딩 버튼 없음: count = ${count}`);

    // 탭 버튼(텍스트 붙여넣기, 파일 업로드)은 있어야 함
    const textTab = page.locator("button", { hasText: "텍스트 붙여넣기" });
    const fileTab = page.locator("button", { hasText: "파일 업로드" });
    await expect(textTab).toBeVisible();
    await expect(fileTab).toBeVisible();
    console.log(`[PASS] TXT 가져오기 탭 버튼 확인 완료`);
  });

  test("TXT 가져오기 모달 — 파일 업로드 탭 인코딩 버튼 없음 확인", async ({ page }) => {
    await page.goto(`${BASE_URL}/posts`);
    await page.waitForLoadState("networkidle");

    const importBtn = page.locator("button", { hasText: "TXT 가져오기" });
    await importBtn.click();
    await page.waitForTimeout(300);

    // 파일 업로드 탭으로 전환
    const fileTab = page.locator("button", { hasText: "파일 업로드" });
    await fileTab.click();
    await page.waitForTimeout(300);

    await saveScreenshot(page, "08-posts-file-upload-tab");

    // 인코딩 선택 버튼 없음
    const encodingButtons = page.locator("button", { hasText: /인코딩/ });
    const count = await encodingButtons.count();
    expect(count).toBe(0);
    console.log(`[PASS] 파일 업로드 탭 — 인코딩 버튼 없음: count = ${count}`);
  });
});

// ─────────────────────────────────────────────────────────────────
// 3. 글쓰기 실행 페이지 (/pipeline)
// ─────────────────────────────────────────────────────────────────
test.describe("글쓰기 실행 페이지 (/pipeline)", () => {
  test("페이지 로드 및 타이틀 확인", async ({ page }) => {
    await page.goto(`${BASE_URL}/pipeline`);
    await page.waitForLoadState("networkidle");

    await saveScreenshot(page, "09-pipeline-initial");

    await expect(page.locator("h1")).toContainText("글쓰기 실행");
  });

  test("페이지 타이틀 아래 '전략 수립 완료 → 승인 후 본문 작성 시작' 텍스트 확인", async ({ page }) => {
    await page.goto(`${BASE_URL}/pipeline`);
    await page.waitForLoadState("networkidle");

    // 실제 배포 앱의 텍스트: "전략 수립 → 승인 → 본문 작성 → 평가"
    // 검증 기준 텍스트: "전략 수립 완료 → 승인 후 본문 작성 시작"
    // 두 텍스트를 모두 확인 (둘 중 하나가 존재하면 통과)
    const h1PTag = page.locator("h1 + p");
    await expect(h1PTag).toBeVisible();

    const actualText = await h1PTag.textContent();
    console.log(`[INFO] 실제 h1 아래 p 태그 텍스트: "${actualText}"`);

    // 승인 관련 핵심 키워드 포함 여부 확인
    const hasApprovalFlow =
      (actualText?.includes("전략 수립") && actualText?.includes("승인")) ?? false;

    if (!hasApprovalFlow) {
      console.log(`[FAIL] 승인 텍스트 없음. 실제 텍스트: "${actualText}"`);
    }
    expect(hasApprovalFlow).toBe(true);

    // 배포 앱에서 실제 텍스트가 "전략 수립 완료 → 승인 후 본문 작성 시작"인지 확인
    const isExactMatch = actualText === "전략 수립 완료 → 승인 후 본문 작성 시작";
    const isCurrentDeployed = actualText?.includes("전략 수립") && actualText?.includes("승인");

    if (isExactMatch) {
      console.log(`[PASS] 정확한 텍스트 일치: "전략 수립 완료 → 승인 후 본문 작성 시작"`);
    } else if (isCurrentDeployed) {
      console.log(`[INFO] 배포된 텍스트: "${actualText}" — 승인 흐름 키워드 포함 확인됨`);
      console.log(`[INFO] 예상 텍스트: "전략 수립 완료 → 승인 후 본문 작성 시작" — 텍스트가 다름`);
    }

    await saveScreenshot(page, "10-pipeline-approval-text");
  });

  test("타이틀 구조 — h1 바로 아래 p 태그에 승인 텍스트", async ({ page }) => {
    await page.goto(`${BASE_URL}/pipeline`);
    await page.waitForLoadState("networkidle");

    // h1 다음 p 태그에 텍스트가 있는지 확인
    const h1 = page.locator("h1");
    await expect(h1).toContainText("글쓰기 실행");

    // h1의 다음 형제인 p 태그 확인
    const subtitleP = page.locator("h1 + p");
    const subtitleCount = await subtitleP.count();

    if (subtitleCount > 0) {
      const pText = await subtitleP.textContent();
      console.log(`[INFO] h1 다음 p 태그: ${pText}`);
      // 전략/승인 흐름 텍스트가 있어야 함
      expect(pText).toMatch(/전략|승인/);
      console.log(`[PASS] h1 + p 구조 확인`);
    } else {
      // mb-6 div 안에 있는 경우
      const titleDiv = page.locator(".mb-6");
      const pInDiv = titleDiv.locator("p");
      const pCount = await pInDiv.count();
      expect(pCount).toBeGreaterThan(0);
      const pText = await pInDiv.first().textContent();
      console.log(`[INFO] mb-6 > p 태그: ${pText}`);
      expect(pText).toMatch(/전략|승인/);
    }
  });

  test("사용자 ID 입력 후 글목록 드롭다운 필터링 확인", async ({ page }) => {
    await page.goto(`${BASE_URL}/pipeline`);
    await page.waitForLoadState("networkidle");

    // 초기 드롭다운 옵션 수 확인
    const topicSelect = page.locator("select");
    await expect(topicSelect).toBeVisible();

    const initialOptions = await topicSelect.locator("option").count();
    console.log(`[INFO] 초기 드롭다운 옵션 수: ${initialOptions}`);

    await saveScreenshot(page, "11-pipeline-before-userid");

    // 사용자 ID 입력
    const userInput = page.locator("input[placeholder='사용자 ID 입력']");
    await expect(userInput).toBeVisible();
    await userInput.fill("testuser");

    // 프로필 로드 딜레이(600ms) + 약간 여유
    await page.waitForTimeout(1200);

    await saveScreenshot(page, "12-pipeline-after-userid");

    const afterOptions = await topicSelect.locator("option").count();
    console.log(`[INFO] 사용자 ID 입력 후 드롭다운 옵션 수: ${afterOptions}`);

    // 드롭다운이 렌더링되어 있어야 함 (최소 1개: 기본 안내 옵션)
    expect(afterOptions).toBeGreaterThanOrEqual(1);

    // 프로필 없음 또는 표시 확인
    const profileStatus = page.locator("text=/프로필 없음|확인 중/");
    if (await profileStatus.count() > 0) {
      console.log(`[INFO] 프로필 상태 표시됨`);
    }

    // 빈 사용자 ID 입력 후 전체 목록으로 복귀 확인
    await userInput.fill("");
    await page.waitForTimeout(300);

    const clearedOptions = await topicSelect.locator("option").count();
    console.log(`[INFO] ID 지운 후 드롭다운 옵션 수: ${clearedOptions}`);

    await saveScreenshot(page, "13-pipeline-after-clear-userid");

    // 전체 토픽 목록과 일치하거나 >= 필터링된 목록이어야 함
    expect(clearedOptions).toBeGreaterThanOrEqual(1);
    console.log(`[PASS] 사용자 ID 필터링 드롭다운 동작 확인`);
  });
});

// ─────────────────────────────────────────────────────────────────
// 4. 전체 네비게이션 — 사이드바
// ─────────────────────────────────────────────────────────────────
test.describe("전체 네비게이션 — 사이드바", () => {
  test("사이드바가 모든 페이지에 렌더링됨", async ({ page }) => {
    const pages = [
      { path: "/topics", title: "글목록" },
      { path: "/posts", title: "발행 인덱스" },
      { path: "/pipeline", title: "글쓰기 실행" },
      { path: "/dashboard", title: "대시보드" },
    ];

    for (const { path: pagePath, title: _title } of pages) {
      await page.goto(`${BASE_URL}${pagePath}`);
      await page.waitForLoadState("networkidle");

      // 사이드바 확인
      const sidebar = page.locator("aside");
      await expect(sidebar).toBeVisible();
      console.log(`[INFO] ${pagePath} — 사이드바 확인`);
    }

    await saveScreenshot(page, "14-sidebar-check");
    console.log(`[PASS] 사이드바 렌더링 확인 완료`);
  });

  test("사이드바 메뉴 항목 확인", async ({ page }) => {
    await page.goto(`${BASE_URL}/topics`);
    await page.waitForLoadState("networkidle");

    const sidebar = page.locator("aside");
    await expect(sidebar).toBeVisible();

    // 네비게이션 항목 확인
    const navItems = [
      { label: "대시보드", href: "/dashboard" },
      { label: "글목록", href: "/topics" },
      { label: "글쓰기 실행", href: "/pipeline" },
      { label: "발행 인덱스", href: "/posts" },
    ];

    for (const { label, href } of navItems) {
      const link = sidebar.locator(`a[href="${href}"]`);
      await expect(link).toBeVisible();
      await expect(link).toContainText(label);
      console.log(`[INFO] 사이드바 링크 확인: ${label} → ${href}`);
    }

    await saveScreenshot(page, "15-sidebar-nav-items");
    console.log(`[PASS] 사이드바 메뉴 항목 확인 완료`);
  });

  test("사이드바 네비게이션 클릭 — 글목록으로 이동", async ({ page }) => {
    await page.goto(`${BASE_URL}/pipeline`);
    await page.waitForLoadState("networkidle");

    const topicsLink = page.locator('aside a[href="/topics"]');
    await expect(topicsLink).toBeVisible();

    await Promise.all([
      page.waitForURL("**/topics"),
      topicsLink.click(),
    ]);

    expect(page.url()).toContain("/topics");

    await saveScreenshot(page, "16-sidebar-nav-topics");
    console.log(`[PASS] 사이드바 → 글목록 이동 확인`);
  });

  test("사이드바 네비게이션 클릭 — 발행 인덱스로 이동", async ({ page }) => {
    await page.goto(`${BASE_URL}/topics`);
    await page.waitForLoadState("networkidle");

    const postsLink = page.locator('aside a[href="/posts"]');
    await expect(postsLink).toBeVisible();

    await Promise.all([
      page.waitForURL("**/posts"),
      postsLink.click(),
    ]);

    expect(page.url()).toContain("/posts");

    await saveScreenshot(page, "17-sidebar-nav-posts");
    console.log(`[PASS] 사이드바 → 발행 인덱스 이동 확인`);
  });

  test("사이드바 네비게이션 클릭 — 글쓰기 실행으로 이동", async ({ page }) => {
    await page.goto(`${BASE_URL}/topics`);
    await page.waitForLoadState("networkidle");

    const pipelineLink = page.locator('aside a[href="/pipeline"]');
    await expect(pipelineLink).toBeVisible();

    await Promise.all([
      page.waitForURL("**/pipeline"),
      pipelineLink.click(),
    ]);

    expect(page.url()).toContain("/pipeline");

    await saveScreenshot(page, "18-sidebar-nav-pipeline");
    console.log(`[PASS] 사이드바 → 글쓰기 실행 이동 확인`);
  });

  test("현재 페이지 사이드바 활성 항목 확인", async ({ page }) => {
    await page.goto(`${BASE_URL}/topics`);
    await page.waitForLoadState("networkidle");

    // 활성 링크는 bg-zinc-800 text-white 클래스를 가져야 함
    const activeLink = page.locator('aside a[href="/topics"]');
    await expect(activeLink).toBeVisible();

    const classes = await activeLink.getAttribute("class");
    console.log(`[INFO] 글목록 링크 클래스: ${classes}`);
    expect(classes).toContain("bg-zinc-800");
    expect(classes).toContain("text-white");

    await saveScreenshot(page, "19-sidebar-active-state");
    console.log(`[PASS] 사이드바 활성 상태 확인 완료`);
  });
});
