// ================================================================
//  極の塔 ランキングサーバー
// ================================================================
// シンプルなREST API。プレイヤーごとの自己ベスト（踏破フロア数）を
// 記録・取得するだけの最小構成。データはJSONファイルに保存する
// （本格運用で書き込みが増えてきたら、SQLite等への切り替えも検討）。

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const DATA_FILE = path.join(__dirname, 'rankings.json');

// ================================================================
//  シード（ダミー）ランキング
// ================================================================
// リリース直後、本当に誰もランキングに登録していない状態だと寂しく見えるので、
// 「たたき台」として何人か架空のプレイヤーを最初から登録しておく。
// playerIdには本物のプレイヤーID（アプリ側でランダム生成）と絶対に被らないよう
// "seed-" という接頭辞を付けてあるので、実プレイヤーのデータと混同する心配はない。
// 無能力（ability: 'none'）で登録している数人は、アプリ側の「無能力縛りは金枠になる」
// 表示のサンプルも兼ねている。
// bestFloorは10F〜200Fの間でばらつかせてある（強すぎるとリリース直後の見栄えとして
// 不自然なので、ほどよく現実的な範囲にとどめている）。levelはおまけ表示なので厳密でなくてよい。
const SEED_RANKINGS = {
  'seed-01': { name: '灰色の狼',       bestFloor: 195, ability: 'none',    level: 40, nameColor: 'gold',   updatedAt: 0 },
  'seed-02': { name: '月見うさぎ',     bestFloor: 175, ability: 'shotgun', level: 36, nameColor: 'blue',   updatedAt: 0 },
  'seed-03': { name: '鉄壁太郎',       bestFloor: 150, ability: 'barrier', level: 31, nameColor: 'white',  updatedAt: 0 },
  'seed-04': { name: '無音の探索者',   bestFloor: 130, ability: 'none',    level: 27, nameColor: 'silver', updatedAt: 0 },
  'seed-05': { name: 'コーヒー中毒',   bestFloor: 112, ability: 'shotgun', level: 23, nameColor: 'white',  updatedAt: 0 },
  'seed-06': { name: '夜更かし勢',     bestFloor: 96,  ability: 'barrier', level: 20, nameColor: 'purple', updatedAt: 0 },
  'seed-07': { name: 'そらまめ',       bestFloor: 80,  ability: 'none',    level: 17, nameColor: 'green',  updatedAt: 0 },
  'seed-08': { name: 'ぴよ次郎',       bestFloor: 65,  ability: 'shotgun', level: 14, nameColor: 'white',  updatedAt: 0 },
  'seed-09': { name: '静かな刃',       bestFloor: 50,  ability: 'none',    level: 11, nameColor: 'white',  updatedAt: 0 },
  'seed-10': { name: 'たぬきの皮算用', bestFloor: 38,  ability: 'barrier', level: 9,  nameColor: 'yellow', updatedAt: 0 },
  'seed-11': { name: '初心者卒業',     bestFloor: 24,  ability: 'shotgun', level: 6,  nameColor: 'white',  updatedAt: 0 },
  'seed-12': { name: '駆け出し冒険者', bestFloor: 12,  ability: 'none',    level: 3,  nameColor: 'white',  updatedAt: 0 },
};

