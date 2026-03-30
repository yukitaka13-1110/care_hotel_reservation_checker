import { chromium } from "playwright";

// ============================================================
// 設定
// ============================================================
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const TARGET_URL =
  "https://tabichat.jp/engine/hotels/sanada_cl?guests%5B0%5D%5Badults%5D=1";

const TARGET_ROOM_TYPE = "産後ケアホテル";
const TARGET_MONTHS = [6, 7, 8, 9];

const LOOP_DURATION_MS = 15 * 60 * 1000; // 15分
const CHECK_INTERVAL_MS = 30 * 1000; // 30秒

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
  const monthHeaders = await page.locator('[class*="calendar"] [class*="month"], [class*="Calendar"] [class*="Month"], [class*="year"]').all();

  if (monthHeaders.length === 0) {
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

  const dateCells = await page.locator('table td, [class*="calendar"] [class*="day"], [class*="Calendar"] [class*="Day"], [class*="date"], [class*="cell"]').all();

  if (dateCells.length === 0) {
    console.log("日付セルが見つかりませんでした。");
    return availableDates;
  }

  for (const cell of dateCells) {
    const text = (await cell.textContent()).trim();
    if (!text || text.match(/^[日月火水木金土]$/)) continue;

    const dayMatch = text.match(/(\d{1,2})/);
    if (!dayMatch) continue;

    const day = parseInt(dayMatch[1]);
    if (day < 1 || day > 31) continue;

    const hasX = text.includes("×") || text.includes("✕") || text.includes("✗") || text.includes("╳");

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
// 空室チェック（1回分）
// ============================================================
async function checkAvailability(page) {
  console.log("ページにアクセス中...");
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);

  const title = await page.title();
  console.log(`ページタイトル: ${title}`);

  // 部屋タイプを選択
  const roomTypeOption = page.locator(`text=${TARGET_ROOM_TYPE}`).first();
  if ((await roomTypeOption.count()) > 0) {
    await roomTypeOption.click();
    console.log("部屋タイプ「産後ケアホテル」を選択しました");
    await page.waitForTimeout(2000);
  } else {
    console.log("部屋タイプ選択肢が見つかりません。全部屋タイプのまま続行します。");
  }

  // スクリーンショット（上書き保存）
  await page.screenshot({ path: "screenshot_loop.png", fullPage: true });

  const allAvailability = {};

  for (const targetMonth of TARGET_MONTHS) {
    let attempts = 0;
    const maxAttempts = 12;

    while (attempts < maxAttempts) {
      const displayedMonths = await getDisplayedMonths(page);
      console.log(`表示中の月: ${displayedMonths.map((m) => `${m.month}月${m.year}`).join(", ")}`);

      const found = displayedMonths.some((m) => m.month === targetMonth);
      if (found) break;

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

    const available = await checkCurrentCalendarAvailability(page);
    if (available.length > 0) {
      allAvailability[targetMonth] = available;
      console.log(`${targetMonth}月: 空きあり → ${available.join(", ")}日`);
    } else {
      console.log(`${targetMonth}月: 空きなし`);
    }
  }

  return allAvailability;
}

// ============================================================
// メイン処理（ループ版）
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

    const startTime = Date.now();
    let checkCount = 0;

    console.log(`=== ループチェック開始（最大${LOOP_DURATION_MS / 1000 / 60}分間、${CHECK_INTERVAL_MS / 1000}秒間隔） ===`);

    while (true) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= LOOP_DURATION_MS) {
        console.log(`\n--- ${LOOP_DURATION_MS / 1000 / 60}分経過。ループを終了します ---`);
        break;
      }

      checkCount++;
      const elapsedSec = Math.floor(elapsed / 1000);
      console.log(`\n--- チェック #${checkCount}（経過: ${elapsedSec}秒） ---`);

      const checkStartTime = Date.now();
      try {
        const availability = await checkAvailability(page);
        const hasAvailability = Object.keys(availability).length > 0;

        if (hasAvailability) {
          const lines = Object.entries(availability).map(
            ([month, days]) => `${month}月: ${days.join(", ")}日`
          );

          const message =
            `🏨 ケアホテルに空きが出ました！\n\n` +
            `${lines.join("\n")}\n\n` +
            `今すぐ確認 → ${TARGET_URL}\n\n` +
            `（${checkCount}回目のチェックで検出、経過${elapsedSec}秒）`;

          console.log(message);

          if (LINE_CHANNEL_ACCESS_TOKEN) {
            await sendLineNotification(message);
          }

          console.log("空きを検出しました。ループを終了します。");
          return;
        }
      } catch (checkError) {
        console.error(`チェック #${checkCount} でエラー: ${checkError.message}`);
      }

      // 次のチェックまで待機
      const processingTime = Date.now() - checkStartTime;
      const remaining = LOOP_DURATION_MS - (Date.now() - startTime);
      if (remaining <= 0) break;
      const waitTime = Math.min(Math.max(CHECK_INTERVAL_MS - processingTime, 0), remaining);
      console.log(`処理時間: ${(processingTime / 1000).toFixed(1)}秒、次のチェックまで ${(waitTime / 1000).toFixed(1)}秒待機...`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    console.log(`\n=== ループチェック完了: 合計${checkCount}回チェック、空き検出なし ===`);
  } catch (error) {
    console.error("エラーが発生しました:", error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
