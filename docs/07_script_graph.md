# 07. スクリプトグラフ (v3)

Cue パネルでの条件式テキスト + アクション行の手書きに代わる、**ノードベースの
ビジュアルスクリプティング**。グラフはオーサリングモデルとして META にのみ保存され、
エクスポート時に既存の Cue / Binding / Cue VM バイトコードへ**コンパイル**される。

- 配布フォーマットは v1/v2 から変わらず「データ + 安全な VM」。任意コード実行は
  構造的に不可能なまま、静的解析（遷移グラフ抽出）も可能。
- rustc などのツールチェーンは不要（ブラウザ内で完結）。
- 参照実装: モデル `packages/iam-pack/src/model.ts`（`ScriptGraph`）、
  コンパイラ `packages/iam-pack/src/graph.ts`（`compileGraphs`）、
  エディタ `apps/daw/src/components/ScriptGraphPanel.tsx`（React Flow）。

## 1. モデル

```ts
ScriptGraph { id, name, enabled?, nodes: GraphNode[], edges: GraphEdge[] }
GraphNode   { id: string, kind, x, y, data }
GraphEdge   { from, fromPort, to, toPort }
```

ポートは 2 種類:

- **exec ポート**: `out` / `then` / `else`（出力）→ `in`（入力）。実行の流れ。
- **値ポート**: `value`（出力）→ `a` / `b` / `cond` / `value` / `gain`（入力）。式の合成。

## 2. ノード種別

| 分類 | kind | data | 説明 |
|---|---|---|---|
| Trigger | `onModuleStart` | — | `iam_play()` 時 |
| | `onRtpcChanged` | `rtpc` | RTPC 変更時 |
| | `onBar` / `onBeat` | `section?` | 小節線 / 拍線通過ごと |
| | `onSectionStart` / `onSectionEnd` | `section?` | セクション開始 / 終端 |
| | `onAnchor` | `section, anchor` | アンカー通過 |
| | `onManualCue` | `name` | ホストの `triggerCue(name)` で発火（Binding なし） |
| Value | `rtpcValue` | `rtpc` | RTPC 値 |
| | `constant` | `value` | 定数 |
| | `sectionRef` | `section` | セクション ID 定数（比較用） |
| | `currentSection` / `positionBeats` / `random` | — | `section` / `beats` / `rand` |
| | `math` | `op: + - * /` | 二項演算 (`a`, `b`) |
| Logic | `compare` | `op: < <= > >= == !=` | 比較 (`a`, `b`) |
| | `and` / `or` / `not` | — | 論理 |
| Flow | `branch` | — | `cond` が真なら `then`、偽なら `else` |
| Action | `goto` | section, anchor?, timing, transition, fadeMs, bridge? | 横遷移 |
| | `gotoRandom` | targets[], timing, transition, fadeMs, bridge? | 重み付き分岐 |
| | `gotoTrack` | section, track, sourceSection?, sourceTrack?, timing, transition, fadeMs | **トラック単位遷移** |
| | `setTrackGain` | section, track, gain, fadeMs, timing + 値入力 `gain` | **縦遷移**（量子化可） |
| | `setLoop` / `setRtpc` / `setPluginParam` / `emit` / `oneShot` / `stop` | 各種 | `setRtpc`/`setPluginParam` は値入力 `value` を持つ |

## 3. コンパイル規則

- **トリガノード 1 つ = 生成 Cue 1 つ**（+ `onManualCue` 以外は Binding 1 つ）。
  生成 Cue の id は `0x40000000` から採番し、手書き Cue と衝突しない。
  `onManualCue` は `data.name` がそのまま Cue 名になる（`triggerCue('name')`）。
- トリガの `out` から exec 連鎖を**フロー順に平坦化**し、CueRule 列にする。
  アクションはルールの actions に順に積まれる。
- `branch` は連鎖を分岐する: 以降の各パスの条件は、通過した branch 条件の
  **論理積**（else 側は否定）。条件は式ソース文字列として合成され、既存の式
  コンパイラ（docs/03）で Cue VM バイトコードになる。
- アクションの値入力（`gain` / `value` ポート）に値サブグラフが接続されると、
  式に合成され v3 アクションの**値式スロット**（発火時評価）になる。
- `enabled: false` のグラフはコンパイルされない。配線されていないトリガは無視。

## 4. 例

「`intensity` が 0.5 以上になったら Battle へ、下回ったら Calm へ（小節頭）」:

```txt
[onRtpcChanged intensity] ─exec─▶ [branch] ─then─▶ [goto Battle nextBar]
[rtpcValue intensity] ─▶ a ┐        ▲ cond          └else─▶ [goto Calm nextBar]
[constant 0.5]        ─▶ b ┴ [compare >=] ─value────┘
```

コンパイル結果（概念）:

```txt
Cue "graph:...:trig" ← Binding rtpcChanged(intensity)
  rule 1: (intensity >= 0.5)  → goto Battle
  rule 2: !(intensity >= 0.5) → goto Calm
```

## 5. 制限

- exec / 値グラフの深さはそれぞれ 64 / 32 まで（循環はコンパイルエラー）。
- 値ポートへの入力は 1 本（後から繋ぐと置換）。exec はファンアウト / 合流可。
- ルール条件は同一発火内で**逐次評価**される: 先行ルールのアクション（setRtpc 等）は
  後続ルールの条件に影響し得る（`rand` も評価ごとに進む）。
