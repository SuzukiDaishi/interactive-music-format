# 06. WCLAP プラグイン・MIDI トラック・横遷移ブリッジ (v2) / 生成系ホスティング (v3)

IAM v2 で追加された 3 機能の設計と動作。参照実装:
データモデル `packages/iam-pack/src/model.ts`、エンコーダ/デコーダ
`packages/iam-pack/src/{encode,decode}.ts`、エンジン `engine/src/{pack,runtime}.rs`、
JS ホスト `packages/iam-player/src/wclap/*`、AudioWorklet `packages/iam-player/src/worklet.ts`。

## 1. 全体アーキテクチャ

```
        Rust エンジン (.iam.wasm)                JS プレイヤー (AudioWorklet)
  ┌──────────────────────────────┐        ┌──────────────────────────────┐
  │ シーケンサ + クロック + 境界  │        │ WCLAP ホスト (worklet 内)     │
  │  ・audio トラック → PCM ミックス├───────▶│  + エンジン PCM ミックス      │
  │  ・instrument トラック → MIDI  │        │ MIDI → WCLAP 楽器プラグイン   │
  │    イベント (iam_poll_midi)    ├───────▶│  → プラグインバス             │
  │  ・bridge 遷移 (A→bridge→B)    │        │  → マスター WCLAP エフェクト  │
  └──────────────────────────────┘        └──────────────────────────────┘
```

**設計上の分担**: Rust エンジンは引き続きシーケンサ／クロック／PCM ミキサであり、
さらにサンプル精度の MIDI イベント列を出力する。WCLAP プラグイン（それ自体が
wasm32 の CLAP プラグイン）のホスティングは **JS/AudioWorklet 層**が担う。
これにより「単一 `.iam.wasm`」の思想を保ちつつ、純 WASM ランタイム（非 JS）では
PCM トラックのみ再生し、プラグイン/instrument トラックはスキップする
（グレースフルデグラデーション）。

## 2. WCLAP の内包方法

`.wclap` バンドルは `module.wasm`（CLAP プラグイン）+ `plugin.json`（マニフェスト、
複数プラグインを含みうる `plugins[]`）+ 任意の `ui/` を gzip+tar したもの。

- **埋め込み + URL フォールバック**（既定）: バイナリを `WCLP` チャンクに内包し
  自己完結を維持。未内包時は `url`（例: Plinken `shelf.json` の成果物）から取得。
- `WclapPlugin.embedded` が内包の有無、`url` がフォールバック先。
- 解決はオーディオスレッド外（メインスレッド / Node）で行う（`wclap/bundle.ts` の
  `gunzip` + `untar` + `loadWclapBundle`）。worklet には展開済みの `module.wasm`
  バイトとルーティングのみを渡す。

## 3. CLAP ホスト (`wclap/host.ts`)

worklet 内でも動く最小 CLAP ホスト。`module.wasm` は `clap_entry`（グローバル）、
共有 `memory`、`__indirect_function_table`、`malloc` をエクスポートする
（ホスト関数のインポートは持たない）。手順:

1. モジュールをインスタンス化し `_initialize()` を呼ぶ。
2. `clap_entry` → `init()` → `get_factory("clap.plugin-factory")` →
   `create_plugin(host, plugin_id)`。
3. `init` → `activate(sr, 1, maxFrames)` → `start_processing`。
4. ブロックごとに `process(clap_process)`。ノート/パラメータは CLAP 入力イベント列
   （`clap_event_note` / `clap_event_param_value`）として `time = frameOffset` 付きで渡す。

**ホストコールバック**: プラグインは `clap_host` / `clap_input_events` 等の関数ポインタを
`__indirect_function_table` 経由で `call_indirect` する。`WebAssembly.Function` が無い環境
でも動くよう、JS の host 関数へ転送する小さな **wasm トランポリン**を生成し、その
エクスポート関数をプラグインのテーブルに `table.set` する（`buildTrampolineModule`）。

`WclapRack`（`wclap/rack.ts`）が楽器インスタンスの総和とエフェクト鎖／マスター
エフェクトのミックスを担う。`worklet.ts` には同等の実装をインライン展開している
（AudioWorklet はモジュール import 不可のため）。プラグイン初期化や process が例外を
投げた場合は rack を無効化し、エンジン PCM のみにフォールバックする。

## 4. MIDI（instrument）トラック

- トラック `kind = 'instrument'`、`instrument` がプラグインインスタンス id、`notes` が
  ビートタイムライン上の MIDI ノート（`key 0..127`, `velocity 0..1`, `channel 0..15`）。
- エンジンはロード時に各 instrument トラックのノートを bank サンプル領域の
  note-on/off に展開し（`runtime.rs`）、`process()` 中に **サンプル精度**の MIDI イベントを
  リングへ積む。`fire_crossed` がチャンク内で跨いだノートを検出し、
  `frame_offset = ブロック先頭からのサンプル位置` を付与する。
- **前進再生のみ**ノートを発火（逆再生のノート on/off は音楽的に未定義のため）。
- セクション切替や `stop` 時には **All-Notes-Off**（broadcast）を送り、シンセのボイス
  ハングを防ぐ。

