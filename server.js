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

function loadRankings() {
  if (!fs.existsSync(DATA_FILE)) return {};
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

// スコアを登録・更新する。既存の記録より低い場合は更新しない
// （＝自己ベストだけが常に保存される）。level・nameColorは自己ベストの更新有無に関わらず常に最新化する。
app.post('/api/scores', (req, res) => {
  const { playerId, name, bestFloor, ability, level, nameColor } = req.body;

  if (typeof playerId !== 'string' || playerId.length < 1 || playerId.length > 64) {
    return res.status(400).json({ error: 'invalid playerId' });
  }
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 20) {
    return res.status(400).json({ error: 'invalid name' });
  }
  if (!Number.isInteger(bestFloor) || bestFloor < 1 || bestFloor > 100000) {
    return res.status(400).json({ error: 'invalid bestFloor' });
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

// ランキング一覧を取得する（自己ベストの高い順、上位100件まで）
app.get('/api/rankings', (req, res) => {
  const rankings = loadRankings();
  const list = Object.entries(rankings)
    .map(([playerId, r]) => ({
      playerId,
      name: r.name,
      bestFloor: r.bestFloor,
      ability: r.ability || null,
      level: r.level || null,
      nameColor: r.nameColor || null,
    }))
    .sort((a, b) => b.bestFloor - a.bestFloor)
    .slice(0, 100);

  res.json({ rankings: list });
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
