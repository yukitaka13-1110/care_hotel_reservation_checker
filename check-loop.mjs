// ============================================================
// ケアホテル空室チェック（15分間・5秒間隔ループ版）
//
// Playwright ではなく calendar.json API を直接叩く実装。
// ============================================================
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const API_BASE = "https://tabichat.jp/engine/api/v1/hotels/sanada_cl/calendar.json";
const BOOKING_PAGE_URL =
  "https://tabichat.jp/engine/hotels/sanada_cl?guests%5B0%5D%5Badults%5D=1";
const HOTEL_ROOM_ID = 2147; // 産後ケアホテル
const TARGET_MONTHS = [6, 7, 8, 9];

const LOOP_DURATION_MS = 15 * 60 * 1000; // 15分
const CHECK_INTERVAL_MS = 5 * 1000; // 5秒

// ============================================================
// 対象期間の from_date / to_date を算出
// ============================================================
function buildTargetRange() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const minM = Math.min(...TARGET_MONTHS);
  const maxM = Math.max(...TARGET_MONTHS);
  const year = minM >= currentMonth ? currentYear : currentYear + 1;
  const pad = (n) => String(n).padStart(2, "0");
  const from = `${year}-${pad(minM)}-01`;
  const lastDay = new Date(year, maxM, 0).getDate();
  const to = `${year}-${pad(maxM)}-${pad(lastDay)}`;
  return { from, to };
}

// ============================================================
// API から空き情報を取得
// ============================================================
async function fetchAvailability() {
  const { from, to } = buildTargetRange();
  const params = new URLSearchParams({
    from_date: from,
    to_date: to,
    hotel_room_id: String(HOTEL_ROOM_ID),
    is_one_day_trip: "false",
    stays: "1",
    adults: "1",
  });
  const url = `${API_BASE}?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

// ============================================================
// LINE通知
// ============================================================
async function sendLineNotification(message) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    console.log("LINE_CHANNEL_ACCESS_TOKEN が未設定のため通知をスキップしました");
    return;
  }
  const res = await fetch("https://api.line.me/v2/bot/message/broadcast", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ messages: [{ type: "text", text: message }] }),
  });
  if (!res.ok) {
    console.error(`LINE通知の送信に失敗しました: ${res.status} ${await res.text()}`);
  } else {
    console.log("LINE通知を送信しました");
  }
}

// ============================================================
// メイン
// ============================================================
async function main() {
  const startTime = Date.now();
  let checkCount = 0;

  console.log(
    `=== ループチェック開始（最大${LOOP_DURATION_MS / 1000 / 60}分間、${CHECK_INTERVAL_MS / 1000}秒間隔） ===`,
  );

  while (Date.now() - startTime < LOOP_DURATION_MS) {
    checkCount++;
    const elapsedSec = Math.floor((Date.now() - startTime) / 1000);

    try {
      const json = await fetchAvailability();
      const rates = Array.isArray(json.rates) ? json.rates : [];

      if (checkCount % 30 === 0 || checkCount === 1) {
        console.log(`#${checkCount} (経過${elapsedSec}秒): rates=${rates.length}件`);
      }

      if (rates.length > 0) {
        const raw = JSON.stringify(json);
        const message =
          `🏨 ケアホテルに空きが出ました！\n\n` +
          `rates=${rates.length}件\n\n` +
          `生データ(先頭1000字): ${raw.slice(0, 1000)}\n\n` +
          `確認 → ${BOOKING_PAGE_URL}\n\n` +
          `（${checkCount}回目のチェックで検出、経過${elapsedSec}秒）`;

        console.log(message);
        await sendLineNotification(message);
        console.log("空きを検出しました。ループを終了します。");
        return;
      }
    } catch (e) {
      console.error(`チェック #${checkCount} でエラー: ${e.message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
  }

  console.log(`\n=== ループチェック完了: 合計${checkCount}回チェック、空き検出なし ===`);
}

main().catch((e) => {
  console.error("エラーが発生しました:", e.message);
  process.exit(1);
});