// データファイルが存在しない場合（初回起動、または無料プランのファイルシステムが
// リセットされた直後）は、上のシードデータで初期化する。一度でも実プレイヤーの
// スコアが送信されてファイルができれば、以降はそのファイルがそのまま使われるので、
// シードで実データが上書きされることはない。
function loadRankings() {
  if (!fs.existsSync(DATA_FILE)) {
    saveRankings(SEED_RANKINGS);
    return JSON.parse(JSON.stringify(SEED_RANKINGS));
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveRankings(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// { playerId: { name, bestFloor, ability, level, nameColor, updatedAt } } という形で保存する。
// playerId はアプリ側で端末ごとに生成するランダムなID（ログイン機能はない）。
// ability: 使用した特殊能力のID（例: 'shotgun'等）。未使用ならnull。
// level: プレイヤーレベル（1〜3000）。アプリ側のデイリークリアで上がっていく。
// nameColor: プロフィール画面で選んだ名前の表示色ID（例: 'white','gold'等）。
// ※ level・nameColorは「自己ベストを出した時の状態」ではなく「プレイヤーの今の状態」を表すものなので、
//   自己ベストが更新されたかどうかに関わらず、スコア送信のたびに常に最新の値へ更新する。
const PLAYER_LEVEL_CAP = 3000;
const VALID_NAME_COLORS = ['white', 'blue', 'yellow', 'purple', 'green', 'red', 'silver', 'gold', 'rainbow'];

// 1フロアあたり、現実的にありえる最短時間（秒）。アプリ側は「累計プレイ時間」を
// elapsedSecondsとして送ってくる（1回のプレイだけでなく、過去の失敗・やり直し分も
// 含めた合計値）。bestFloorに対してこの最低ラインを大きく下回る申告は、チートや
// 改ざんの可能性が高いとみなして拒否する。速いプレイヤーを誤って弾かないよう、
// あくまで「明らかにおかしい」ものだけを弾くゆるめの閾値にしてある。
const MIN_SECONDS_PER_FLOOR = 1.5;

// スコアを登録・更新する。既存の記録より低い場合は更新しない
// （＝自己ベストだけが常に保存される）。level・nameColorは自己ベストの更新有無に関わらず常に最新化する。
app.post('/api/scores', (req, res) => {
  const { playerId, name, bestFloor, ability, level, nameColor, elapsedSeconds } = req.body;

  if (typeof playerId !== 'string' || playerId.length < 1 || playerId.length > 64) {
    return res.status(400).json({ error: 'invalid playerId' });
  }
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 20) {
    return res.status(400).json({ error: 'invalid name' });
  }
  if (!Number.isInteger(bestFloor) || bestFloor < 1 || bestFloor > 100000) {
    return res.status(400).json({ error: 'invalid bestFloor' });
  }
  // elapsedSecondsは新しいアプリだけが送ってくる想定のフィールド。古いアプリからの
  // リクエストにも対応できるよう、送られてきた時だけ検証する（必須にはしない）。
  if (elapsedSeconds !== null && elapsedSeconds !== undefined) {
    if (typeof elapsedSeconds !== 'number' || !Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
      return res.status(400).json({ error: 'invalid elapsedSeconds' });
    }
    if (elapsedSeconds < bestFloor * MIN_SECONDS_PER_FLOOR) {
      console.log(`⚠️ 不自然に速いスコア申告を拒否: playerId=${playerId}, bestFloor=${bestFloor}, elapsedSeconds=${elapsedSeconds}`);
      return res.status(400).json({ error: 'implausible elapsedSeconds for bestFloor' });
    }
  }
  // ability は現状 null 固定だが、将来のために「null または 32文字以内の文字列」を許容しておく
  if (ability !== null && ability !== undefined && (typeof ability !== 'string' || ability.length > 32)) {
    return res.status(400).json({ error: 'invalid ability' });
  }
  // level・nameColorは未対応の古いアプリからのリクエストも許容するため、無ければデフォルト値にフォールバックする
  let safeLevel = 1;
  if (level !== null && level !== undefined) {
    if (!Number.isInteger(level) || level < 1 || level > PLAYER_LEVEL_CAP) {
      return res.status(400).json({ error: 'invalid level' });
    }
    safeLevel = level;
  }
  let safeNameColor = 'white';
  if (nameColor !== null && nameColor !== undefined) {
    if (typeof nameColor !== 'string' || !VALID_NAME_COLORS.includes(nameColor)) {
      return res.status(400).json({ error: 'invalid nameColor' });
    }
    safeNameColor = nameColor;
  }

  const rankings = loadRankings();
  const existing = rankings[playerId];

  if (!existing || bestFloor > existing.bestFloor || name !== existing.name) {
    rankings[playerId] = {
      name: name.trim().slice(0, 20),
      bestFloor: existing && existing.bestFloor > bestFloor ? existing.bestFloor : bestFloor,
      // 自己ベストを更新した時だけ、その時使っていた能力に差し替える
      ability: (!existing || bestFloor > existing.bestFloor) ? (ability || null) : (existing.ability || null),
      level: safeLevel,
      nameColor: safeNameColor,
      updatedAt: Date.now(),
    };
    saveRankings(rankings);
  } else if (existing.level !== safeLevel || existing.nameColor !== safeNameColor) {
    // 自己ベストは更新されなかったが、レベル・名前の色だけは常に最新化しておく
    // （プロフィール画面で色を変えた／デイリーでレベルが上がった時に、次の送信ですぐ反映されるように）
    existing.level = safeLevel;
    existing.nameColor = safeNameColor;
    existing.updatedAt = Date.now();
    saveRankings(rankings);
  }

  res.json({ ok: true, best: rankings[playerId].bestFloor });
});

// ================================================================
//  ランキングの並び順・順位付け（共通ロジック）
// ================================================================
// 同じ階数で並んだ場合は、無能力（ability: 'none'）で登った人を上位にする
// （能力に頼らず登った方が「格上」という扱い）。それでも決まらない場合は
// playerIdで固定し、同じ状態なら毎回同じ順番になるようにする。
function compareRankingEntries(a, b) {
  if (b.bestFloor !== a.bestFloor) return b.bestFloor - a.bestFloor;
  const aNone = a.ability === 'none' ? 0 : 1;
  const bNone = b.ability === 'none' ? 0 : 1;
  if (aNone !== bNone) return aNone - bNone;
  return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
}

// rankingsオブジェクト（{playerId: {...}}）から、必要なら能力IDで絞り込んだ上で、
// 順位（1位から始まる連番、rankフィールド）付きの配列にして返す。
// TOP50・無能力・自分の順位、どのタブも最終的にこの1つの並び順を元にしているので、
// 「同じ階数なら無能力が上」のルールが全タブで一貫する。
function getRankedList(rankings, { ability } = {}) {
  let list = Object.entries(rankings).map(([playerId, r]) => ({
    playerId,
    name: r.name,
    bestFloor: r.bestFloor,
    ability: r.ability || null,
    level: r.level || null,
    nameColor: r.nameColor || null,
  }));
  if (ability) list = list.filter((r) => r.ability === ability);
  list.sort(compareRankingEntries);
  list.forEach((r, i) => { r.rank = i + 1; });
  return list;
}

// ランキング一覧を取得する（自己ベストの高い順、デフォルト上位100件まで）。
// ?limit=50 で件数を絞れる（TOP50タブ用）。?ability=none のように能力IDで
// 絞り込むこともできる（無能力タブ用）。どちらも省略時は今まで通りの全体ランキング。
app.get('/api/rankings', (req, res) => {
  const rankings = loadRankings();
  const abilityFilter = typeof req.query.ability === 'string' ? req.query.ability : null;
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isInteger(limit) || limit < 1) limit = 100;
  limit = Math.min(limit, 200); // 念のための上限

  const list = getRankedList(rankings, { ability: abilityFilter });
  res.json({ rankings: list.slice(0, limit), total: list.length });
});

// 指定したプレイヤーを中心に、その前後25人ずつ（自分含めて最大51人）を返す（自分の順位タブ用）。
// 自分が1位の場合は上に誰もいないので、その分は単純に下側の枠が広がる（詰めない）。
// まだそのプレイヤーの記録がサーバーに無い場合は404を返す。
const RANKING_AROUND_SPAN = 25;
app.get('/api/rankings/around/:playerId', (req, res) => {
  const { playerId } = req.params;
  if (typeof playerId !== 'string' || playerId.length < 1 || playerId.length > 64) {
    return res.status(400).json({ error: 'invalid playerId' });
  }

  const rankings = loadRankings();
  const list = getRankedList(rankings); // 自分の順位タブは能力での絞り込みなし＝全体の中での順位
  const idx = list.findIndex((r) => r.playerId === playerId);
  if (idx === -1) {
    return res.status(404).json({ error: 'player not found' });
  }

  const start = Math.max(0, idx - RANKING_AROUND_SPAN);
  const end = Math.min(list.length, idx + RANKING_AROUND_SPAN + 1);
  res.json({ rankings: list.slice(start, end), myRank: idx + 1, total: list.length });
});

// 指定したプレイヤーの記録を削除する（アプリ側の「データ削除」と連動させるため）
app.delete('/api/scores/:playerId', (req, res) => {
  const { playerId } = req.params;
  if (typeof playerId !== 'string' || playerId.length < 1 || playerId.length > 64) {
    return res.status(400).json({ error: 'invalid playerId' });
  }

  const rankings = loadRankings();
  if (rankings[playerId]) {
    delete rankings[playerId];
    saveRankings(rankings);
  }

  res.json({ ok: true });
});

app.get('/', (req, res) => {
  res.send('MINE SWEEPER 極 - Tower Ranking API is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ Ranking server running on port ${PORT}`);
});
