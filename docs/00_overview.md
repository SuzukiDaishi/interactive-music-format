# IAM — Interactive Audio Module フォーマット概要

**IAM (Interactive Audio Module)** は、`wav` / `mp3` / `m4a` のような「再生できる音声ファイル」でありながら、
中に **再生ロジック** を持つインタラクティブ音楽フォーマットです。

```txt
従来の音声ファイル        = 波形データ
Interactive Audio Module = 波形データ + 再生エンジン + Cue ロジック + RTPC インタフェース
```

ファイルの実体は **単体で完結した WebAssembly バイナリ** です。

```txt
adventure_demo.iam.wasm
```

WASM が動く環境（ブラウザ / Node.js / Unity / Unreal / 組み込み wasmtime など）であれば、
どこでも同じロジック・同じ音で再生できます。Wwise / FMOD の Music System が行うような
状態遷移型の音楽再生を、**単一ファイル・ランタイム非依存** で配布できることが特徴です。

## できること

| ユースケース | 仕組み |
|---|---|
| 天気や戦闘状況で変化する音楽 | ホストが RTPC (`weather`, `intensity` など) を渡す → Cue が小節頭でセクション遷移・トラック音量変更 |
| 歩くテンポで変わる音楽 | RTPC + `iam_set_rate()`（再生速度。負値で逆再生） |
| 聴くたびに分岐する音楽 | Cue 条件式の `rand` / `gotoRandom` アクション（シードはホストが `iam_set_seed()` で制御可能） |
| ループ前提で「ボタンを押すと終わり始めて終わる」音楽 | ホストが手動 Cue を発火 → `goto(Outro, timing=sectionEnd)` → 非ループの Outro が鳴り終わって `ended` イベント |

## ファイル種別

| 拡張子 | 役割 |
|---|---|
| `.iam.wasm` | 配布用 Interactive Audio Module（**正規フォーマット**。有効な WASM バイナリ） |
| `engine.wasm` | ビルド済み共通再生エンジン（`.iam.wasm` の土台。単体では音は出ない） |
| IAMP パック | `.iam.wasm` 内のカスタムセクションに格納されるデータ本体（楽曲構造 + 音声バンク + Cue） |

`.iam.wasm` = `engine.wasm` + WASM カスタムセクション `iam.pack`（IAMP バイナリ）という構造のため、
**エクスポートはバイト列の結合だけで完了**します。Rust コンパイラ等のツールチェーンは
オーサリング側にも再生側にも不要です（エンジン自体の開発時のみ必要）。

## データモデル

```txt
Module (= .iam.wasm)
 ├ RTPC        外部から渡されるリアルタイムパラメータ (f32 / bool / enum)
 ├ Section     独立再生可能な音楽単位（ローカルタイムライン、ループ可）
 │   ├ Track   レイヤー（volume / pan / mute）
 │   │   └ Item   音声素材の配置（beat 単位、gain / fade / offset）
 │   └ Anchor  Section 内の名前付き位置（遷移先・トリガ位置）
 ├ Cue         イベント駆動のルール集合（条件式 + アクション列）
 ├ Binding     トリガ（RTPC変更 / SectionEnd / Anchor通過 / 拍 / 小節 …）→ Cue の紐付け
 └ AudioBank   PCM 音声データ (pcm16 / f32)
```

- **Goto はアクション**であり、Cue の中から `goto(section.anchor, timing, transition)` として呼ばれます。
- Cue のロジックは**スタックマシン（Cue VM）のバイトコード**で表現され、エンジンが解釈実行します。
  任意コード実行は構造的に不可能で、共有されたファイルを開く・鳴らすことが安全です。

## リポジトリ構成

```txt
docs/        仕様書（このディレクトリ）
engine/      Rust 製再生エンジン → engine.wasm
runtime/     ビルド済み engine.wasm（コミット済み）
packages/
  iam-pack/    TS: IAMP エンコーダ/デコーダ・.iam.wasm コンテナ・式コンパイラ
  iam-player/  TS: ホスト用プレイヤー（AudioWorklet / Node 両対応）
apps/daw/    Web DAW「IAM Studio」（ブラウザだけで編集→試聴→エクスポート）
examples/    デモプロジェクト・最小ホスト実装
tests/       Node によるエンドツーエンドテスト
```

## 仕様書の読み順

1. [01_iam_container_spec.md](./01_iam_container_spec.md) — `.iam.wasm` コンテナ
2. [02_iam_pack_spec.md](./02_iam_pack_spec.md) — IAMP バイナリレイアウト（normative）
3. [03_cue_vm_spec.md](./03_cue_vm_spec.md) — Cue VM / 条件式言語
4. [04_host_api_spec.md](./04_host_api_spec.md) — WASM ABI と JS プレイヤー API
5. [05_runtime_behavior.md](./05_runtime_behavior.md) — 再生セマンティクス（遷移・ループ・逆再生など）

## バージョニング

- IAMP パック: 先頭ヘッダに `version (u32)`。本仕様は **version 1**。
- エンジン ABI: `iam_abi_version() -> u32`。本仕様は **1**。
- 未知のチャンク ID はエンジンに無視されます（前方互換のための拡張ポイント）。
