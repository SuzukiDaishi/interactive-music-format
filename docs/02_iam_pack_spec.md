# 02. IAMP データパック バイナリ仕様 v1 (normative)

`.iam.wasm` のカスタムセクション `iam.pack` に格納されるデータ本体のレイアウト。
参照実装: エンコーダ `packages/iam-pack/src/encode.ts` / デコーダ `engine/src/pack.rs`。

## 0. 記法・共通規則

- すべて **リトルエンディアン**。
- `u8 / u16 / u32 / f32` は固定長。`f32` は IEEE 754 binary32。
- `str` = `u16 length` + UTF-8 バイト列（長さにヌル終端は含まない。最大 65535 バイト）。
- **ID**: 各オブジェクト（Section / Track / Anchor / RTPC / Cue / Asset）は `u32` の ID を持つ。
  ID はカテゴリ内で一意であれば良い（連番である必要はない）。
  `0xFFFFFFFF` (`NONE_ID`) は「なし / 任意」を表す予約値。
- 各「個数」フィールドは最大 **65536**。超える値を持つパックは不正。
- パース時、未知のチャンク ID は**スキップして無視**しなければならない (MUST ignore)。

## 1. 全体構造

```txt
┌──────────────────────────────┐
│ magic   u8[4]  = "IAMP"      │
│ version u32    = 1           │
│ chunk_count u32              │
├─ chunk × chunk_count ────────┤
│  id      u8[4]   (ASCII)     │
│  length  u32     (payload長) │
│  payload u8[length]          │
│  padding u8[(4-length%4)%4]  │  ← 各チャンクは4バイト境界に整列
└──────────────────────────────┘
```

### チャンク一覧

| ID | 内容 | 必須 |
|---|---|---|
| `PROJ` | プロジェクトヘッダ | **必須** |
| `RTPC` | RTPC 定義 | 任意（省略 = 0個） |
| `SECT` | Section / Track / Item / Anchor | 任意 |
| `CUES` | Cue（ルール+アクション）と Trigger Binding | 任意 |
| `ABNK` | オーディオバンク | 任意 |
| `META` | ツール用 JSON（DAW プロジェクト再編集用） | 任意 |

同一 ID のチャンクが複数ある場合の動作は未定義（エンコーダは 1 つずつ出力すること）。

## 2. `PROJ` — プロジェクトヘッダ

| 型 | フィールド | 意味 |
|---|---|---|
| str | name | モジュール名 |
| u32 | bank_sample_rate | 拍⇔サンプル換算とバンク基準のサンプルレート (>0) |
| f32 | bpm | プロジェクト既定 BPM (>0) |
| u8 | tsig_num | 拍子分子 (>0) |
| u8 | tsig_den | 拍子分母 (>0) |
| u16 | reserved | 0 |
| u32 | start_section | `iam_play()` で開始する Section ID（`NONE_ID` = なし） |

## 3. `RTPC`

```txt
u32 count
count × {
  u32 id
  str name
  u8  type          0=f32, 1=bool, 2=enum
  u8  pad
  u16 variant_count  (enum 以外は 0)
  variant_count × str variant_name
  f32 default
  f32 min
  f32 max            (min >= max のとき範囲クランプ無効)
  f32 smoothing_ms   (0 = 平滑化なし。§05 参照)
}
```

bool は 0/1、enum は variant インデックス (0 起点) を f32 値として扱う。

## 4. `SECT`

```txt
u32 section_count
section_count × {
  u32 id
  str name
  f32 bpm               (0 = プロジェクト BPM を継承)
  u8  tsig_num          (0 = 継承)
  u8  tsig_den          (0 = 継承)
  u8  loop_enabled      (0/1)
  u8  pad
  f32 length_beats      (>0)
  f32 loop_start_beats  (ループ折り返し先。通常 0)
  u32 track_count
  track_count × {
    u32 id
    str name
    f32 volume          (リニアゲイン)
    f32 pan             (-1=L .. +1=R)
    u8  muted           (0/1)
    u8[3] pad
    u32 item_count
    item_count × {                 ← 固定 32 バイト
      u32 id
      u32 asset_id
      f32 start_beat               (Section ローカル)
      f32 length_beats
      f32 offset_beats             (アセット内の読み出し開始位置)
      f32 gain
      f32 fade_in_beats
      f32 fade_out_beats
    }
  }
  u32 anchor_count
  anchor_count × { u32 id, str name, f32 beat }
}
```

## 5. `CUES`

