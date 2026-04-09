// ============================================================
// ケアホテル空室チェック（1回だけ）
//
// Playwright ではなく calendar.json API を直接叩く実装。
// - GET /engine/api/v1/hotels/sanada_cl/calendar.json
// - 認証不要・CloudFront はスルー (cache-control: private)
// - レスポンスは {"rates": [...]} 形式。空きなしなら空配列
// ============================================================
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const API_BASE = "https://tabichat.jp/engine/api/v1/hotels/sanada_cl/calendar.json";
const BOOKING_PAGE_URL =
  "https://tabichat.jp/engine/hotels/sanada_cl?guests%5B0%5D%5Badults%5D=1";
const HOTEL_ROOM_ID = 2147; // 産後ケアホテル
const TARGET_MONTHS = [6, 7, 8, 9];

// ============================================================
// 対象期間の from_date / to_date を算出
// TARGET_MONTHS の最小月〜最大月を、未来側にあたる年で 1 リクエストに集約
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
  console.log(`GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json;
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
  const json = await fetchAvailability();
  const rates = Array.isArray(json.rates) ? json.rates : [];
  console.log(`rates=${rates.length}件`);

  if (rates.length === 0) {
    console.log("空きなし");
    return;
  }

  // 空きあり: JSON 形状は実データを見ないと確定できないので、生データを丸ごと通知に同梱する
  const raw = JSON.stringify(json);
  const message =
    `🏨 ケアホテルに空きが出ました！\n\n` +
    `rates=${rates.length}件\n\n` +
    `生データ(先頭1000字): ${raw.slice(0, 1000)}\n\n` +
    `確認 → ${BOOKING_PAGE_URL}`;

  console.log(message);
  await sendLineNotification(message);
}

main().catch((e) => {
  console.error("エラーが発生しました:", e.message);
  process.exit(1);
});
