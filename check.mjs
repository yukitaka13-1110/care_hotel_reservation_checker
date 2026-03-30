import { chromium } from "playwright";

// ============================================================
// 設定
// ============================================================
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const TARGET_URL =
  "https://tabichat.jp/engine/hotels/sanada_cl?guests%5B0%5D%5Badults%5D=1";

// 監視対象の部屋タイプ名（ラジオボタンのテキストに部分一致）
const TARGET_ROOM_TYPE = "産後ケアホテル";

// 監視対象の月（6月〜9月）
const TARGET_MONTHS = [6, 7, 8, 9];

// ============================================================
// LINE通知
// ============================================================
async function sendLineNotification(message) {
  const res = await fetch("https://api.line.me/v2/bot/message/broadcast", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      messages: [{ type: "text", text: message }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`LINE通知の送信に失敗しました: ${res.status} ${body}`);
  } else {
    console.log("LINE通知を送信しました");
  }
}

// ============================================================
// カレンダーに表示中の月を取得する
// ============================================================
async function getDisplayedMonths(page) {
  // カレンダーヘッダーから「○月 2026」のようなテキストを取得
  const monthHeaders = await page.locator('[class*="calendar"] [class*="month"], [class*="Calendar"] [class*="Month"], [class*="year"]').all();

  if (monthHeaders.length === 0) {
    // フォールバック: ページ上の「N月 YYYY」パターンを探す
    const text = await page.textContent("body");
    const matches = [...text.matchAll(/(\d{1,2})月\s*(\d{4})/g)];
    return matches.map((m) => ({ month: parseInt(m[1]), year: parseInt(m[2]) }));
  }

  const months = [];
  for (const header of monthHeaders) {
    const text = await header.textContent();
    const match = text.match(/(\d{1,2})月\s*(\d{4})/);
    if (match) {
      months.push({ month: parseInt(match[1]), year: parseInt(match[2]) });
    }
  }
  return months;
}

// ============================================================
// 現在表示中のカレンダーから空き日を検出する
// ============================================================
async function checkCurrentCalendarAvailability(page) {
  const availableDates = [];

  // カレンダーの日付セルをすべて取得
  // tabichat.jpのカレンダーでは、×マークが表示されているセルは空きなし
  // それ以外（数字のみ、金額表示あり等）は空きあり
  const dateCells = await page.locator('table td, [class*="calendar"] [class*="day"], [class*="Calendar"] [class*="Day"], [class*="date"], [class*="cell"]').all();

  if (dateCells.length === 0) {
    console.log("日付セルが見つかりませんでした。スクリーンショットで確認してください。");
    return availableDates;
  }

  for (const cell of dateCells) {
    const text = (await cell.textContent()).trim();
    // 空セルや曜日ヘッダーをスキップ
    if (!text || text.match(/^[日月火水木金土]$/)) continue;

    // 日付を含むセルかどうか確認
    const dayMatch = text.match(/(\d{1,2})/);
    if (!dayMatch) continue;

    const day = parseInt(dayMatch[1]);
    if (day < 1 || day > 31) continue;

    // ×マークが含まれていなければ空きあり
    const hasX = text.includes("×") || text.includes("✕") || text.includes("✗") || text.includes("╳");

    // 無効な日付（過去日、選択不可）をスキップ
    const isDisabled =
      (await cell.getAttribute("class"))?.match(/disabled|inactive|past|unavailable/i) ||
      (await cell.getAttribute("aria-disabled")) === "true";

    if (!hasX && !isDisabled && day >= 1) {
      availableDates.push(day);
    }
  }

  return availableDates;
}

// ============================================================
// 空室チェックメイン処理
// ============================================================
export async function checkAvailability(page) {
  console.log("ページにアクセス中...");
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);

  const title = await page.title();
  console.log(`ページタイトル: ${title}`);

  // スクリーンショット（初期状態）
  await page.screenshot({ path: "screenshot_initial.png", fullPage: true });

  // 部屋タイプを選択
  console.log("部屋タイプを選択中...");
  // プルダウンまたはラジオボタンで「産後ケアホテル」を含む選択肢をクリック
  const roomTypeOption = page.locator(`text=${TARGET_ROOM_TYPE}`).first();
  if ((await roomTypeOption.count()) > 0) {
    await roomTypeOption.click();
    console.log("部屋タイプ「産後ケアホテル」を選択しました");
    await page.waitForTimeout(2000);
  } else {
    console.log("部屋タイプ選択肢が見つかりません。全部屋タイプのまま続行します。");
  }

  await page.screenshot({ path: "screenshot_room_selected.png", fullPage: true });

  // カレンダーを操作して6月〜9月の空きを確認
  const allAvailability = {};

  for (const targetMonth of TARGET_MONTHS) {
    // 目的の月が表示されるまで「次へ」ボタンを押す
    let attempts = 0;
    const maxAttempts = 12;

    while (attempts < maxAttempts) {
      const displayedMonths = await getDisplayedMonths(page);
      console.log(`表示中の月: ${displayedMonths.map((m) => `${m.month}月${m.year}`).join(", ")}`);

      const found = displayedMonths.some((m) => m.month === targetMonth);
      if (found) break;

      // 「次へ」ボタンをクリック
      const nextButton = page.locator(
        'button[aria-label*="next"], button[aria-label*="次"], [class*="next"], [class*="Next"], [class*="arrow-right"], [class*="forward"]'
      ).first();

      if ((await nextButton.count()) === 0) {
        console.log("「次へ」ボタンが見つかりません");
        break;
      }

      await nextButton.click();
      await page.waitForTimeout(1500);
      attempts++;
    }

    // 現在の表示で空き状況を確認
    const available = await checkCurrentCalendarAvailability(page);
    if (available.length > 0) {
      allAvailability[targetMonth] = available;
      console.log(`${targetMonth}月: 空きあり → ${available.join(", ")}日`);
    } else {
      console.log(`${targetMonth}月: 空きなし`);
    }

    await page.screenshot({ path: `screenshot_month_${targetMonth}.png`, fullPage: true });
  }

  return allAvailability;
}

// ============================================================
// メイン処理
// ============================================================
async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const context = await browser.newContext({
      locale: "ja-JP",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();
    const availability = await checkAvailability(page);

    const hasAvailability = Object.keys(availability).length > 0;

    if (hasAvailability) {
      const lines = Object.entries(availability).map(
        ([month, days]) => `${month}月: ${days.join(", ")}日`
      );

      const message =
        `🏨 ケアホテルに空きが出ました！\n\n` +
        `${lines.join("\n")}\n\n` +
        `今すぐ確認 → ${TARGET_URL}`;

      console.log(message);

      if (LINE_CHANNEL_ACCESS_TOKEN) {
        await sendLineNotification(message);
      } else {
        console.log("LINE_CHANNEL_ACCESS_TOKEN が未設定のため通知をスキップしました");
      }
    } else {
      console.log("空きなし。");
    }
  } catch (error) {
    console.error("エラーが発生しました:", error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
