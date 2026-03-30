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
const CHECK_INTERVAL_MS = 1 * 1000; // 1秒

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
  const headers = await page.locator("div.css-qb8zhg").all();

  const months = [];
  for (const header of headers) {
    const text = (await header.textContent()).trim();
    const match = text.match(/(\d{1,2})月\s*(\d{4})/);
    if (match) {
      months.push({ month: parseInt(match[1]), year: parseInt(match[2]) });
    }
  }

  if (months.length > 0) return months;

  // フォールバック
  console.log("月ヘッダーセレクタが変更された可能性があります。フォールバック検出を使用...");
  const bodyText = await page.textContent("body");
  const matches = [...bodyText.matchAll(/(\d{1,2})月\s+(\d{4})/g)];
  return matches
    .map((m) => ({ month: parseInt(m[1]), year: parseInt(m[2]) }))
    .filter((m) => m.month >= 1 && m.month <= 12);
}

// ============================================================
// 次の月へ進む
// ============================================================
async function goToNextMonth(page) {
  const nextButton = page.locator("a.css-183ow1f").last();

  if ((await nextButton.count()) === 0) {
    console.log("「次へ」ボタンが見つかりません。");
    return false;
  }

  await nextButton.click();
  await page.waitForTimeout(1500);
  return true;
}

// ============================================================
// 現在表示中のカレンダーから空き日を検出する
//
// 判定: 以下のいずれかを満たすセルを「空きあり」とする
//   1. 親span の cursor が pointer（クリック可能）
//   2. css-qdcf6i の cursor が pointer（×マークがクリック可能＝空きあり）
//      ※ ×は ::before/::after 疑似要素で描画されるためテキストでは拾えない
// ============================================================
async function checkCurrentCalendarAvailability(page, targetMonth) {
  const result = await page.evaluate((tMonth) => {
    const containers = document.querySelectorAll("div.css-fco0xz");
    if (containers.length === 0) return { error: "カレンダーコンテナが見つかりません", available: [] };

    const monthHeaders = document.querySelectorAll("div.css-qb8zhg");
    let targetContainerIndex = -1;

    for (let i = 0; i < monthHeaders.length; i++) {
      const text = monthHeaders[i].textContent.trim();
      const match = text.match(/(\d{1,2})月/);
      if (match && parseInt(match[1]) === tMonth) {
        targetContainerIndex = i;
        break;
      }
    }

    if (targetContainerIndex === -1) return { error: `${tMonth}月のヘッダーが見つかりません`, available: [] };

    const container = containers[targetContainerIndex];
    if (!container) return { error: `${tMonth}月のコンテナが見つかりません`, available: [] };

    const dateSpans = container.querySelectorAll("span[class]");
    const available = [];
    const PAST_CLASS = "css-1awambs";

    for (const span of dateSpans) {
      const children = span.querySelectorAll(":scope > span");
      if (children.length === 0) continue;

      const dayText = children[0].textContent.trim();
      if (!/^\d{1,2}$/.test(dayText)) continue;
      const day = parseInt(dayText);
      if (day < 1 || day > 31) continue;

      if (span.className === PAST_CLASS) continue;

      const parentStyle = window.getComputedStyle(span);

      const statusSpan = span.querySelector(".css-qdcf6i");
      const statusCursor = statusSpan ? window.getComputedStyle(statusSpan).cursor : "auto";

      const isAvailable =
        parentStyle.cursor === "pointer" ||
        statusCursor === "pointer";

      if (isAvailable) {
        available.push(day);
      }
    }

    return { available };
  }, targetMonth);

  if (result.error) {
    console.log(result.error);
    return [];
  }

  return result.available;
}

// ============================================================
// 部屋タイプを選択
// ============================================================
async function selectRoomType(page) {
  const roomTypeDropdown = page.locator("text=全ての部屋タイプ").first();

  if ((await roomTypeDropdown.count()) === 0) {
    console.log("「全ての部屋タイプ」ドロップダウンが見つかりません。");
    return false;
  }

  await roomTypeDropdown.click();
  await page.waitForTimeout(1000);

  const option = page.locator(`text=${TARGET_ROOM_TYPE}`).first();

  if ((await option.count()) === 0) {
    console.log(`「${TARGET_ROOM_TYPE}」の選択肢が見つかりません。`);
    return false;
  }

  await option.click();
  console.log(`部屋タイプ「${TARGET_ROOM_TYPE}」を選択しました`);
  await page.waitForTimeout(2000);
  return true;
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
  await selectRoomType(page);

  const allAvailability = {};

  for (const targetMonth of TARGET_MONTHS) {
    let attempts = 0;
    const maxAttempts = 12;

    while (attempts < maxAttempts) {
      const displayedMonths = await getDisplayedMonths(page);
      const found = displayedMonths.some((m) => m.month === targetMonth);
      if (found) break;

      const navigated = await goToNextMonth(page);
      if (!navigated) break;
      attempts++;
    }

    if (attempts >= maxAttempts) {
      console.log(`${targetMonth}月への移動に失敗しました`);
      continue;
    }

    const available = await checkCurrentCalendarAvailability(page, targetMonth);
    if (available.length > 0) {
      allAvailability[targetMonth] = available;
      console.log(`${targetMonth}月: 空きあり → ${available.join(", ")}日`);
      // 空きがあった月のスクリーンショットを保存
      await page.screenshot({ path: `available_month_${targetMonth}.png`, fullPage: true });
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

      // 次のチェックまで1秒待機
      await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
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