```txt
u32 cue_count
cue_count × {
  u32 id
  str name
  u32 rule_count
  rule_count × {
    u16 condition_length
    u8[condition_length] condition   ← Cue VM バイトコード（空 = 常に真）
    u8  action_count
    u8  stop_if_matched              (1 = このルールが成立したら以降のルールを評価しない)
    action_count × action            (下表)
  }
}
u32 binding_count
binding_count × {
  u8  trigger_type
  u8[3] pad
  payload                            (型ごとに下表)
  u32 cue_id
}
```

### アクション（先頭 1 バイトが opcode）

| op | 名前 | ペイロード |
|---|---|---|
| 0x01 | `goto` | u32 section, u32 anchor(`NONE_ID`=先頭), u8 timing, u8 crossfade(0/1), u16 pad, f32 fade_ms |
| 0x02 | `play` | u32 section, u32 anchor — 即時ハードスイッチ |
| 0x03 | `stop` | u8 timing, u8[3] pad, f32 fade_ms |
| 0x04 | `setTrackGain` | u32 section, u32 track, f32 gain, f32 fade_ms |
| 0x05 | `setLoop` | u32 section, u8 enabled, u8[3] pad |
| 0x06 | `emit` | u32 code — ホストへ任意イベント通知 |
| 0x07 | `setRtpc` | u32 rtpc, f32 value（RTPC トリガを再帰発火。深さ上限 8） |
| 0x08 | `oneShot` | u32 asset, f32 gain, u8 timing, u8[3] pad — スティンガー再生 |
| 0x09 | `gotoRandom` | u8 target_count, u8 timing, u8 crossfade, u8 pad, f32 fade_ms, target_count × { u32 section, u32 anchor, f32 weight } — 重み付き抽選 goto |

### timing 列挙

| 値 | 名前 | 意味 |
|---|---|---|
| 0 | immediate | 即時（次の処理境界） |
| 1 | nextBeat | 次の拍頭 |
| 2 | nextBar | 次の小節頭 |
| 3 | sectionEnd | Section 終端（逆再生中は位置 0） |

### trigger_type とペイロード

| 値 | 名前 | ペイロード |
|---|---|---|
| 1 | rtpcChanged | u32 rtpc_id |
| 2 | sectionStart | u32 section_id (`NONE_ID` = 任意) |
| 3 | sectionEnd | u32 section_id (`NONE_ID` = 任意) |
| 4 | anchorReached | u32 section_id, u32 anchor_id |
| 5 | bar | u32 section_id (`NONE_ID` = 任意) — 小節線通過ごと |
| 6 | beat | u32 section_id (`NONE_ID` = 任意) — 拍線通過ごと |
| 7 | moduleStart | （なし）— `iam_play()` 時 |

「手動 Cue」は Binding を持たず、ホストが `iam_trigger_cue(cue_id)` で直接発火する。

## 6. `ABNK` — オーディオバンク

```txt
u32 asset_count
asset_count × {
  u32 id
  str name
  u8  format        0=pcm16 (i16), 1=f32
  u8  channels      1 または 2（インターリーブ）
  u16 pad
  u32 sample_rate
  u32 frames
  u8[frames × channels × (2|4)] data
  u8[(4 - data_bytes % 4) % 4] padding   ← データ長基準の4バイト整列
}
```

- pcm16 は `value / 32768.0` で f32 へ変換される。
- `sample_rate` は `bank_sample_rate` と異なってもよい（再生時に線形補間でレート変換）。
  ただしオーサリングツールはバンクレートへ揃えて格納することを推奨。

## 7. `META` — ツールメタデータ（任意）

ペイロードは UTF-8 JSON。トップレベルは `{ "project": <IamProject> }`。
`IamProject` は `packages/iam-pack/src/model.ts` の構造（Cue 条件は**式のソース文字列**を保持）。

- エンジンは META を**読まない**。
- DAW は META があれば `.iam.wasm` をプロジェクトとして再編集できる
  （音声は ABNK から復元）。配布時にサイズ・秘匿の必要があれば META を省略してよい。

## 8. 検証規則

ローダは以下を検証し、違反するパックを拒否しなければならない (MUST)。

- magic / version / チャンク境界の整合
- `PROJ` の存在、`bank_sample_rate > 0`, `bpm > 0`, 拍子 ≠ 0
- Section `length_beats > 0`
- Item の `asset_id` が ABNK に存在すること
- Binding の `cue_id` / 参照 Section / Anchor / RTPC が存在すること
- `start_section` が存在する Section か `NONE_ID` であること
- ABNK の `channels ∈ {1,2}`, `sample_rate > 0`, format ∈ {0,1}

エンジンのエラーコードは [04_host_api_spec.md](./04_host_api_spec.md) §`iam_load_pack` を参照。
