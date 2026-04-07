import { test, expect } from '@playwright/test';

const BASE = 'https://blog-automation-production-c462.up.railway.app';
const SS = 'test-results/screenshots';

test('1. 글목록 - 인코딩 버튼 없음 + counts', async ({ page }) => {
  await page.goto(`${BASE}/topics`);
  await page.waitForLoadState('networkidle');

  const encButtons = await page.locator('button:has-text("EUC-KR"), button:has-text("UTF-8")').count();
  expect(encButtons, '인코딩 버튼이 없어야 함').toBe(0);

  await page.locator('button:has-text("텍스트 붙여넣기")').click();
  const sample = "A 블로그\n전자담배 기기 추천\n카페 베스트 10\nB 블로그\n카페 베스트 10\n짧";
  await page.locator('textarea').fill(sample);
  await page.waitForTimeout(500);

  const parsed = await page.locator('text=파싱').first().textContent();
  const dup = await page.locator('text=중복').first().textContent().catch(() => '없음');
  const fail = await page.locator('text=실패').first().textContent().catch(() => '없음');
  console.log('topics_parsed_count:', parsed);
  console.log('duplicate_count:', dup);
  console.log('failed_count:', fail);

  await page.screenshot({ path: `${SS}/01_topics_counts.png` });
  expect(parsed).toContain('파싱');
});

test('2. 글목록 - 교차체크 뱃지', async ({ page }) => {
  await page.goto(`${BASE}/topics`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  const remainingBadge = await page.locator('.rounded-full:has-text("대기")').count();
  const matchedBadge = await page.locator('.rounded-full:has-text("발행완료")').count();
  console.log('대기 뱃지:', remainingBadge);
  console.log('발행완료 뱃지:', matchedBadge);
  console.log('remaining_topics_count:', remainingBadge);

  await page.screenshot({ path: `${SS}/02_topics_crosscheck.png` });
  expect(matchedBadge, '발행완료 뱃지가 1개 이상이어야 함').toBeGreaterThan(0);
});

test('3. 발행인덱스 - 인코딩 버튼 없음 + counts', async ({ page }) => {
  await page.goto(`${BASE}/posts`);
  await page.waitForLoadState('networkidle');

  await page.locator('button:has-text("TXT 가져오기")').click();
  await page.waitForTimeout(300);

  const encButtons = await page.locator('button:has-text("EUC-KR"), button:has-text("UTF-8")').count();
  expect(encButtons, '인코딩 버튼이 없어야 함').toBe(0);

  await page.locator('button:has-text("텍스트 붙여넣기")').click();
  const tsv = "1\tA\t2026-01-01\t테스트 제목 하나\thttps://blog.naver.com/test1\t키워드\n2\tB\t2026-01-01\t테스트 제목 둘\thttps://blog.naver.com/test2\t키워드";
  await page.locator('textarea').fill(tsv);
  await page.waitForTimeout(500);

  const parsed = await page.locator('text=파싱').first().textContent().catch(() => '없음');
  console.log('posts_parsed_count:', parsed);

  await page.screenshot({ path: `${SS}/03_posts_import.png` });
  expect(parsed).toContain('파싱');
});

test('4. 사용자 ID 대소문자 A vs a', async ({ page }, testInfo) => {
  testInfo.setTimeout(60000);
  await page.goto(`${BASE}/pipeline`);
  await page.waitForLoadState('networkidle');

  const input = page.locator('input[placeholder*="사용자 ID"]').first();

  await input.fill('A');
  await page.waitForTimeout(2000);
  const textA = await page.locator('span.text-xs.text-emerald-600').textContent().catch(() => '없음');
  console.log('대문자 A 프로필:', textA);
  await page.screenshot({ path: `${SS}/04a_upper.png` });

  await input.fill('');
  await input.fill('a');
  await page.waitForTimeout(2000);
  const texta = await page.locator('span.text-xs.text-emerald-600').textContent().catch(() => '없음');
  console.log('소문자 a 프로필:', texta);
  await page.screenshot({ path: `${SS}/04b_lower.png` });

  expect(textA, '대문자 A 프로필 조회 성공').not.toBe('없음');
  expect(texta, '소문자 a 프로필 조회 성공').not.toBe('없음');
  expect(textA).toBe(texta);
});

test('5. Pipeline Inspector + 남은 주제', async ({ page }) => {
  await page.goto(`${BASE}/pipeline`);
  await page.waitForLoadState('networkidle');

  await page.locator('input[placeholder*="사용자 ID"]').fill('a');
  await page.waitForTimeout(1500);

  const select = page.locator('select');
  const optionCount = await select.locator('option').count();
  console.log('remaining_topics_count(드롭다운):', optionCount - 1);

  await page.screenshot({ path: `${SS}/05_pipeline.png` });
  expect(optionCount - 1, 'a 사용자 남은 주제 있어야 함').toBeGreaterThan(0);
});
