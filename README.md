# Interactive Music Format — IAM (`.iam.wasm`)

**IAM (Interactive Audio Module)** は、wav / mp3 / m4a と並ぶ「再生できる音声ファイル」でありながら、
**インタラクティブな音楽**を収められる新しいフォーマットです。

```txt
従来の音声ファイル = 波形データ
.iam.wasm         = 波形データ + 再生エンジン + Cue ロジック + RTPC インタフェース
```

ファイルの実体は**単体で完結した WebAssembly バイナリ**。Wwise の SoundBank に近い中身を持ちながら、
WASM が動く場所（ブラウザ / Node.js / ゲームエンジン / 組み込み）なら**どこでも同じロジックで再生**できます。

- 🎚 **RTPC**: 天気・戦闘の激しさ・歩く速さなどをホストが渡すと、音楽が小節頭で美しく遷移
- 🔀 **分岐**: 聴くたびに変わる音楽（重み付きランダム遷移、シード制御可）
- 🔁 **ループ＋終止**: ループ前提の曲を「ボタンを押すと終わり始めて、音楽的に終わる」
- ⏩ **ホストからの無茶**: 再生速度変更・逆再生・フリーズ・シークも仕様として定義済み

このリポジトリには **仕様・再生エンジン・Web DAW・プレイヤーライブラリ・デモ**のすべてが含まれます。

## 試す

```bash
npm install
npm run dev        # Web DAW (IAM Studio) を起動 → http://localhost:5173
```

DAW は初回起動時に合成音のデモプロジェクト（Adventure Demo）を読み込みます。
**▶ Build & Play** で試聴し、右の RTPC スライダ（intensity / is_battle / weather）を動かすと
音楽がリアルタイムに遷移します。**Export .iam.wasm** で単一ファイルに書き出せます。

```bash
npm test           # エンジン+フォーマットのエンドツーエンドテスト (Node)
npm run demo       # examples/out/adventure_demo.iam.wasm を生成+オフライン検証
npx serve .        # → /examples/demo-host/ で「ゲーム側」を模した最小プレイヤー
```

## ホストからの利用（3行で鳴る）

```ts
import { IamPlayer } from '@iam/player';

const music = await IamPlayer.load('adventure_demo.iam.wasm', audioCtx);
music.node.connect(audioCtx.destination);
music.play();

// あとはゲーム状態を流し込むだけ
music.setRtpc('is_battle', true);
music.setRtpc('intensity', 0.8);
music.triggerCue('to_ending');   // ループ曲を音楽的に終わらせる
music.setRate(-1);               // 逆再生だってできる
```

ブラウザ以外（Unity / Unreal / Rust 等）は、各言語の WASM ランタイムで
[WASM ABI](./docs/04_host_api_spec.md) を直接呼び出します（import 不要・WASI 不要）。

## アーキテクチャ

```txt
┌─ オーサリング ──────────────┐      ┌─ 配布物 ───────────────────┐
│ Web DAW (apps/daw)          │      │ music.iam.wasm             │
│  Section / Track / Item     │      │ ├ engine.wasm (再生エンジン)│
│  Anchor / RTPC / Cue        │ ───▶ │ └ custom section "iam.pack"│
│  条件式 → Cue VM bytecode   │ export│    ├ 楽曲構造 (SECT/RTPC…) │
│  ブラウザ内で完結 (rustc不要)│      │    ├ Cue bytecode (CUES)   │
└─────────────────────────────┘      │    └ 音声バンク (ABNK)     │
                                     └────────────────────────────┘
```

- **エンジン** (`engine/`, Rust → `runtime/engine.wasm`, 97KB, 依存ゼロ・import ゼロ)
  境界駆動スケジューラによりサンプル精度で遷移・ループ・トリガを処理
- **Cue VM**: ロジックは安全なスタックマシンのバイトコード。共有ファイルを開いても任意コード実行は構造的に不可能
- **DAW のプレビュー＝エクスポートと同一エンジン**（同じ wasm を AudioWorklet で実行）
- `.iam.wasm` には DAW プロジェクト(META)も埋め込まれるため、**ファイル自体を再編集できる**

## 仕様書

| ドキュメント | 内容 |
|---|---|
| [docs/00_overview.md](./docs/00_overview.md) | フォーマット概要・設計思想 |
| [docs/01_iam_container_spec.md](./docs/01_iam_container_spec.md) | `.iam.wasm` コンテナ仕様 |
| [docs/02_iam_pack_spec.md](./docs/02_iam_pack_spec.md) | IAMP バイナリレイアウト (normative) |
| [docs/03_cue_vm_spec.md](./docs/03_cue_vm_spec.md) | Cue VM / 条件式言語 |
| [docs/04_host_api_spec.md](./docs/04_host_api_spec.md) | WASM ABI / JS プレイヤー API |
| [docs/05_runtime_behavior.md](./docs/05_runtime_behavior.md) | 再生セマンティクス（遷移・逆再生・上限） |

## 開発

```bash
# エンジンの再ビルド（要 Rust + wasm32-unknown-unknown target）
npm run build:engine

# TS パッケージ / DAW のビルド
npm run build

# テスト（パック往復・コンテナ・再生・遷移・逆再生・終止…）
npm test
```

ビルド済み `runtime/engine.wasm` をコミットしているため、**Rust なしでも** DAW・テスト・デモは動きます。

### 動作環境

- **Windows / macOS / Linux** いずれも Node.js 20+ と npm があれば動作します
  （npm スクリプトはシェル非依存。エンジン再ビルド時のみ Rust + `rustup target add wasm32-unknown-unknown` が必要）。
- DAW・プレイヤーは AudioWorklet 対応ブラウザ（Chrome / Edge / Firefox / Safari の現行版）で動作します。
- `.iam.wasm` の再生自体は OS 非依存です（WASM ランタイムがあればどこでも）。

## License

MIT