### `iam_poll_midi` レコード（16 バイト, LE）

| offset | 型 | 内容 |
|---|---|---|
| 0 | u32 | instance（`NONE_ID` = 全インストゥルメントへ broadcast） |
| 4 | u32 | frame_offset（process ブロック先頭からのサンプル） |
| 8 | u8 | status: 0=NoteOff, 1=NoteOn, 2=AllNotesOff |
| 9 | u8 | key (0..127) |
| 10 | u8 | channel |
| 11 | u8 | pad |
| 12 | f32 | velocity (0..1) |

ホストは `iam_process` の直後にキューが空になるまで `iam_poll_midi` を呼ぶ。
status=2 (AllNotesOff) は `instance = NONE_ID` なら全楽器へ、そうでなければ
そのインスタンスのみ（v3: gotoTrack の切替時に使用）。

## 5. 横遷移（bridge / トランジションセグメント）

`goto` / `gotoRandom` に任意の `bridge`（Section id）を追加。設定時、遷移は
**A → bridge → 目的地** の順に経由する。bridge はワンショット（ループ無効化）として
即時/小節頭などの解決タイミングで再生され、その**セクション終端**で本来の目的地への
遷移が自動的に予約・実行される（既存の pending 遷移 + section-end 機構を再利用）。
`SectionChanged` イベントは A→bridge と bridge→目的地の 2 回発火する。

- 実装: `runtime.rs` の `schedule_goto`（bridge 解決）と `execute_pending`
  （`then` による後続遷移の予約）。
- 無効な bridge id は直接遷移へデグレードする。
- 本 v2 では横遷移は**ブリッジセグメントのみ**を対象とする（sync マーカーや
  トランジションマトリクスは将来拡張）。

## 6. 検証規則（追加分, `validateProject`）

- instrument トラックは存在するプラグインインスタンスを参照し、audio item を持たない。
- `PluginInstance.pluginBankId` / `effects` / `masterEffects` の参照先が存在する。
- `goto.bridge`（設定時）が存在する Section を指す。
- ノートの `key ∈ 0..127`, `velocity ∈ 0..1`, `lengthBeats > 0`。
- 埋め込み指定のプラグインはバイナリ供給か `url` を持つ。

## 7. 例 / テスト

- `examples/wclap-demo.mjs`: 実 WCLAP シンセ + リミッタを**内包**した自己完結
  `.iam.wasm` を生成し、instrument トラック + bridge 遷移をオフラインで描画。
- `tests/wclap-host.test.mjs`: 実バンドルのロードとシンセ/エフェクトの描画。
- `tests/wclap-integration.test.mjs`: エンジン MIDI → rack の可聴ミックス、ルーティング。
- `tests/wclap-midi.test.mjs`: ラウンドトリップ、検証、サンプル精度 MIDI、bridge 遷移。

## 8. 生成系 WCLAP ホスティング (v3)

ジェネレーティブミュージックは**プラグイン側**が担い、ホストは以下を提供する
（`wclap/host.ts` / `wclap/rack.ts`、worklet.ts にインライン複製あり）:

### 8.1 CLAP トランスポート

各インスタンスの `clap_process.transport` に 104 バイトの
`clap_event_transport` を常設し、毎ブロック BPM / 拍位置（`CLAP_BEATTIME_FACTOR
= 2^31` の固定小数）/ 小節頭 / 拍子 / 再生状態を書き込む。エンジンの
`iam_get_bpm` / `iam_get_position_beats` / `iam_get_beats_per_bar` /
`iam_is_playing` が情報源。ジェネレータはこれでグリッドに同期できる。

### 8.2 ノート出力の捕捉 (`out_events`)

`clap_output_events.try_push` ホストコールバックが、プラグインが push した
イベントを**コールバック中にコピー**する（サイズ 12..64 の境界検査、CLAP コア
スペースの NOTE_ON/NOTE_OFF のみ解釈、その他は受領して破棄）。捕捉ノートは
`WclapInstance.takeOutputNotes()` で取り出す。

### 8.3 ルーティング（NSRC / PMOD）

rack のブロック処理順:

```
transport 書込 → PMOD (RTPC をカーブ変換し変化時のみ PARAM_VALUE 送出)
→ ジェネレータ process（音声破棄・ノート捕捉→ターゲット楽器へ同ブロック転送）
→ 楽器 + インサート → マスターエフェクト
```

- `NSRC` のターゲットがどのトラックからも参照されていない場合も自動的に
  楽器サムに加わる（生成ノートだけで発音する使い方）。
- Cue の `setPluginParam`（イベント type 9）は worklet のイベントドレインで
  rack に適用される（次ブロックから有効）。
- ジェネレータの例外は rack 全体のフォールバック（エンジン PCM のみ）で吸収。

### 8.4 テスト

`tests/wclap-generative.test.mjs` はテスト内で最小の CLAP プラグイン wasm を
手組みし（`buildTrampolineModule` と同じ手法）、ノート捕捉と
「ジェネレータ → 実シンセ」ルーティングの可聴性を検証する。
